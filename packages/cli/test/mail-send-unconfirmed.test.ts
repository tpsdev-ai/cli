/**
 * mail-send-unconfirmed.test.ts — cli#962.
 *
 * A cross-host `tps mail send` waits for the branch's MSG_MAIL_ACK. When that
 * ACK does not arrive inside the window the delivery is UNCONFIRMED: the sender
 * reports its own message (which names the message id and says the message may
 * still arrive) and exits 75 (EX_TEMPFAIL), distinct from a refused or failed
 * delivery. The window is configurable with `--ack-timeout <ms>` and
 * `TPS_MAIL_ACK_TIMEOUT_MS`, default 30000, and a bad value is refused by name.
 *
 * The branch keys its inbox record by (branch, wire id), so a second delivery
 * with the same id and payload reuses the record and still ACKs accepted. These
 * tests drive the REAL WS/Noise transport and the branch acceptance path
 * (`deliverRelayedToLocal`); the one exception is the fault-injection test that
 * stubs `WsNoiseTransport.prototype.connect`.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import Noise from "noise-handshake/noise.js";
import Cipher from "noise-handshake/cipher.js";
import { generateKeyPair, registerBranch, saveKeyPair } from "../src/utils/identity.js";
import {
  DEFAULT_MAIL_ACK_TIMEOUT_MS,
  deliverRelayedToLocal,
  deliverToRemoteBranch,
  MailDeliveryUnconfirmedError,
  parseMailAckTimeoutMs,
  RemoteDeliveryTimeoutError,
  resolveMailAckTimeoutMs,
} from "../src/utils/relay.js";
import { WsNoiseTransport } from "../src/utils/ws-noise-transport.js";
import type { TransportChannel, TpsMessage } from "../src/utils/transport.js";
import { getInbox } from "../src/utils/mail.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER, type MailDeliverBody } from "../src/utils/wire-mail.js";
import { decodeWireMessage, encodeWireMessage } from "../src/utils/wire-frame.js";
import { writeKeyFile } from "./helpers/stub-flair.js";
import { readSentEnvelope, SENT_ENVELOPE_TTL_MS, storeSentEnvelope } from "../src/utils/sent-envelope.js";
import { signEnvelope, type Envelope, type FlairClient } from "@tpsdev-ai/agent";
import * as ed from "@noble/ed25519";

afterEach(() => {
  mock.restore();
});

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const PROLOGUE = Buffer.from("tps-v1");
const FLINT_SEED = Buffer.alloc(32, 0x02);

let root: string;
let branchKp: ReturnType<typeof generateKeyPair>;
let savedEnv: Record<string, string | undefined>;
let httpServer: ReturnType<typeof createServer> | null;
let wss: WebSocketServer | null;
let port: number;
/** Accepted sockets, so teardown can end them instead of waiting on them. */
let connections: Set<net.Socket>;

/** How long the branch may take to see a sender's connection end after a
 *  delivery settles, and how long each listener close may take. Both bounds are
 *  named so a stall fails with its own message instead of a hook timeout. */
const CONNECTION_END_DEADLINE_MS = 2_000;
const LISTENER_CLOSE_DEADLINE_MS = 1_500;

interface BranchBehavior {
  /** Wait this long before ACKing (the sender's window may be shorter). */
  ackDelayMs?: number;
  /** Wait this long before answering the Noise handshake (a slow connect). */
  handshakeDelayMs?: number;
  /** Never ACK: the sender's window must be what ends the wait. */
  noAck?: boolean;
  accepted?: boolean;
  error?: string;
  /** Run the real branch acceptance path before ACKing. */
  recordInbox?: boolean;
}

interface BranchServer {
  deliveries: MailDeliverBody[];
  acceptErrors: unknown[];
}

let branch: BranchServer;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") return reject(new Error("no addr"));
      const p = addr.port;
      s.close(() => resolvePort(p));
    });
    s.once("error", reject);
  });
}

async function startBranchServer(behavior: BranchBehavior): Promise<BranchServer> {
  branch = { deliveries: [], acceptErrors: [] };
  port = await freePort();
  httpServer = createServer();
  connections = new Set();
  httpServer.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  wss = new WebSocketServer({ server: httpServer, path: "/tps/wire" });

  wss.on("connection", (ws) => {
    const responder = new Noise("IK", false, {
      publicKey: Buffer.from(branchKp.encryption.publicKey),
      secretKey: Buffer.from(branchKp.encryption.privateKey),
    });
    responder.initialise(PROLOGUE);

    ws.on("message", async (data) => {
      try {
        const raw = Buffer.from(data as ArrayBuffer);
        if (!responder.rx) {
          responder.recv(raw);
          if (behavior.handshakeDelayMs) await sleep(behavior.handshakeDelayMs);
          ws.send(Buffer.from(responder.send()));
          return;
        }
        const msg = decodeWireMessage(Buffer.from(new Cipher(responder.rx).decrypt(raw)));
        if (msg.type !== MSG_MAIL_DELIVER) return;
        const body = msg.body as MailDeliverBody;
        branch.deliveries.push(body);
        // The real branch receiver sends NO ACK when acceptance refuses the
        // delivery (a same-id payload conflict), so the sender sees its own
        // window expire rather than an accepted ACK.
        let accepted = true;
        if (behavior.recordInbox) {
          try {
            deliverRelayedToLocal("remote-a", body);
          } catch (error) {
            branch.acceptErrors.push(error);
            accepted = false;
          }
        }
        if (behavior.noAck || !accepted) return;
        if (behavior.ackDelayMs) await sleep(behavior.ackDelayMs);
        const ack = {
          type: MSG_MAIL_ACK,
          seq: 0,
          ts: new Date().toISOString(),
          body: {
            id: body.id,
            accepted: behavior.accepted ?? true,
            ...(behavior.error ? { error: behavior.error } : {}),
          },
        };
        if (ws.readyState === 1) ws.send(Buffer.from(new Cipher(responder.tx).encrypt(encodeWireMessage(ack))));
      } catch {
        // The sender closed the channel (e.g. at its ACK-window deadline).
      }
    });
  });

  await new Promise<void>((done) => httpServer!.listen(port, "127.0.0.1", () => done()));
  return branch;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tps-mail-962-"));
  savedEnv = {};
  for (const key of ["HOME", "TPS_ROOT", "TPS_MAIL_DIR", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_MAIL_ACK_TIMEOUT_MS"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = root;
  process.env.TPS_ROOT = root;
  process.env.TPS_MAIL_DIR = join(root, "mail");
  process.env.TPS_IDENTITY_DIR = join(root, "identity");
  process.env.TPS_REGISTRY_DIR = join(root, "registry");
  process.env.TPS_VAULT_KEY = "mail-962-test";
  delete process.env.TPS_MAIL_ACK_TIMEOUT_MS;
  mkdirSync(process.env.TPS_IDENTITY_DIR, { recursive: true });
  mkdirSync(process.env.TPS_REGISTRY_DIR, { recursive: true });

  saveKeyPair(generateKeyPair(), process.env.TPS_IDENTITY_DIR, "host");
  branchKp = generateKeyPair();
  registerBranch("remote-a", branchKp.signing.publicKey, undefined, branchKp.encryption.publicKey);

  const branchDir = join(root, ".tps", "branch-office", "remote-a");
  mkdirSync(branchDir, { recursive: true });
  writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "127.0.0.1", port: 1, transport: "ws" }));
});

afterEach(async () => {
  const server = httpServer;
  const serverWss = wss;
  try {
    if (server) {
      // `http.Server.close()` calls back only after every accepted socket has
      // ended, and under Bun terminating the WebSocket side does not always
      // release the server's socket — so the hook used to hang until its own
      // timeout. End the accepted sockets and stop the WebSocket server first,
      // and bound each close so a stall reports itself here.
      for (const socket of connections) socket.destroy();
      connections.clear();
      server.closeAllConnections?.();
      if (serverWss) {
        await withinDeadline(
          "wss.close",
          new Promise<void>((done) => serverWss.close(() => done())),
        );
      }
      await withinDeadline(
        "httpServer.close",
        new Promise<void>((done) => server.close(() => done())),
      );
    }
  } finally {
    wss = null;
    httpServer = null;
    // Restored even when a close above stalled or threw: the env-leak preload
    // fails the whole file on a leftover TPS_* variable.
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/** Settle `op` or reject naming what hung, instead of letting a hook time out. */
function withinDeadline<T>(what: string, op: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not settle within ${LISTENER_CLOSE_DEADLINE_MS}ms`)),
      LISTENER_CLOSE_DEADLINE_MS,
    );
    op.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** After every outcome — success, unconfirmed, refused — the sender's channel
 *  must end the branch's connection; a path that left it open would keep the
 *  listener busy and fail here by name rather than as a teardown hang. */
async function expectConnectionEndedAfter(outcome: string): Promise<void> {
  const start = Date.now();
  while (connections.size > 0 && Date.now() - start < CONNECTION_END_DEADLINE_MS) await sleep(10);
  const clients = wss?.clients.size ?? 0;
  if (connections.size > 0 || clients > 0) {
    throw new Error(
      `after ${outcome}: the branch still had ${connections.size} open connection(s) and ${clients} client(s) ` +
        `${Date.now() - start}ms after the delivery settled (deadline ${CONNECTION_END_DEADLINE_MS}ms)`,
    );
  }
}

function pointRemoteAtServer(): void {
  writeFileSync(
    join(root, ".tps", "branch-office", "remote-a", "remote.json"),
    JSON.stringify({ host: "127.0.0.1", port, transport: "ws" }),
  );
}

function inboxRecords(agent = "local"): string[] {
  const inbox = getInbox(agent);
  return existsSync(inbox.fresh) ? readdirSync(inbox.fresh).filter((f) => f.endsWith(".json")) : [];
}

function sentEnvelopeFile(id: string): string {
  const key = createHash("sha256").update(id, "utf8").digest("hex");
  return join(root, "mail", ".sent-envelopes", `${key}.json`);
}

function sentEnvelopeDir(): string {
  return join(root, "mail", ".sent-envelopes");
}

/** A signed envelope in the shape `tps mail send` stores, plus the verify
 *  client that resolves its sender to the seed's public key. */
async function signedStoredEnvelope(
  id: string,
  expected: { from: string; to: string; body: string },
  seed: Buffer,
  replyToId?: string,
): Promise<{ raw: string; client: FlairClient }> {
  const now = new Date().toISOString();
  const envelope: Envelope = {
    v: 1,
    from: expected.from,
    to: expected.to,
    body: expected.body,
    messageId: id,
    timestamp: now,
    delegationChain: [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: expected.from, kind: "agent", timestamp: now, rationale: "test send", signature: null },
    ],
    ...(replyToId !== undefined ? { replyToId } : {}),
  };
  const raw = JSON.stringify(signEnvelope(envelope, { [expected.from]: seed }));
  const publicKey = Buffer.from(await ed.getPublicKeyAsync(new Uint8Array(seed)));
  return {
    raw,
    client: {
      async getAgent(name: string) {
        return name === expected.from ? { publicKey } : null;
      },
    },
  };
}

async function runSend(
  args: string[],
  env: Record<string, string> = {},
  ms = 15_000,
  body = "unconfirmed delivery test",
  opts: { seed?: Buffer; writeKey?: boolean } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const keysDir = join(root, "keys");
  if (opts.writeKey !== false) writeKeyFile(keysDir, "flint", opts.seed ?? FLINT_SEED);
  const proc = Bun.spawn(["bun", TPS_BIN, "mail", "send", "remote-a", ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      TPS_MAIL_DIR: join(root, "mail"),
      TPS_TEST_KEYS_DIR: keysDir,
      TPS_AGENT_ID: "flint",
      TPS_VAULT_KEY: "mail-962-test",
      TPS_IDENTITY_DIR: join(root, "identity"),
      TPS_REGISTRY_DIR: join(root, "registry"),
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(body);
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), ms);
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe("the ACK window is configurable and refuses bad values by name", () => {
  test("default is 30 s", () => {
    expect(DEFAULT_MAIL_ACK_TIMEOUT_MS).toBe(30_000);
    expect(resolveMailAckTimeoutMs({})).toBe(30_000);
  });

  test("flag wins over the environment variable", () => {
    expect(resolveMailAckTimeoutMs({ TPS_MAIL_ACK_TIMEOUT_MS: "1000" }, "250")).toBe(250);
  });

  test("non-numeric and non-positive values are refused with the source named", () => {
    expect(() => parseMailAckTimeoutMs("soon", "--ack-timeout")).toThrow(/--ack-timeout must be a positive integer/);
    expect(() => parseMailAckTimeoutMs("0", "--ack-timeout")).toThrow(/--ack-timeout must be a positive integer/);
    expect(() => parseMailAckTimeoutMs("-3", "--ack-timeout")).toThrow(/--ack-timeout must be a positive integer/);
    expect(() => resolveMailAckTimeoutMs({ TPS_MAIL_ACK_TIMEOUT_MS: "abc" })).toThrow(/TPS_MAIL_ACK_TIMEOUT_MS must be a positive integer/);
    expect(() => resolveMailAckTimeoutMs({ TPS_MAIL_ACK_TIMEOUT_MS: "0" })).toThrow(/TPS_MAIL_ACK_TIMEOUT_MS must be a positive integer/);
  });
});

describe("deliverToRemoteBranch reports a late ACK as unconfirmed", () => {
  test("an ACK inside the window is a success", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    await deliverToRemoteBranch(
      "remote-a",
      { id: "11111111-1111-1111-1111-111111111111", to: "local", from: "flint", body: "in window" },
      { ackTimeoutMs: 5_000 },
    );
    expect(branch.deliveries.map((delivery) => delivery.id)).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(inboxRecords()).toHaveLength(1);
    await expectConnectionEndedAfter("an accepted delivery");
  }, 15_000);

  test("an ACK outside a short configured window rejects as unconfirmed, naming the id", async () => {
    await startBranchServer({ ackDelayMs: 700 });
    pointRemoteAtServer();
    const id = "22222222-2222-2222-2222-222222222222";
    let caught: unknown;
    try {
      await deliverToRemoteBranch("remote-a", { id, to: "local", from: "flint", body: "late ack" }, { ackTimeoutMs: 150 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MailDeliveryUnconfirmedError);
    const error = caught as MailDeliveryUnconfirmedError;
    expect(error.messageId).toBe(id);
    expect(error.message).toContain("Delivery unconfirmed");
    expect(error.message).toContain(id);
    expect(error.message).toContain("may still arrive");
    expect(error.message).toContain(`--message-id ${id}`);
    expect(error.message).not.toContain("Branch refused delivery");
    await expectConnectionEndedAfter("an unconfirmed delivery");
  }, 15_000);

  test("accepted:false keeps the existing refused-delivery failure", async () => {
    await startBranchServer({ accepted: false, error: "inbox full" });
    pointRemoteAtServer();
    let caught: unknown;
    try {
      await deliverToRemoteBranch(
        "remote-a",
        { id: "33333333-3333-3333-3333-333333333333", to: "local", from: "flint", body: "refused" },
        { ackTimeoutMs: 5_000 },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(MailDeliveryUnconfirmedError);
    expect((caught as Error).message).toBe("Branch refused delivery: inbox full");
    await expectConnectionEndedAfter("a refused delivery");
  }, 15_000);

  test("a re-send with the same id leaves exactly one inbox record and still ACKs", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "44444444-4444-4444-4444-444444444444";
    // The same delivery payload re-sent: the branch keys its record by
    // (branch, wire id), so the second delivery reuses it and ACKs accepted.
    const message = { id, to: "local", from: "flint", body: "re-send me", timestamp: "2026-11-11T00:00:00.000Z" };
    await deliverToRemoteBranch("remote-a", message, { ackTimeoutMs: 5_000 });
    await deliverToRemoteBranch("remote-a", message, { ackTimeoutMs: 5_000 });
    expect(branch.acceptErrors).toEqual([]);
    expect(branch.deliveries.map((delivery) => delivery.id)).toEqual([id, id]);
    expect(inboxRecords()).toHaveLength(1);
    await expectConnectionEndedAfter("a re-send");
  }, 15_000);
});

describe("tps mail send exit codes", () => {
  test("a missing ACK exits 75 with the unconfirmed message, not the failure text", async () => {
    await startBranchServer({ ackDelayMs: 700 });
    pointRemoteAtServer();
    const r = await runSend(["--stdin", "--ack-timeout", "150"]);
    expect(r.status).toBe(75);
    const id = r.stderr.match(/for message ([0-9a-f-]{36}) within 150ms/)?.[1];
    expect(id).toBeDefined();
    expect(r.stderr).toContain("Delivery unconfirmed");
    expect(r.stderr).toContain("may still arrive");
    expect(r.stderr).toContain(`--message-id ${id}`);
    expect(r.stderr).not.toContain("Branch refused delivery");
  }, 20_000);

  test("an ACK inside the window exits 0", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const r = await runSend(["--stdin", "--ack-timeout", "5000"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Mail delivered to remote branch");
  }, 20_000);

  test("accepted:false exits 1 with the existing failure", async () => {
    await startBranchServer({ accepted: false, error: "inbox full" });
    pointRemoteAtServer();
    const r = await runSend(["--stdin", "--ack-timeout", "5000"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Branch refused delivery: inbox full");
    expect(r.stderr).not.toContain("Delivery unconfirmed");
  }, 20_000);

  test("a non-numeric --ack-timeout is refused by name before anything is sent", async () => {
    await startBranchServer({});
    pointRemoteAtServer();
    const r = await runSend(["--stdin", "--ack-timeout", "soon"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--ack-timeout must be a positive integer");
    expect(branch.deliveries).toEqual([]);
  }, 20_000);

  test("a bad TPS_MAIL_ACK_TIMEOUT_MS is refused by name", async () => {
    await startBranchServer({});
    pointRemoteAtServer();
    const r = await runSend(["--stdin"], { TPS_MAIL_ACK_TIMEOUT_MS: "0" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TPS_MAIL_ACK_TIMEOUT_MS must be a positive integer");
    expect(branch.deliveries).toEqual([]);
  }, 20_000);
});

describe("a CLI re-send with the same --message-id sends the same signed message", () => {
  test("two spawns with the same id both exit 0 and leave one inbox record", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "55555555-5555-5555-5555-555555555555";
    const first = await runSend(["--stdin", "--message-id", id, "--ack-timeout", "2000"]);
    expect(first.status).toBe(0);
    // The stored envelope is ours: regular file, owner-only read/write
    // (0600) inside an owner-only directory (0700).
    expect(statSync(sentEnvelopeFile(id)).mode & 0o777).toBe(0o600);
    expect(statSync(sentEnvelopeDir()).mode & 0o777).toBe(0o700);
    expect(first.status).toBe(0);
    const second = await runSend(["--stdin", "--message-id", id, "--ack-timeout", "2000"]);
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain("conflict");
    expect(branch.acceptErrors).toEqual([]);
    expect(branch.deliveries.map((delivery) => delivery.id)).toEqual([id, id]);
    expect(new Set(branch.deliveries.map((delivery) => delivery.timestamp)).size).toBe(1);
    expect(inboxRecords("remote-a")).toHaveLength(1);
    await expectConnectionEndedAfter("a CLI re-send");
  }, 25_000);

  test("the same id with a different body is refused before sending", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "66666666-6666-6666-6666-666666666666";
    const first = await runSend(["--stdin", "--message-id", id, "--ack-timeout", "2000"], {}, 15_000, "first body");
    const second = await runSend(["--stdin", "--message-id", id, "--ack-timeout", "2000"], {}, 15_000, "second body");
    expect(first.status).toBe(0);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("already used to sign a different message");
    expect(branch.deliveries).toHaveLength(1);
    expect(inboxRecords("remote-a")).toHaveLength(1);
  }, 25_000);
});

describe("a --message-id re-send re-checks the key and the stored envelope", () => {
  async function firstSend(id: string, replyToId?: string, body = "re-send body"): Promise<void> {
    const args = ["--stdin", "--message-id", id, "--ack-timeout", "2000"];
    if (replyToId !== undefined) args.push("--reply-to", replyToId);
    const first = await runSend(args, {}, 15_000, body);
    expect(first.status).toBe(0);
  }

  function secondArgs(id: string, replyToId?: string): string[] {
    const args = ["--stdin", "--message-id", id, "--ack-timeout", "2000"];
    if (replyToId !== undefined) args.push("--reply-to", replyToId);
    return args;
  }

  test("a re-send after the key is removed is refused and sends nothing", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "77777777-7777-7777-7777-777777777771";
    await firstSend(id);
    rmSync(join(root, "keys", "flint.key"));
    const second = await runSend(secondArgs(id), {}, 15_000, "re-send body", { writeKey: false });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("no Ed25519 private key");
    expect(branch.deliveries).toHaveLength(1);
  }, 25_000);

  test("a re-send with a rotated key is refused and sends nothing", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "77777777-7777-7777-7777-777777777772";
    await firstSend(id);
    const second = await runSend(secondArgs(id), {}, 15_000, "re-send body", { seed: Buffer.alloc(32, 0x03) });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("does not verify against the current key");
    expect(branch.deliveries).toHaveLength(1);
  }, 25_000);

  test("a stored signature that was stripped is refused and sends nothing", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "77777777-7777-7777-7777-777777777773";
    await firstSend(id);
    const path = sentEnvelopeFile(id);
    const stored = JSON.parse(readFileSync(path, "utf-8"));
    delete stored.signature;
    writeFileSync(path, JSON.stringify(stored));
    const second = await runSend(secondArgs(id), {}, 15_000, "re-send body");
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("not a valid signed envelope");
    expect(branch.deliveries).toHaveLength(1);
  }, 25_000);

  test("a stored body changed by one byte is refused and sends nothing", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "77777777-7777-7777-7777-777777777774";
    await firstSend(id);
    const path = sentEnvelopeFile(id);
    const stored = JSON.parse(readFileSync(path, "utf-8"));
    stored.body = `${stored.body}x`;
    writeFileSync(path, JSON.stringify(stored));
    const second = await runSend(secondArgs(id), {}, 15_000, "re-send body");
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("already used to sign a different message");
    expect(branch.deliveries).toHaveLength(1);
  }, 25_000);

  test("a stored signature that no longer verifies is refused and sends nothing", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "77777777-7777-7777-7777-777777777775";
    await firstSend(id);
    const path = sentEnvelopeFile(id);
    const stored = JSON.parse(readFileSync(path, "utf-8"));
    const sig: string = stored.signature;
    const prefix = "ed25519:";
    const body64 = sig.slice(prefix.length);
    const at = Math.floor(body64.length / 2);
    const flipped = body64[at] === "A" ? "B" : "A";
    stored.signature = `${prefix}${body64.slice(0, at)}${flipped}${body64.slice(at + 1)}`;
    writeFileSync(path, JSON.stringify(stored));
    const second = await runSend(secondArgs(id), {}, 15_000, "re-send body");
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("does not verify against the current key");
    expect(branch.deliveries).toHaveLength(1);
  }, 25_000);

  test("a re-send with a different --reply-to is refused and sends nothing", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "77777777-7777-7777-7777-777777777776";
    await firstSend(id, "reply-one");
    const second = await runSend(secondArgs(id, "reply-two"), {}, 15_000, "re-send body");
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("different --reply-to");
    expect(branch.deliveries).toHaveLength(1);
  }, 25_000);

  test("an invalid --reply-to on a re-send is refused before the store is read", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "77777777-7777-7777-7777-777777777777";
    await firstSend(id);
    const second = await runSend(secondArgs(id, "not a valid id!"), {}, 15_000, "re-send body");
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("invalid --reply-to id");
    expect(branch.deliveries).toHaveLength(1);
  }, 25_000);

  test("a stored entry readable by group or others is refused and sends nothing", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "77777777-7777-7777-7777-777777777778";
    await firstSend(id);
    chmodSync(sentEnvelopeFile(id), 0o644);
    const second = await runSend(secondArgs(id), {}, 15_000, "re-send body");
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("readable by group or others");
    expect(branch.deliveries).toHaveLength(1);
  }, 25_000);

  test("a symlinked stored entry is refused and sends nothing", async () => {
    await startBranchServer({ recordInbox: true });
    pointRemoteAtServer();
    const id = "77777777-7777-7777-7777-777777777779";
    await firstSend(id);
    const path = sentEnvelopeFile(id);
    const decoy = join(root, "decoy-envelope.json");
    writeFileSync(decoy, readFileSync(path), { mode: 0o600 });
    rmSync(path);
    symlinkSync(decoy, path);
    const second = await runSend(secondArgs(id), {}, 15_000, "re-send body");
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("not a regular file");
    expect(branch.deliveries).toHaveLength(1);
  }, 25_000);
});

describe("the stored signed envelope has a reuse window", () => {
  test("an entry older than the window is not reused and is removed", async () => {
    const root = process.env.TPS_MAIL_DIR!;
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const expected = { from: "agent-a", to: "agent-b", body: "old message" };
    const { raw, client } = await signedStoredEnvelope(id, expected, Buffer.alloc(32, 0x02));
    await storeSentEnvelope(root, id, raw, expected, client);
    const dir = join(root, ".sent-envelopes");
    const [name] = readdirSync(dir);
    const path = join(dir, name!);
    const old = new Date(Date.now() - SENT_ENVELOPE_TTL_MS - 1000);
    utimesSync(path, old, old);
    expect(await readSentEnvelope(root, id, expected, client)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  test("a correct 0600 entry signed by the current key is reused", async () => {
    const root = process.env.TPS_MAIL_DIR!;
    const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const expected = { from: "agent-a", to: "agent-b", body: "current message" };
    const { raw, client } = await signedStoredEnvelope(id, expected, Buffer.alloc(32, 0x02));
    await storeSentEnvelope(root, id, raw, expected, client);
    expect(await readSentEnvelope(root, id, expected, client)).toBe(raw);
  });

  test("an entry owned by another uid is refused", async () => {
    const root = process.env.TPS_MAIL_DIR!;
    const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const expected = { from: "agent-a", to: "agent-b", body: "owned elsewhere" };
    const { raw, client } = await signedStoredEnvelope(id, expected, Buffer.alloc(32, 0x02));
    await storeSentEnvelope(root, id, raw, expected, client);
    const realUid = process.getuid!();
    const spy = spyOn(process, "getuid").mockReturnValue(realUid + 1);
    try {
      await expect(readSentEnvelope(root, id, expected, client)).rejects.toThrow(/not owned by this user/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("flags and ids the remote wire cannot carry are refused by name", () => {
  test("a --message-id outside the wire id shape is refused instead of silently dropped", async () => {
    await startBranchServer({});
    pointRemoteAtServer();
    const r = await runSend(["--stdin", "--message-id", "not-a-uuid.0001"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot be delivered to a remote branch");
    expect(branch.deliveries).toEqual([]);
  }, 20_000);

  test("--ack-timeout -3 is refused by name before anything is sent", async () => {
    await startBranchServer({});
    pointRemoteAtServer();
    const r = await runSend(["--stdin", "--ack-timeout", "-3"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--ack-timeout must be a positive integer");
    expect(branch.deliveries).toEqual([]);
  }, 20_000);

  test("a bare --ack-timeout is refused by name before anything is sent", async () => {
    await startBranchServer({});
    pointRemoteAtServer();
    const r = await runSend(["--stdin", "--ack-timeout"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--ack-timeout must be a positive integer");
    expect(branch.deliveries).toEqual([]);
  }, 20_000);
});

describe("the connect bound and the ACK window are separate", () => {
  test("a connect that never completes rejects as a connect timeout", async () => {
    const silent = net.createServer(() => {});
    const sockets = new Set<net.Socket>();
    silent.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((done) => silent.listen(0, "127.0.0.1", () => done()));
    const silentPort = (silent.address() as net.AddressInfo).port;
    writeFileSync(
      join(root, ".tps", "branch-office", "remote-a", "remote.json"),
      JSON.stringify({ host: "127.0.0.1", port: silentPort, transport: "ws" }),
    );
    try {
      let caught: unknown;
      try {
        await deliverToRemoteBranch(
          "remote-a",
          { id: "77777777-7777-7777-7777-777777777777", to: "local", from: "flint", body: "slow connect" },
          { timeoutMs: 200, ackTimeoutMs: 5_000 },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RemoteDeliveryTimeoutError);
      expect((caught as Error).message).toContain("(connect)");
      expect((caught as Error).message).not.toContain("connect + ack");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => silent.close(() => done()));
    }
  }, 10_000);

  test("a slow connect leaves the full ACK window, so a missing ACK is unconfirmed", async () => {
    await startBranchServer({ handshakeDelayMs: 500, noAck: true });
    pointRemoteAtServer();
    let caught: unknown;
    try {
      await deliverToRemoteBranch(
        "remote-a",
        { id: "88888888-8888-8888-8888-888888888888", to: "local", from: "flint", body: "slow handshake" },
        { timeoutMs: 800, ackTimeoutMs: 500 },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MailDeliveryUnconfirmedError);
    expect(caught).not.toBeInstanceOf(RemoteDeliveryTimeoutError);
    await expectConnectionEndedAfter("a slow-handshake delivery");
  }, 15_000);

  test("a send that throws leaves no unhandled rejection from the ACK window", async () => {
    const id = "99999999-9999-9999-9999-999999999999";
    // The ACK can settle before the send promise does; a send failure then
    // leaves that rejection unawaited unless it has its own handler.
    let deliver: ((msg: TpsMessage) => void) | null = null;
    const channel: TransportChannel = {
      async send() {
        deliver?.({ type: MSG_MAIL_ACK, seq: 0, ts: new Date().toISOString(), body: { id, accepted: false, error: "refused during send" } });
        throw new Error("send failed");
      },
      onMessage(handler) {
        deliver = handler;
      },
      offMessage() {
        deliver = null;
      },
      async close() {},
      isAlive() {
        return true;
      },
      peerFingerprint() {
        return "a".repeat(64);
      },
    };
    spyOn(WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let caught: unknown;
      try {
        await deliverToRemoteBranch(
          "remote-a",
          { id, to: "local", from: "flint", body: "throwing send" },
          { timeoutMs: 200, ackTimeoutMs: 50 },
        );
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toBe("send failed");
      await sleep(200);
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 10_000);
});
