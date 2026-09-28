/**
 * mail-send-stdin-reply.test.ts — cli#429.
 *
 * Covers `tps mail send`'s new stdin body (`--stdin`), reply-to threading
 * (`--reply-to`), PEM PKCS8 key support, and the refusal to send unsigned.
 *
 * Every behaviour here has a CONTROL that fails without the change it guards
 * (the mutation list is reported with the PR). All spawns run with an isolated
 * HOME — never the real ~/.tps (cli#430).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { verifyEnvelope, type Envelope } from "@tpsdev-ai/agent";
import { toEd25519Seed } from "../src/utils/agent-keys.js";
import { assertValidReplyToId } from "../src/utils/mail-sign.js";
import { startStubFlair, writeKeyFile, pubkeyFromSeed, type StubFlair } from "./helpers/stub-flair.js";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");

const FLINT_SEED = Buffer.alloc(32, 0x01);
const KERN_SEED = Buffer.alloc(32, 0x02);
const SEEDS = { flint: FLINT_SEED, kern: KERN_SEED };

/** Make a PEM-PKCS8 Ed25519 keypair with node:crypto (throwaway, test-only). */
function pemKeyPair(): { pem: string; pubRaw: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const x = publicKey.export({ format: "jwk" }).x as string;
  return { pem, pubRaw: Buffer.from(x, "base64url") };
}

function mockFlairByPubkey(pubByAgent: Record<string, Buffer>) {
  return {
    async getAgent(name: string) {
      const pk = pubByAgent[name];
      return pk ? { publicKey: pk } : null;
    },
  };
}

function readNewEnvelopes(mailDir: string, to: string): Envelope[] {
  const dir = join(mailDir, to, "new");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(JSON.parse(readFileSync(join(dir, f), "utf-8")).body) as Envelope);
}

describe("mail send: stdin body, reply-to, PEM keys, refuse-unsigned (cli#429)", () => {
  let tempRoot: string;
  let keysDir: string;
  let mailDir: string;
  let home: string;
  let stub: StubFlair | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-429-"));
    keysDir = join(tempRoot, "keys");
    mailDir = join(tempRoot, "mail");
    home = join(tempRoot, "home");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(mailDir, "kern"), { recursive: true }); // kern is a LOCAL agent
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    writeKeyFile(keysDir, "kern", KERN_SEED);
  });

  afterEach(() => {
    stub?.stop();
    stub = undefined;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...process.env,
      HOME: home,
      TPS_MAIL_DIR: mailDir,
      TPS_TEST_KEYS_DIR: keysDir,
      TPS_AGENT_ID: "flint",
      ...extra,
    };
  }

  /** spawnSync send — signing is local, so the in-process stub is not needed. */
  function runSendSync(
    args: string[],
    env: Record<string, string> = {},
    input?: string,
  ): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync("bun", [TPS_BIN, "mail", "send", ...args], {
      encoding: "utf-8",
      cwd: tmpdir(),
      env: baseEnv(env),
      input,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  /** Async CLI run — needed for `check`/`list`/`read`, which verify via Flair. */
  async function runCli(
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", TPS_BIN, ...args], {
      cwd: tempRoot,
      env: baseEnv(env),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { status, stdout, stderr };
  }

  // ─── --stdin: regular file ────────────────────────────────────────────────

  test("--stdin reads the body from a regular-file stdin (memfd, the Linux spawnSync shape)", () => {
    // CONTROL: the pre-fix CLI had no --stdin; and a stream-based reader reads
    // this regular-file/memfd stdin as 0 bytes under bun, so the body would be
    // lost/empty. spawnSync's `input` is delivered as a memfd on Linux.
    const body = "body via regular-file stdin: line1\nline2\tpi";
    const r = runSendSync(["kern", "--stdin"], {}, body);
    expect(r.status).toBe(0);

    const envs = readNewEnvelopes(mailDir, "kern");
    expect(envs.length).toBe(1);
    expect(envs[0]!.body).toBe(body);
    expect(envs[0]!.signature).toMatch(/^ed25519:/);
  });

  // ─── --stdin: pipe delivering in pieces ───────────────────────────────────

  test("--stdin reads a pipe that delivers the body in pieces", async () => {
    // CONTROL: a one-shot/stream reader can return only the first chunk (or
    // nothing) when the writer pauses between writes.
    const proc = Bun.spawn(["bun", TPS_BIN, "mail", "send", "kern", "--stdin"], {
      cwd: tmpdir(),
      env: baseEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const sink = proc.stdin;
    sink.write("first-half|");
    await sink.flush();
    // Wait long enough that the child (bun boot ~200ms) has started, consumed
    // the first chunk and is blocked in readSync before the second arrives —
    // otherwise both chunks sit in the pipe buffer and a single read would
    // return the whole body, and the test would not exercise the read loop.
    await new Promise((r) => setTimeout(r, 700));
    sink.write("second-half");
    await sink.flush();
    await new Promise((r) => setTimeout(r, 100));
    sink.end();
    const status = await proc.exited;
    await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();

    expect(status).toBe(0);
    const envs = readNewEnvelopes(mailDir, "kern");
    expect(envs.length).toBe(1);
    expect(envs[0]!.body).toBe("first-half|second-half");
  });

  // ─── --stdin: empty input ─────────────────────────────────────────────────

  test("--stdin with empty input fails with a distinct error and writes nothing", () => {
    // CONTROL: without the distinct empty check, empty stdin would either ship
    // an empty body or be indistinguishable from an I/O error.
    const r = runSendSync(["kern", "--stdin"], {}, "");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no message body received on stdin");
    expect(readNewEnvelopes(mailDir, "kern").length).toBe(0);
  });

  // ─── --stdin: too large ───────────────────────────────────────────────────

  test("--stdin enforces the 64KB envelope body cap", () => {
    const r = runSendSync(["kern", "--stdin"], {}, "x".repeat(64 * 1024 + 1));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("exceeds the");
    expect(readNewEnvelopes(mailDir, "kern").length).toBe(0);
  });

  // ─── --stdin + positional are refused ─────────────────────────────────────

  test("--stdin is refused when combined with a positional message", () => {
    const r = runSendSync(["kern", "argv-body", "--stdin"], {}, "stdin-body");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cannot be combined");
    expect(readNewEnvelopes(mailDir, "kern").length).toBe(0);
  });

  // ─── --reply-to: carried inside the signed envelope and verifies ──────────

  test("--reply-to is carried inside the envelope and is covered by the signature", async () => {
    // CONTROL: before the change the option did not exist and no field carried
    // the reply. The tamper/strip cases below prove it is INSIDE the signature.
    const replyId = "11111111-2222-3333-4444-555555555555";
    const r = runSendSync(["kern", "--stdin", "--reply-to", replyId], {}, "a reply");
    expect(r.status).toBe(0);

    const [env] = readNewEnvelopes(mailDir, "kern");
    expect(env).toBeTruthy();
    expect(env!.replyToId).toBe(replyId);

    const flair = mockFlairByPubkey({ flint: pubkeyFromSeed(FLINT_SEED) });
    const v = await verifyEnvelope(env!, flair);
    expect(v).toEqual({ ok: true });

    // Tamper the reply-to on the wire: verification must now FAIL.
    const tampered = { ...env!, replyToId: "99999999-0000-0000-0000-000000000000" };
    const vTampered = await verifyEnvelope(tampered, flair);
    expect(vTampered.ok).toBe(false);

    // Stripping it must also fail (it is bound by the signature).
    const { replyToId: _drop, ...stripped } = env!;
    const vStripped = await verifyEnvelope(stripped as Envelope, flair);
    expect(vStripped.ok).toBe(false);
  });

  // ─── --reply-to: surfaced on receipt (check / list / read) ────────────────

  test("reply-to is surfaced on receipt by mail check/list/read", async () => {
    stub = startStubFlair(SEEDS);
    const replyId = "abcdef01-2345-6789-abcd-ef0123456789";
    const sent = runSendSync(["kern", "--stdin", "--reply-to", replyId], {}, "threaded reply");
    expect(sent.status).toBe(0);

    const env = { FLAIR_URL: stub.url, FLAIR_KEY_PATH: join(keysDir, "kern.key") };

    const checked = await runCli(["mail", "check", "kern", "--json"], env);
    expect(checked.status).toBe(0);
    const rows = JSON.parse(checked.stdout);
    expect(rows.length).toBe(1);
    expect(rows[0].body).toBe("threaded reply");
    expect(rows[0].replyToId).toBe(replyId);

    const listed = await runCli(["mail", "list", "kern"], env);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain(`reply-to: ${replyId}`);

    const read = await runCli(["mail", "read", "kern", rows[0].id], env);
    expect(read.status).toBe(0);
    expect(read.stdout).toContain(`Reply-to: ${replyId}`);
    expect(read.stdout).toContain("threaded reply");
  });

  // ─── --reply-to: invalid shape refused ────────────────────────────────────

  test("an invalid --reply-to id is refused before anything is written", () => {
    const r = runSendSync(["kern", "--stdin", "--reply-to", "not a valid id!!"], {}, "x");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("invalid --reply-to id");
    expect(readNewEnvelopes(mailDir, "kern").length).toBe(0);
  });

  test("assertValidReplyToId accepts a UUID/dotted id and rejects whitespace/empty", () => {
    expect(() => assertValidReplyToId("11111111-2222-3333-4444-555555555555")).not.toThrow();
    expect(() => assertValidReplyToId("prior-001")).not.toThrow();
    expect(() => assertValidReplyToId("")).toThrow(/invalid --reply-to id/);
    expect(() => assertValidReplyToId("has space")).toThrow(/invalid --reply-to id/);
    expect(() => assertValidReplyToId("x".repeat(129))).toThrow(/invalid --reply-to id/);
  });

  // ─── PEM PKCS8 keys ────────────────────────────────────────────────────────

  test("a PEM PKCS8 Ed25519 key (as bob onboard writes) signs a verifiable envelope", async () => {
    // CONTROL: the pre-fix loader threw "Unrecognized Ed25519 private key
    // format" for this key, so the send could not sign at all.
    const { pem, pubRaw } = pemKeyPair();
    writeFileSync(join(keysDir, "bob.key"), pem);

    const r = runSendSync(["kern", "--stdin"], { TPS_AGENT_ID: "bob" }, "pem-signed body");
    expect(r.status).toBe(0);

    const [env] = readNewEnvelopes(mailDir, "kern");
    expect(env).toBeTruthy();
    expect(env!.from).toBe("bob");
    expect(env!.body).toBe("pem-signed body");
    expect(env!.signature).toMatch(/^ed25519:/);

    const v = await verifyEnvelope(env!, mockFlairByPubkey({ bob: pubRaw }));
    expect(v).toEqual({ ok: true });
  });

  test("toEd25519Seed normalizes a PEM PKCS8 key to a 32-byte seed", () => {
    const { pem } = pemKeyPair();
    const seed = toEd25519Seed(Buffer.from(pem, "utf8"));
    expect(seed.length).toBe(32);
  });

  // ─── refuse to send unsigned ───────────────────────────────────────────────

  test("a send with no key FAILS: non-zero, names the key path and remedy, writes nothing", () => {
    // CONTROL: pre-fix this exited 0 and shipped the raw (unsigned) body.
    const r = runSendSync(["kern", "--stdin"], { TPS_AGENT_ID: "nokey" }, "must not ship");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no Ed25519 private key for agent "nokey"');
    expect(r.stderr).toContain(join(keysDir, "nokey.key")); // names the missing path
    expect(r.stderr).toContain("Provision the key"); // names the remedy
    // Nothing in the recipient maildir, and no outbox created.
    expect(readNewEnvelopes(mailDir, "kern").length).toBe(0);
    expect(existsSync(join(home, ".tps", "outbox"))).toBe(false);
  });

  test("--unsigned is an explicit opt-in that ships the raw body", () => {
    // CONTROL: without --unsigned (the default) the same command fails; this
    // asserts the opt-in still exists for local tests and is never the default.
    const denied = runSendSync(["kern", "--stdin"], { TPS_AGENT_ID: "nokey" }, "x");
    expect(denied.status).not.toBe(0);

    const allowed = runSendSync(["kern", "--stdin", "--unsigned"], { TPS_AGENT_ID: "nokey" }, "raw unsigned body");
    expect(allowed.status).toBe(0);
    expect(allowed.stderr).toContain("--unsigned");

    const dir = join(mailDir, "kern", "new");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const wrapper = JSON.parse(readFileSync(join(dir, files[0]!), "utf-8"));
    expect(wrapper.body).toBe("raw unsigned body"); // NOT an envelope
  });
});
