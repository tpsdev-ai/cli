/**
 * tier-gate.test.ts — the pi-tps-mail watcher honours the SIGNED tier
 * (cli#433 slice B2-1).
 *
 * The watcher dispatches ONLY what `tps mail check --json` verifies. This suite
 * pins that an external-tier record is NOT dispatched (the launcher never runs,
 * no reply is sent), while a record with no signed claim is unchanged. Fails
 * against origin/main, where the watcher never read the signed tier.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSignedEnvelope, startStubFlair, type StubFlair } from "../../cli/test/helpers/stub-flair.js";
import { watchMail } from "../src/index.js";

const TPS_TS = resolve(import.meta.dir, "../../cli/bin/tps.ts");
const FLINT_SEED = Buffer.alloc(32, 0x61); // the sender
const EMBER_SEED = Buffer.alloc(32, 0x62); // the watched agent
const ENV_KEYS = ["HOME", "TPS_MAIL_DIR", "TPS_TEST_KEYS_DIR", "TPS_BIN", "TPS_VAULT_KEY", "TPS_AGENT_ID", "FLAIR_URL", "FLAIR_KEY_PATH"] as const;

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
  stub = startStubFlair({ flint: FLINT_SEED, ember: EMBER_SEED });

  // The launcher records each call and answers with a fixed reply.
  writeFileSync(p.launcher(), `#!/bin/sh\nprintf 'call %s\\n' "$1" >> "${p.launcherLog()}"\nprintf 'reply from ember'\n`);
  chmodSync(p.launcher(), 0o755);

  const bun = process.execPath;
  const wrapper = join(root, "tps-wrapper.sh");
  writeFileSync(wrapper, ["#!/bin/sh", `echo "$*" >> "${p.argvLog()}"`, `exec "${bun}" "${TPS_TS}" "$@"`, ""].join("\n"));
  chmodSync(wrapper, 0o755);

  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
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
function plantInbound(trust: string | undefined): void {
  const envelopeBody = JSON.stringify(
    buildSignedEnvelope("flint", "ember", "please answer", { flint: FLINT_SEED }, trust === undefined ? {} : { trust }),
  );
  writeFileSync(
    join(p.emberNew(), "2026-09-28T00-00-00-in-1.json"),
    JSON.stringify({ id: "in-1", from: "flint", to: "ember", body: envelopeBody, timestamp: new Date().toISOString(), read: false }),
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
