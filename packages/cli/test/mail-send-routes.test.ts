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
 * (~/.tps/identity/<id>.key) is the key `tps mail send` signs with.
 *
 * Every spawn runs with an isolated HOME — never the real ~/.tps (cli#430).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import { verifyEnvelope, type Envelope } from "@tpsdev-ai/agent";
import { generateKeyPair, registerBranch, saveKeyPair } from "../src/utils/identity.js";
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
});
