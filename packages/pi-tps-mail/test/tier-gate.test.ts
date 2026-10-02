import { startFetchFlair } from "../../cli/test/helpers/fetch-flair.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSignedEnvelope, type StubFlair } from "../../cli/test/helpers/stub-flair.js";
import { watchMail } from "../src/index.js";

const TPS_TS = resolve(import.meta.dir, "../../cli/test/helpers/cli-fetch-driver.ts");
const FLINT_SEED = Buffer.alloc(32, 0x61); // the sender
const EMBER_SEED = Buffer.alloc(32, 0x62); // the watched agent
const ENV_KEYS = ["HOME", "TPS_MAIL_DIR", "TPS_TEST_KEYS_DIR", "TPS_BIN", "TPS_VAULT_KEY", "TPS_AGENT_ID", "FLAIR_URL", "FLAIR_KEY_PATH", "TEST_FLAIR_SEEDS"] as const;

let root: string;
let stub: StubFlair;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let stop: (() => Promise<void>) | null = null;

const p = {
  mail: () => join(root, ".tps", "mail"),
  emberNew: () => join(root, ".tps", "mail", "ember", "new"),
  keys: () => join(root, "keys"),
  argvLog: () => join(root, "tps-argv.log"),
  launcherLog: () => join(root, "agents", "ember", "launcher-calls.log"),
  launcher: () => join(root, "agents", "ember", "bin", "ember"),
};

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean) : [];
}
async function until(pred: () => boolean, ms = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-tps-mail-tier-"));
  mkdirSync(p.emberNew(), { recursive: true });
  mkdirSync(p.keys(), { recursive: true });
  mkdirSync(join(root, "agents", "ember", "bin"), { recursive: true });
  writeFileSync(join(root, "flair-auth.key"), Buffer.alloc(32, 0x6c));
  stub = startFetchFlair({ flint: FLINT_SEED, ember: EMBER_SEED, "openclaw-bridge": FLINT_SEED });

  // The launcher records each call and answers with a fixed reply.
  writeFileSync(p.launcher(), `#!/bin/sh\nprintf 'call %s\\n' "$1" >> "${p.launcherLog()}"\nprintf 'reply from ember'\n`);
  chmodSync(p.launcher(), 0o755);

  const bun = process.execPath;
  const wrapper = join(root, "tps-wrapper.sh");
  writeFileSync(wrapper, ["#!/bin/sh", `echo "$*" >> "${p.argvLog()}"`, `exec "${bun}" "${TPS_TS}" "$@"`, ""].join("\n"));
  chmodSync(wrapper, 0o755);

  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.TEST_FLAIR_SEEDS = join(root, "seeds.json");
  writeFileSync(process.env.TEST_FLAIR_SEEDS, JSON.stringify({ flint: FLINT_SEED.toString("hex"), ember: EMBER_SEED.toString("hex"), "openclaw-bridge": FLINT_SEED.toString("hex") }));
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = p.mail();
  process.env.TPS_TEST_KEYS_DIR = p.keys();
  process.env.TPS_BIN = wrapper;
  process.env.TPS_VAULT_KEY = "test-vault-key";
  process.env.FLAIR_URL = stub.url;
  process.env.FLAIR_KEY_PATH = join(root, "flair-auth.key");
  delete process.env.TPS_AGENT_ID;
});

afterEach(async () => {
  await stop?.();
  stop = null;
  stub.stop();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

/** Plant a genuine inbound in ember's new/, optionally with a signed trust claim. */
function plantInbound(trust: string | undefined, from = "flint"): void {
  const envelopeBody = JSON.stringify(
    buildSignedEnvelope(from, "ember", "please answer", { [from]: FLINT_SEED }, { messageId: "in-envelope", ...(trust === undefined ? {} : { trust }) }),
  );
  writeFileSync(
    join(p.emberNew(), "2026-09-28T00-00-00-in-1.json"),
    JSON.stringify({ id: "in-1", from, to: "ember", body: envelopeBody, timestamp: new Date().toISOString(), read: false }),
  );
}

function start(): void {
  const w = watchMail({
    agent: "ember",
    inboxRoot: root,
    launcher: p.launcher(),
    timeoutMs: 10_000,
    pollIntervalMs: 50,
    rescanIntervalMs: 50,
  });
  stop = async () => {
    w.stop();
    await w.drain();
  };
}

describe("pi-tps-mail watcher honours the signed tier (cli#433 slice B2-1)", () => {
  it("does not dispatch external-tier mail: the launcher never runs and no reply is sent", async () => {
    plantInbound("external");
    start();

    // Give the watcher several poll cycles to (wrongly) dispatch.
    await until(() => lines(p.argvLog()).filter((l) => l.startsWith("mail send")).length > 0, 2000);
    expect(lines(p.launcherLog())).toEqual([]);
    expect(lines(p.argvLog()).filter((l) => l.startsWith("mail send"))).toEqual([]);
  });

  it("dispatches a record with no signed tier claim (unchanged behaviour)", async () => {
    plantInbound(undefined);
    start();

    const dispatched = await until(() => lines(p.launcherLog()).length > 0, 8000);
    expect(dispatched).toBe(true);
  });
});

for (const state of ["prepared", "sent"] as const) {
  it(`does not recover an external-tier ${state} reply journal: no send or ack`, async () => {
    plantInbound("external");
    const dir = join(p.mail(), "ember", ".pi-tps-mail", "replies");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "in-1.json"), JSON.stringify({
      v: 1, inboundId: "in-1", to: "flint", threadId: "in-envelope", reply: "old reply",
      replyMessageId: "old-reply", state, attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    start();
    await until(() => lines(p.argvLog()).some((line) => line.startsWith("mail send") || line.startsWith("mail ack")), 1000);
    expect(lines(p.argvLog()).filter((line) => line.startsWith("mail send") || line.startsWith("mail ack"))).toEqual([]);
    expect(lines(p.launcherLog())).toEqual([]);
    expect(existsSync(join(dir, "in-1.json"))).toBe(true);
  });
}

it("pi real dispatch refuses a bridge no-claim record after verified promotion", async () => {
  plantInbound(undefined, "openclaw-bridge");
  start();
  const cur = join(p.mail(), "ember", "cur", "2026-09-28T00-00-00-in-1.json");
  expect(await until(() => existsSync(cur), 3000)).toBe(true);
  await until(() => lines(p.launcherLog()).length > 0, 300);
  expect(JSON.parse(readFileSync(cur, "utf8")).trustTier).toBe("external");
  expect(lines(p.launcherLog())).toEqual([]);
  expect(lines(p.argvLog()).filter((line) => line.startsWith("mail send") || line.startsWith("mail ack"))).toEqual([]);
});

for (const state of ["prepared", "sent"] as const) {
  it(`does not recover a bridge-signed internal claim as internal from a ${state} journal`, async () => {
    plantInbound("internal", "openclaw-bridge");
    const proc = Bun.spawn([process.execPath, TPS_TS, "mail", "check", "ember", "--json"], {
      env: { ...process.env, TPS_AGENT_ID: "ember" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)[0].trustTier).toBe("external");
    const dir = join(p.mail(), "ember", ".pi-tps-mail", "replies");
    mkdirSync(dir, { recursive: true });
    const entry = {
      v: 1, inboundId: "in-1", to: "openclaw-bridge", threadId: "in-envelope", reply: "old reply",
      replyMessageId: "old-reply", state, attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(dir, "in-1.json"), JSON.stringify(entry));
    start();
    expect(await until(() => lines(p.argvLog()).filter((line) => line.startsWith("mail read")).length >= 2, 3000)).toBe(true);
    await stop?.();
    expect(lines(p.argvLog()).filter((line) => line.startsWith("mail send") || line.startsWith("mail ack"))).toEqual([]);
    expect(lines(p.launcherLog())).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "in-1.json"), "utf8"))).toEqual(entry);
    expect(existsSync(join(p.mail(), "ember", "cur", "2026-09-28T00-00-00-in-1.json"))).toBe(true);
  });
}
