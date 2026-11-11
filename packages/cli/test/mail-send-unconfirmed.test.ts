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
 * (`deliverRelayedToLocal`), not a stub channel.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  resolveMailAckTimeoutMs,
} from "../src/utils/relay.js";
import { getInbox } from "../src/utils/mail.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER, type MailDeliverBody } from "../src/utils/wire-mail.js";
import { decodeWireMessage, encodeWireMessage } from "../src/utils/wire-frame.js";
import { writeKeyFile } from "./helpers/stub-flair.js";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const PROLOGUE = Buffer.from("tps-v1");
const FLINT_SEED = Buffer.alloc(32, 0x02);

let root: string;
let branchKp: ReturnType<typeof generateKeyPair>;
let savedEnv: Record<string, string | undefined>;
let httpServer: ReturnType<typeof createServer> | null;
let wss: WebSocketServer | null;
let port: number;

interface BranchBehavior {
  /** Wait this long before ACKing (the sender's window may be shorter). */
  ackDelayMs?: number;
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
          ws.send(Buffer.from(responder.send()));
          return;
        }
        const msg = decodeWireMessage(Buffer.from(new Cipher(responder.rx).decrypt(raw)));
        if (msg.type !== MSG_MAIL_DELIVER) return;
        const body = msg.body as MailDeliverBody;
        branch.deliveries.push(body);
        if (behavior.recordInbox) {
          try {
            deliverRelayedToLocal("remote-a", body);
          } catch (error) {
            branch.acceptErrors.push(error);
          }
        }
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
  if (wss) {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((done) => wss!.close(() => done()));
  }
  if (httpServer) await new Promise<void>((done) => httpServer!.close(() => done()));
  wss = null;
  httpServer = null;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function pointRemoteAtServer(): void {
  writeFileSync(
    join(root, ".tps", "branch-office", "remote-a", "remote.json"),
    JSON.stringify({ host: "127.0.0.1", port, transport: "ws" }),
  );
}

function inboxRecords(): string[] {
  const inbox = getInbox("local");
  return existsSync(inbox.fresh) ? readdirSync(inbox.fresh).filter((f) => f.endsWith(".json")) : [];
}

async function runSend(args: string[], env: Record<string, string> = {}, ms = 15_000): Promise<{ status: number; stdout: string; stderr: string }> {
  const keysDir = join(root, "keys");
  writeKeyFile(keysDir, "flint", FLINT_SEED);
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
  proc.stdin.write("unconfirmed delivery test");
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
