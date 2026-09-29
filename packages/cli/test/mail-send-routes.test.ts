/**
 * mail-send-routes.test.ts — cli#429: the no-key refusal holds on EVERY route
 * `tps mail send` can take, and a signed send lands on ITS route only.
 *
 * Routes (resolveMailRoute): local maildir, outbox (branch host), branch-office
 * bridge (sandbox inbox), remote branch (the wire). For each:
 *   - NO KEY: non-zero exit, the refusal names the path, and NOTHING leaves —
 *     no file in any maildir, outbox or sandbox, and no connection to the wire.
 *   - WITH A KEY (the positive control that makes the refusal meaningful): the
 *     same fixture delivers a SIGNED envelope to that route and to no other —
 *     the local send is local-only, and the remote send reaches the wire.
 *
 * Plus: a key provisioned by `tps init` or `tps agent create`
 * (~/.tps/identity/<id>.key) is the key `tps mail send` signs with; and
 * `--stdin --json` prints delivery metadata only — the body never reaches
 * stdout or stderr on any route, succeeding or failing.
 *
 * Every CLI spawn here runs with HOME inside the test's temp root — never the
 * real ~/.tps (cli#430).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import Noise from "noise-handshake/noise.js";
import Cipher from "noise-handshake/cipher.js";
import { verifyEnvelope, type Envelope } from "@tpsdev-ai/agent";
import { generateKeyPair, registerBranch, saveKeyPair } from "../src/utils/identity.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER } from "../src/utils/wire-mail.js";
import { decodeWireMessage, encodeWireMessage } from "../src/utils/wire-frame.js";
import { writeKeyFile, pubkeyFromSeed } from "./helpers/stub-flair.js";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const FLINT_SEED = Buffer.alloc(32, 0x01);

let root: string;
let home: string;
let mailDir: string;
let keysDir: string;
let server: net.Server | null = null;
let connections = 0;
let port = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tps-429-routes-"));
  home = join(root, "home");
  mailDir = join(home, ".tps", "mail");
  keysDir = join(root, "keys");
  mkdirSync(mailDir, { recursive: true });
  mkdirSync(keysDir, { recursive: true });
  connections = 0;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  rmSync(root, { recursive: true, force: true });
});

/** A TCP listener standing in for the remote branch: it COUNTS connections. */
async function startWireListener(): Promise<void> {
  server = net.createServer((sock) => {
    connections++;
    sock.destroy();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as net.AddressInfo).port;
}

/** Office fixtures for three routes at once: local `kern`, bridge `ember`, remote `rbranch`. */
async function officeFixtures(): Promise<void> {
  mkdirSync(join(mailDir, "kern"), { recursive: true });
  mkdirSync(join(home, ".tps", "branch-office", "ember", "mail", "inbox"), { recursive: true });
  await startWireListener();
  const branchDir = join(home, ".tps", "branch-office", "rbranch");
  mkdirSync(branchDir, { recursive: true });
  writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "127.0.0.1", port, transport: "ws" }));
  // Register the branch and a host identity, so WITH a key the remote route
  // really reaches the wire (the positive control below proves it does).
  const prev = { id: process.env.TPS_IDENTITY_DIR, reg: process.env.TPS_REGISTRY_DIR };
  process.env.TPS_IDENTITY_DIR = join(home, ".tps", "identity");
  process.env.TPS_REGISTRY_DIR = join(home, ".tps", "registry");
  try {
    mkdirSync(process.env.TPS_IDENTITY_DIR, { recursive: true });
    mkdirSync(process.env.TPS_REGISTRY_DIR, { recursive: true });
    saveKeyPair(generateKeyPair(), process.env.TPS_IDENTITY_DIR, "host");
    const branchKp = generateKeyPair();
    registerBranch("rbranch", branchKp.signing.publicKey, undefined, branchKp.encryption.publicKey);
  } finally {
    if (prev.id === undefined) delete process.env.TPS_IDENTITY_DIR;
    else process.env.TPS_IDENTITY_DIR = prev.id;
    if (prev.reg === undefined) delete process.env.TPS_REGISTRY_DIR;
    else process.env.TPS_REGISTRY_DIR = prev.reg;
  }
}

/** A branch host: every unbound recipient goes to the outbox. */
function branchFixture(): void {
  mkdirSync(join(home, ".tps", "identity"), { recursive: true });
  writeFileSync(join(home, ".tps", "identity", "host.json"), JSON.stringify({ hostId: "branchhost" }));
}

/** Every mail file on disk that any route could have written. */
function destinations(): string[] {
  const dirs: string[] = [join(home, ".tps", "outbox", "new")];
  if (existsSync(mailDir)) for (const a of readdirSync(mailDir)) dirs.push(join(mailDir, a, "new"));
  const bo = join(home, ".tps", "branch-office");
  if (existsSync(bo)) for (const b of readdirSync(bo)) dirs.push(join(bo, b, "mail", "new"));
  const out: string[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith(".json")) out.push(join(d, f));
  }
  return out;
}

/**
 * Async send (the wire listener lives in THIS process, so the event loop must
 * stay free). Bounded: a child still running after `ms` is killed.
 */
async function send(to: string, env: Record<string, string> = {}, ms = 15000): Promise<{ status: number; stderr: string }> {
  const proc = Bun.spawn(["bun", TPS_BIN, "mail", "send", to, "--stdin"], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      TPS_MAIL_DIR: mailDir,
      TPS_TEST_KEYS_DIR: keysDir,
      TPS_AGENT_ID: "flint",
      TPS_VAULT_KEY: "test-passphrase",
      TPS_IDENTITY_DIR: join(home, ".tps", "identity"),
      TPS_REGISTRY_DIR: join(home, ".tps", "registry"),
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write("route body");
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), ms);
  const [stderr, status] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  await new Response(proc.stdout).text();
  return { status, stderr };
}

function expectSignedByFlint(file: string): Promise<void> {
  const env = JSON.parse(JSON.parse(readFileSync(file, "utf-8")).body) as Envelope;
  expect(env.from).toBe("flint");
  expect(env.body).toBe("route body");
  return verifyEnvelope(env, {
    async getAgent(name: string) {
      return name === "flint" ? { publicKey: pubkeyFromSeed(FLINT_SEED) } : null;
    },
  }).then((v) => expect(v).toEqual({ ok: true }));
}

describe("no key → every route refuses and NOTHING leaves (cli#429)", () => {
  for (const [route, to] of [
    ["local", "kern"],
    ["bridge", "ember"],
    ["remote-branch", "rbranch"],
  ] as const) {
    test(`${route}: refused, no file anywhere, no connection to the wire`, async () => {
      await officeFixtures();
      const r = await send(to); // no flint.key in keysDir
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('no Ed25519 private key for agent "flint"');
      expect(r.stderr).toContain(join(keysDir, "flint.key"));
      expect(destinations()).toEqual([]);
      expect(connections).toBe(0);
    }, 20000);
  }

  test("outbox (branch host): refused, the outbox stays empty", async () => {
    branchFixture();
    const r = await send("host");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no Ed25519 private key for agent "flint"');
    expect(destinations()).toEqual([]);
    expect(existsSync(join(home, ".tps", "outbox"))).toBe(false);
  }, 20000);
});

describe("with a key → each route delivers a SIGNED envelope to itself only (positive controls)", () => {
  test("local: exactly one file, in the recipient's maildir — local-only (no outbox, no sandbox, no wire)", async () => {
    await officeFixtures();
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    const r = await send("kern");
    expect(r.status).toBe(0);
    const files = destinations();
    expect(files.length).toBe(1);
    expect(files[0]!.startsWith(join(mailDir, "kern", "new"))).toBe(true);
    expect(connections).toBe(0);
    await expectSignedByFlint(files[0]!);
  }, 20000);

  test("bridge: exactly one file, in the sandbox — nothing local, nothing on the wire", async () => {
    await officeFixtures();
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    const r = await send("ember");
    expect(r.status).toBe(0);
    const files = destinations();
    expect(files.length).toBe(1);
    expect(files[0]!.startsWith(join(home, ".tps", "branch-office", "ember", "mail", "new"))).toBe(true);
    expect(connections).toBe(0);
    await expectSignedByFlint(files[0]!);
  }, 20000);

  test("remote-branch: the send REACHES the wire (so the no-key test's zero connections is meaningful)", async () => {
    await officeFixtures();
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    await send("rbranch", {}, 8000); // the stand-in drops the socket, so the send itself fails
    expect(connections).toBeGreaterThan(0);
    expect(destinations()).toEqual([]);
  }, 20000);

  test("outbox: exactly one queued record, a signed envelope", async () => {
    branchFixture();
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    const r = await send("host");
    expect(r.status).toBe(0);
    const files = destinations();
    expect(files.length).toBe(1);
    expect(files[0]!.startsWith(join(home, ".tps", "outbox", "new"))).toBe(true);
    await expectSignedByFlint(files[0]!);
  }, 20000);
});

describe("a key provisioned by `tps init` / `tps agent create` is the key mail signs with (cli#429)", () => {
  /** Run a CLI command with this test's HOME and NO test keys dir — the real search path. */
  async function cli(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<{ status: number; stderr: string }> {
    const base: Record<string, string | undefined> = { ...process.env };
    delete base.TPS_TEST_KEYS_DIR;
    delete base.TPS_IDENTITY_DIR;
    const proc = Bun.spawn(["bun", TPS_BIN, ...args], {
      cwd: root,
      env: { ...base, HOME: home, TPS_MAIL_DIR: mailDir, FLAIR_URL: "http://127.0.0.1:9", ...env },
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const [stderr, status] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    await new Response(proc.stdout).text();
    return { status, stderr };
  }

  async function sendAndVerify(agent: string, pub: Buffer): Promise<void> {
    mkdirSync(join(mailDir, "kern"), { recursive: true });
    const r = await cli(["mail", "send", "kern", "--stdin"], { TPS_AGENT_ID: agent }, "from a provisioned agent");
    expect(r.stderr).not.toContain("no Ed25519 private key");
    expect(r.status).toBe(0);
    const dir = join(mailDir, "kern", "new");
    const [file] = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const env = JSON.parse(JSON.parse(readFileSync(join(dir, file!), "utf-8")).body) as Envelope;
    expect(env.from).toBe(agent);
    const v = await verifyEnvelope(env, {
      async getAgent(name: string) {
        return name === agent ? { publicKey: pub } : null;
      },
    });
    expect(v).toEqual({ ok: true });
  }

  test("tps init → ~/.tps/identity/<id>.key signs `tps mail send`", async () => {
    // CONTROL: before cli#429 the signer looked only at ~/.flair/keys, so this
    // send was refused ("no Ed25519 private key") right after `tps init`.
    const init = await cli(["init", "initprobe"]);
    expect(init.status).toBe(0);
    const pubHex = readFileSync(join(home, ".tps", "identity", "initprobe.pub"), "utf-8").trim();
    await sendAndVerify("initprobe", Buffer.from(pubHex, "hex"));
  }, 30000);

  test("tps agent create → ~/.tps/identity/<id>.key signs `tps mail send`", async () => {
    const created = await cli(["agent", "create", "--id", "createprobe"]);
    expect(created.status).toBe(0);
    const pub = readFileSync(join(home, ".tps", "identity", "createprobe.pub"));
    expect(pub.length).toBe(32);
    await sendAndVerify("createprobe", pub);
  }, 30000);

  test("a DIFFERENT valid key at ~/.flair/keys beside the registered identity key → refused by name, nothing written; the same key → signs", async () => {
    // CONTROL: the previous head signed with the ~/.flair/keys key and exited
    // 0 — a signature the registered key does not verify.
    const created = await cli(["agent", "create", "--id", "twokeys"]);
    expect(created.status).toBe(0);
    const identity = join(home, ".tps", "identity", "twokeys.key");
    const registeredPub = readFileSync(join(home, ".tps", "identity", "twokeys.pub"));
    const flairKey = join(home, ".flair", "keys", "twokeys.key");
    mkdirSync(join(home, ".flair", "keys"), { recursive: true });
    writeFileSync(flairKey, Buffer.alloc(32, 0x5a), { mode: 0o600 }); // valid, but not the registered key
    mkdirSync(join(mailDir, "kern"), { recursive: true });

    const refused = await cli(["mail", "send", "kern", "--stdin"], { TPS_AGENT_ID: "twokeys" }, "must not ship");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("two different Ed25519 private keys");
    expect(refused.stderr).toContain(flairKey);
    expect(refused.stderr).toContain(identity);
    expect(refused.stderr).toContain("Remedy:");
    expect(existsSync(join(mailDir, "kern", "new")) ? readdirSync(join(mailDir, "kern", "new")) : []).toEqual([]);

    // The remedy: both files hold the registered key → it signs, and verifies against the registered key.
    writeFileSync(flairKey, readFileSync(identity), { mode: 0o600 });
    await sendAndVerify("twokeys", registeredPub);
  }, 30000);
});

// ─── `--stdin --json`: metadata only, on every route ─────────────────────────

describe("--stdin --json prints delivery METADATA — the body never reaches stdout or stderr (cli#429)", () => {
  /** A distinctive body: if any byte sequence of it is printed, the test sees it. */
  const BODY = "stdin-secret-7f3a9c: the body a program piped in";
  let branchServer: { http: HttpServer; wss: WebSocketServer } | null = null;
  const delivered: any[] = [];

  afterEach(async () => {
    if (branchServer) {
      branchServer.wss.close();
      await new Promise<void>((r) => branchServer!.http.close(() => r()));
    }
    branchServer = null;
    delivered.length = 0;
  });

  /** A remote branch that completes the Noise IK handshake and ACKS each delivery. */
  async function ackingRemoteBranch(name: string): Promise<void> {
    const identityDir = join(home, ".tps", "identity");
    const registryDir = join(home, ".tps", "registry");
    mkdirSync(identityDir, { recursive: true });
    mkdirSync(registryDir, { recursive: true });
    const branchKp = generateKeyPair();
    const prev = { id: process.env.TPS_IDENTITY_DIR, reg: process.env.TPS_REGISTRY_DIR };
    process.env.TPS_IDENTITY_DIR = identityDir;
    process.env.TPS_REGISTRY_DIR = registryDir;
    try {
      saveKeyPair(generateKeyPair(), identityDir, "host");
      registerBranch(name, branchKp.signing.publicKey, undefined, branchKp.encryption.publicKey);
    } finally {
      if (prev.id === undefined) delete process.env.TPS_IDENTITY_DIR;
      else process.env.TPS_IDENTITY_DIR = prev.id;
      if (prev.reg === undefined) delete process.env.TPS_REGISTRY_DIR;
      else process.env.TPS_REGISTRY_DIR = prev.reg;
    }
    const http = createServer();
    const wss = new WebSocketServer({ server: http, path: "/tps/wire" });
    wss.on("connection", (ws) => {
      const responder = new Noise("IK", false, {
        publicKey: Buffer.from(branchKp.encryption.publicKey),
        secretKey: Buffer.from(branchKp.encryption.privateKey),
      });
      responder.initialise(Buffer.from("tps-v1"));
      ws.on("message", (data) => {
        const raw = Buffer.from(data as any);
        if (!responder.rx) {
          responder.recv(raw);
          ws.send(Buffer.from(responder.send()));
          return;
        }
        const msg = decodeWireMessage(Buffer.from(new Cipher(responder.rx).decrypt(raw)));
        if (msg.type !== MSG_MAIL_DELIVER) return;
        delivered.push(msg.body);
        const ack = { type: MSG_MAIL_ACK, seq: 0, ts: new Date().toISOString(), body: { id: (msg.body as any).id, accepted: true } };
        ws.send(Buffer.from(new Cipher(responder.tx).encrypt(encodeWireMessage(ack))));
      });
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    branchServer = { http, wss };
    const branchDir = join(home, ".tps", "branch-office", name);
    mkdirSync(branchDir, { recursive: true });
    const { port: listening } = http.address() as net.AddressInfo;
    writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "127.0.0.1", port: listening, transport: "ws" }));
  }

  /** `tps mail send <to> --stdin --json` with BODY on stdin; stdout and stderr captured whole. */
  async function sendJson(to: string, extra: string[] = []): Promise<{ status: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", TPS_BIN, "mail", "send", to, "--stdin", "--json", ...extra], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        TPS_MAIL_DIR: mailDir,
        TPS_TEST_KEYS_DIR: keysDir,
        TPS_AGENT_ID: "flint",
        TPS_VAULT_KEY: "test-passphrase",
        TPS_IDENTITY_DIR: join(home, ".tps", "identity"),
        TPS_REGISTRY_DIR: join(home, ".tps", "registry"),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(BODY);
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), 15000);
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { status, stdout, stderr };
  }

  function expectNoBody(r: { stdout: string; stderr: string }): void {
    for (const fragment of [BODY, "stdin-secret-7f3a9c"]) {
      expect(r.stdout.includes(fragment), "the body is not on stdout").toBe(false);
      expect(r.stderr.includes(fragment), "the body is not on stderr").toBe(false);
    }
    expect(r.stdout.includes("delegationChain"), "nor is the signed envelope that carries it").toBe(false);
  }

  /** The metadata every route prints: its route, the signed messageId, and no body field. */
  function expectMetadata(stdout: string, route: string, to: string): Record<string, unknown> {
    const out = JSON.parse(stdout) as Record<string, unknown>;
    expect(out.route).toBe(route);
    expect(out.to).toBe(to);
    expect(out.from).toBe("flint");
    expect(typeof out.messageId).toBe("string");
    expect("body" in out).toBe(false);
    return out;
  }

  /** The body really was delivered (so its absence from the output means something). */
  function deliveredEnvelope(file: string): Envelope {
    const env = JSON.parse(JSON.parse(readFileSync(file, "utf-8")).body) as Envelope;
    expect(env.body).toBe(BODY);
    return env;
  }

  test("local: metadata only (route, ids, timestamps) — the delivered envelope carries the body", async () => {
    // CONTROL: before this change the local route printed the whole record,
    // whose body is the signed envelope carrying the stdin text.
    await officeFixtures();
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    const r = await sendJson("kern", ["--reply-to", "11111111-2222-3333-4444-555555555555"]);
    expect(r.status).toBe(0);
    expectNoBody(r);
    const out = expectMetadata(r.stdout, "local", "kern");
    const [file] = destinations();
    const env = deliveredEnvelope(file!);
    expect(out.messageId).toBe(env.messageId);
    expect(out.replyToId).toBe("11111111-2222-3333-4444-555555555555");
    expect(out.id).toBe(JSON.parse(readFileSync(file!, "utf-8")).id);
    expect(typeof out.timestamp).toBe("string");
  }, 20000);

  test("bridge: metadata only", async () => {
    await officeFixtures();
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    const r = await sendJson("ember");
    expect(r.status).toBe(0);
    expectNoBody(r);
    const out = expectMetadata(r.stdout, "bridge", "ember");
    expect(out.messageId).toBe(deliveredEnvelope(destinations()[0]!).messageId);
  }, 20000);

  test("outbox: metadata only", async () => {
    branchFixture();
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    const r = await sendJson("host");
    expect(r.status).toBe(0);
    expectNoBody(r);
    const out = expectMetadata(r.stdout, "outbox", "host");
    expect(out.messageId).toBe(deliveredEnvelope(destinations()[0]!).messageId);
  }, 20000);

  test("remote-branch (delivered and ACKed): metadata only", async () => {
    await ackingRemoteBranch("rbranch");
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    const r = await sendJson("rbranch");
    expect(r.status).toBe(0);
    expectNoBody(r);
    const out = expectMetadata(r.stdout, "remote-branch", "rbranch");
    expect(delivered.length, "the branch received the delivery").toBe(1);
    const env = JSON.parse(delivered[0].content) as Envelope;
    expect(env.body).toBe(BODY);
    expect(out.messageId).toBe(env.messageId);
  }, 20000);

  test("remote-branch (the wire FAILS): the error does not carry the body either", async () => {
    await officeFixtures(); // a listener that drops every connection
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    const r = await sendJson("rbranch");
    expect(r.status).not.toBe(0);
    expect(connections).toBeGreaterThan(0);
    expectNoBody(r);
  }, 20000);

  test("a refused send (no key) does not carry the body either", async () => {
    await officeFixtures();
    const r = await sendJson("kern");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no Ed25519 private key for agent "flint"');
    expectNoBody(r);
  }, 20000);
});
