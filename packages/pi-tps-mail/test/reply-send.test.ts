// Test: the watcher's reply path (cli#429) — the reply goes on STDIN with
// --reply-to the inbound's signed messageId; the inbound is acknowledged ONLY
// after a successful send; a failed send (no signing key) leaves the inbound
// for retry, and the retry re-sends the same reply without re-running the
// launcher.
//
// Everything runs against the REAL `tps` CLI (through an argv-recording
// wrapper) inside a throwaway root: HOME, the maildirs and the key dir are all
// under it, so nothing touches a real ~/.tps or ~/.flair.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { watchMail } from "../src/index.js";

const TPS_TS = resolve(import.meta.dir, "../../cli/bin/tps.ts");
const THREAD = "5f0c8a52-3d1e-4b7a-9c2f-7e6d5c4b3a21"; // the inbound envelope's signed messageId
const ENV_KEYS = ["HOME", "TPS_MAIL_DIR", "TPS_TEST_KEYS_DIR", "TPS_BIN", "TPS_VAULT_KEY", "TPS_AGENT_ID"] as const;

let root: string;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let stop: (() => void) | null = null;

const p = {
  mail: () => join(root, ".tps", "mail"),
  emberNew: () => join(root, ".tps", "mail", "ember", "new"),
  emberCur: () => join(root, ".tps", "mail", "ember", "cur"),
  flintNew: () => join(root, ".tps", "mail", "flint", "new"),
  keys: () => join(root, "keys"),
  argvLog: () => join(root, "tps-argv.log"),
  launcherLog: () => join(root, "agents", "ember", "launcher-calls.log"),
  launcher: () => join(root, "agents", "ember", "bin", "ember"),
};

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean) : [];
}
function jsonFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}
async function until(pred: () => boolean, ms = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-tps-mail-reply-"));
  mkdirSync(p.emberNew(), { recursive: true });
  mkdirSync(p.emberCur(), { recursive: true });
  mkdirSync(join(p.mail(), "flint"), { recursive: true }); // flint is a LOCAL agent
  mkdirSync(p.keys(), { recursive: true });
  mkdirSync(join(root, "agents", "ember", "bin"), { recursive: true });

  // The launcher: records each call, answers with a fixed reply.
  writeFileSync(p.launcher(), `#!/bin/sh\necho call >> "${p.launcherLog()}"\nprintf 'reply from ember'\n`);
  chmodSync(p.launcher(), 0o755);

  // TPS_BIN: records argv (so the test can prove the reply is NOT in it), then
  // runs the real CLI.
  const wrapper = join(root, "tps-wrapper.sh");
  writeFileSync(wrapper, `#!/bin/sh\necho "$*" >> "${p.argvLog()}"\nexec "${process.execPath}" "${TPS_TS}" "$@"\n`);
  chmodSync(wrapper, 0o755);

  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = p.mail();
  process.env.TPS_TEST_KEYS_DIR = p.keys();
  process.env.TPS_BIN = wrapper;
  process.env.TPS_VAULT_KEY = "test-vault-key";
  delete process.env.TPS_AGENT_ID;
});

afterEach(() => {
  stop?.();
  stop = null;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

/** Plant an inbound whose body is the sender's envelope carrying `messageId`. */
function plantInbound(body?: string): string {
  const envelopeBody =
    body ??
    JSON.stringify({ v: 1, from: "flint", to: "ember", body: "please answer", messageId: THREAD, timestamp: new Date().toISOString() });
  const file = join(p.emberNew(), "in-1.json");
  writeFileSync(file, JSON.stringify({ id: "in-1", from: "flint", to: "ember", body: envelopeBody, timestamp: new Date().toISOString() }));
  return file;
}

function start(retryBackoffMs: number): void {
  const w = watchMail({ agent: "ember", inboxRoot: root, launcher: p.launcher(), timeoutMs: 10_000, pollIntervalMs: 50, retryBackoffMs });
  stop = () => w.stop();
}

describe("watcher reply path (cli#429)", () => {
  it("NO signing key: the send is refused, the inbound is NOT acknowledged, it is back in new/ for retry — and no hot loop", async () => {
    // CONTROL: before cli#429 the watcher acked the inbound after a FAILED send,
    // so the reply was lost silently.
    plantInbound();
    start(60_000); // long backoff: nothing retries during this test
    const sent = await until(() => lines(p.argvLog()).some((l) => l.startsWith("mail send")));
    expect(sent).toBe(true);
    const returned = await until(() => jsonFiles(p.emberNew()).includes("in-1.json"));
    expect(returned, "the inbound is back in new/ for retry").toBe(true);

    // Several poll intervals later: still exactly one launcher run and one send.
    await new Promise((r) => setTimeout(r, 500));
    expect(lines(p.launcherLog()).length, "the launcher ran once").toBe(1);
    expect(lines(p.argvLog()).filter((l) => l.startsWith("mail send")).length, "one send attempt (backing off)").toBe(1);
    expect(lines(p.argvLog()).some((l) => l.startsWith("mail ack")), "NEVER acknowledged").toBe(false);
    expect(jsonFiles(p.flintNew()), "nothing was delivered").toEqual([]);
    const inbound = JSON.parse(readFileSync(join(p.emberNew(), "in-1.json"), "utf-8"));
    expect(inbound.ackedAt).toBeUndefined();
    expect(inbound.read).toBeUndefined();
  }, 30000);

  it("once a key is provisioned, the retry re-sends the SAME reply (launcher not re-run) — signed, on stdin, threaded — and only then acks", async () => {
    plantInbound();
    start(200);
    expect(await until(() => lines(p.argvLog()).some((l) => l.startsWith("mail send")))).toBe(true);
    expect(await until(() => jsonFiles(p.emberNew()).includes("in-1.json"))).toBe(true);
    // Provision the agent's key; the next attempt must succeed.
    writeFileSync(join(p.keys(), "ember.key"), Buffer.alloc(32, 0x0e));

    expect(await until(() => jsonFiles(p.flintNew()).length === 1), "the reply was delivered").toBe(true);
    expect(await until(() => lines(p.argvLog()).some((l) => l.startsWith("mail ack"))), "then acknowledged").toBe(true);
    expect(await until(() => !jsonFiles(p.emberNew()).includes("in-1.json") && jsonFiles(p.emberCur()).length === 0)).toBe(true);

    expect(lines(p.launcherLog()).length, "the launcher ran ONCE across the retry").toBe(1);
    const argv = lines(p.argvLog());
    const sends = argv.filter((l) => l.startsWith("mail send"));
    expect(sends.length).toBe(2);
    for (const s of sends) {
      expect(s).toContain("--stdin");
      expect(s).toContain(`--reply-to ${THREAD}`);
      expect(s.includes("reply from ember"), "the reply body is never in argv").toBe(false);
    }
    // The ack came AFTER the successful send.
    expect(argv.findIndex((l) => l.startsWith("mail ack"))).toBeGreaterThan(argv.lastIndexOf(sends[1]!));

    const wrapperRec = JSON.parse(readFileSync(join(p.flintNew(), jsonFiles(p.flintNew())[0]!), "utf-8"));
    const env = JSON.parse(wrapperRec.body);
    expect(env.from).toBe("ember");
    expect(env.body).toBe("reply from ember");
    expect(env.replyToId).toBe(THREAD);
    expect(env.signature).toMatch(/^ed25519:/);
  }, 40000);

  it("an inbound with no signed envelope id gets a signed but UNTHREADED reply (never an id the CLI would refuse)", async () => {
    writeFileSync(join(p.keys(), "ember.key"), Buffer.alloc(32, 0x0e));
    plantInbound("plain text, not an envelope");
    start(200);
    expect(await until(() => jsonFiles(p.flintNew()).length === 1)).toBe(true);
    expect(await until(() => lines(p.argvLog()).some((l) => l.startsWith("mail ack")))).toBe(true);
    const send = lines(p.argvLog()).find((l) => l.startsWith("mail send"))!;
    expect(send).toContain("--stdin");
    expect(send).not.toContain("--reply-to");
  }, 30000);
});
