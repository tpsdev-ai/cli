import { startUnverifiedFetchFlair } from "./helpers/fetch-flair.js";
/**
 * mail-watch-tier.test.ts — `mail watch` hooks honour the SIGNED tier
 * (cli#433 slice B2-1).
 *
 * The watcher verifies each `new/` record in place; this suite pins that an
 * external-tier record is NOT presented (the hook does not run), while a record
 * with no signed claim is unchanged. Removing the watcher's externalDispatchRefusal
 * gate makes the external-tier assertions fail.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchMail } from "../src/commands/mail-watch.js";
import { getInbox } from "../src/utils/mail.js";
import { buildSignedEnvelope, writeKeyFile, type StubFlair } from "./helpers/stub-flair.js";

const AGENT = "kern";
const FLINT_SEED = Buffer.alloc(32, 0x51);
const KERN_SEED = Buffer.alloc(32, 0x52);
const SEEDS = { flint: FLINT_SEED, kern: KERN_SEED, "openclaw-bridge": Buffer.alloc(32, 0x53) };

const NO_FS_EVENTS = () => ({ close() {} });
const HOOK_SCRIPT =
  'const fs=require("fs");let d="";process.stdin.setEncoding("utf8");process.stdin.on("data",(c)=>{d+=c;});process.stdin.on("end",()=>{fs.writeFileSync(process.env.HOOK_OUT,d);});';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("mail watch honours the signed tier (cli#433 slice B2-1)", () => {
  let tempRoot = "";
  let keysDir = "";
  let stub: StubFlair;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "mail-watch-tier-"));
    keysDir = join(tempRoot, "keys");
    stub = startUnverifiedFetchFlair(SEEDS);
    writeKeyFile(keysDir, AGENT, KERN_SEED);
    writeKeyFile(keysDir, "flint", FLINT_SEED);

    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH", "TPS_AGENT_ID"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.HOME = tempRoot;
    process.env.TPS_MAIL_DIR = join(tempRoot, "mail");
    process.env.FLAIR_URL = stub.url;
    process.env.FLAIR_KEY_PATH = join(keysDir, `${AGENT}.key`);
  });

  afterEach(() => {
    stub.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  /** Plant a genuine signed envelope directly in new/ (the watcher is non-consuming). */
  function plant(trust: string | undefined): void {
    const env = buildSignedEnvelope("flint", AGENT, "watch body", SEEDS, trust === undefined ? {} : { trust });
    const inbox = getInbox(AGENT);
    writeFileSync(
      join(inbox.fresh, "in-1.json"),
      JSON.stringify({ id: "in-1", from: "flint", to: AGENT, body: JSON.stringify(env), timestamp: new Date().toISOString(), read: false }),
    );
  }

  function hookCapturing(outFile: string) {
    return { args: [process.execPath, "-e", HOOK_SCRIPT], env: { HOOK_OUT: outFile } };
  }

  it("does not present external-tier mail, and never runs the hook", async () => {
    const out = join(tempRoot, "external-hook.txt");
    const seen: string[] = [];
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 30,
      watchImpl: NO_FS_EVENTS,
      hook: hookCapturing(out),
      onMessage: (msg) => { seen.push(msg.body); },
    });

    await sleep(60);
    plant("external");
    await sleep(300);
    watcher.stop();

    expect(seen).toEqual([]);
    expect(existsSync(out), "the hook never ran").toBe(false);
  });

  it("presents a record with no signed tier claim (unchanged behaviour)", async () => {
    const out = join(tempRoot, "plain-hook.txt");
    const seen: string[] = [];
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 30,
      watchImpl: NO_FS_EVENTS,
      hook: hookCapturing(out),
      onMessage: (msg) => { seen.push(msg.body); },
    });

    await sleep(60);
    plant(undefined);
    await sleep(300);
    watcher.stop();

    expect(seen).toEqual(["watch body"]);
    expect(existsSync(out), "the hook ran").toBe(true);
  });
  it("a bridge no-claim record cannot run the actual hook", async () => {
    const out = join(tempRoot, "bridge-hook.txt");
    const seen: string[] = [];
    const watcher = watchMail({ agent: AGENT, debounceMs: 10, pollMs: 20, watchImpl: NO_FS_EVENTS,
      hook: hookCapturing(out), onMessage: (msg) => { seen.push(msg.body); } });
    try {
      const envelope = buildSignedEnvelope("openclaw-bridge", AGENT, "bridge body", SEEDS);
      writeFileSync(join(getInbox(AGENT).fresh, "bridge.json"), JSON.stringify({ id: "bridge", from: "openclaw-bridge",
        to: AGENT, body: JSON.stringify(envelope), timestamp: envelope.timestamp, read: false }));
      await sleep(300);
      expect(seen).toEqual([]);
      expect(existsSync(out)).toBe(false);
    } finally { watcher.stop(); }
  });

});
