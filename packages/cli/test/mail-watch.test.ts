/**
 * mail-watch tests — OPS-121 + cli#375 (verified-only, NON-CONSUMING watcher)
 *
 * Tests cover:
 *  - validateAgentId: valid and invalid patterns
 *  - watchMail: the hook/onMessage receive ONLY records that verify, and the
 *    watcher does NOT consume — it moves, leases and acks nothing; the source
 *    file stays in new/ and nothing appears in cur/. A record that does not
 *    verify is skipped, never presented.
 *  - the poll path is proven ALONE (fs events suppressed via a no-op watchImpl)
 *    and the event path is proven with the real fs.watch.
 *  - dedup is on the verified envelope id while the file stays in new/ (two
 *    files with the same signed id present once); within one watcher instance a
 *    message is presented again only after a scan observes its file absent from
 *    new/, and a failed new/ listing keeps that state.
 *  - concurrency limit: the default is 3 (the case below tests 2)
 *  - watcher.stop(): cleans up fs.watch
 *  - xmlEscape / buildPlist / daemon arg validation
 *
 * watchMail() now verifies in place through verifyRecordForMailbox(), which
 * constructs its Flair client unconditionally, so these tests stand up a stub
 * Flair and point FLAIR_URL/FLAIR_KEY_PATH at it.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { buildPlist, validateAgentId, watchMail, xmlEscape } from "../src/commands/mail-watch.js";
import { sendMessage, getInbox, type MailMessage } from "../src/utils/mail.js";
import {
  buildSignedEnvelope,
  startStubFlair,
  writeKeyFile,
  type StubFlair,
} from "./helpers/stub-flair.js";

const AGENT = "kern";
const FLINT_SEED = Buffer.alloc(32, 0x11);
const KERN_SEED = Buffer.alloc(32, 0x22);
const SEEDS = { flint: FLINT_SEED, kern: KERN_SEED };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Never fires an fs event, so only the poll timer can deliver.
const NO_FS_EVENTS = () => ({ close() {} });

// ---------------------------------------------------------------------------
// validateAgentId
// ---------------------------------------------------------------------------

describe("validateAgentId", () => {
  it("accepts valid agent IDs", () => {
    expect(() => validateAgentId("anvil")).not.toThrow();
    expect(() => validateAgentId("tps-anvil")).not.toThrow();
    expect(() => validateAgentId("agent.1")).not.toThrow();
    expect(() => validateAgentId("AGENT_99")).not.toThrow();
  });

  it("rejects IDs with shell-unsafe characters", () => {
    expect(() => validateAgentId("agent;rm")).toThrow(/Invalid agent ID/);
    expect(() => validateAgentId("../etc/passwd")).toThrow(/Invalid agent ID/);
    expect(() => validateAgentId("agent name")).toThrow(/Invalid agent ID/);
    expect(() => validateAgentId("agent$PWD")).toThrow(/Invalid agent ID/);
    expect(() => validateAgentId("")).toThrow(/Invalid agent ID/);
  });
});

// ---------------------------------------------------------------------------
// xmlEscape — plist injection prevention
// ---------------------------------------------------------------------------

describe("xmlEscape", () => {
  it("escapes & < > \" '", () => {
    expect(xmlEscape("a&b")).toBe("a&amp;b");
    expect(xmlEscape("a<b>c")).toBe("a&lt;b&gt;c");
    expect(xmlEscape('say "hi"')).toBe("say &quot;hi&quot;");
    expect(xmlEscape("it's")).toBe("it&apos;s");
  });

  it("passes through safe strings unchanged", () => {
    expect(xmlEscape("/usr/bin/tps")).toBe("/usr/bin/tps");
    expect(xmlEscape("tps-kern")).toBe("tps-kern");
  });

  it("escapes a malicious exec arg", () => {
    const evil = '</string></array><key>Foo</key><string>injected';
    const escaped = xmlEscape(evil);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).toContain("&lt;");
    expect(escaped).toContain("&gt;");
  });
});

// ---------------------------------------------------------------------------
// buildPlist — generated launchd plist shape (ops-bayh: idle-reap immunity)
// ---------------------------------------------------------------------------

describe("buildPlist", () => {
  it("sets ProcessType=Background so macOS does not idle-reap the watcher", () => {
    const xml = buildPlist("test-agent", "/usr/local/bin/tps.js", []);
    expect(xml).toContain("<key>ProcessType</key>");
    expect(xml).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  });

  it("sets a non-zero ThrottleInterval", () => {
    const xml = buildPlist("test-agent", "/usr/local/bin/tps.js", []);
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  });

  it("uses KeepAlive(SuccessfulExit:false) so a genuine crash still relaunches (cli#341 S1a)", () => {
    const xml = buildPlist("test-agent", "/usr/local/bin/tps.js", []);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  });

  it("asserts --sandbox-required and TPS_SUPERVISED on the agent-launching unit (cli#341 S1a)", () => {
    const xml = buildPlist("test-agent", "/usr/local/bin/tps.js", []);
    expect(xml).toContain("<string>--sandbox-required</string>");
    expect(xml).toMatch(/<key>TPS_SUPERVISED<\/key>\s*<string>1<\/string>/);
  });

  it("generates plist that passes plutil -lint (valid XML, macOS only)", () => {
    if (platform() !== "darwin") return; // plutil is macOS-only
    const xml = buildPlist("test-agent", "/usr/local/bin/tps.js", ["arg with spaces & <special>"]);
    const tmpFile = join(tmpdir(), `buildplist-lint-${Date.now()}.plist`);
    writeFileSync(tmpFile, xml);
    try {
      const out = execFileSync("plutil", ["-lint", tmpFile], { encoding: "utf-8" });
      expect(out).toContain("OK");
    } finally {
      rmSync(tmpFile, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// watchMail — only VERIFIED records reach the hook / onMessage (cli#375),
// and the watcher consumes NOTHING
// ---------------------------------------------------------------------------

/** Reads stdin to HOOK_OUT and the hook env to HOOK_ENV. */
const HOOK_SCRIPT =
  'const fs=require("fs");let d="";process.stdin.setEncoding("utf8");process.stdin.on("data",(c)=>{d+=c;});process.stdin.on("end",()=>{fs.writeFileSync(process.env.HOOK_OUT,d);fs.writeFileSync(process.env.HOOK_ENV,JSON.stringify({id:process.env.TPS_MAIL_ID,from:process.env.TPS_MAIL_FROM,to:process.env.TPS_MAIL_TO,timestamp:process.env.TPS_MAIL_TIMESTAMP}));});';

describe("watchMail (verified-only, non-consuming)", () => {
  let tempRoot = "";
  let keysDir = "";
  let stub: StubFlair;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "mail-watch-verified-"));
    keysDir = join(tempRoot, "keys");
    stub = startStubFlair(SEEDS);
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

  /** Deliver a real SIGNED envelope into new/; returns the envelope. */
  function deliverSigned(body: string, from = "flint", to = AGENT) {
    const env = buildSignedEnvelope(from, to, body, SEEDS);
    sendMessage(to, JSON.stringify(env), from);
    return env;
  }

  /** Drop a raw UNSIGNED record straight into new/. */
  function deliverUnsigned(body: string, id: string): void {
    writeRecord({ id, from: "flint", to: AGENT, body, timestamp: new Date().toISOString(), read: false });
  }

  /** Write an arbitrary raw record into new/. */
  function writeRecord(record: Record<string, unknown>): void {
    const inbox = getInbox(AGENT);
    writeFileSync(join(inbox.fresh, `${record.id}.json`), JSON.stringify(record));
  }

  function jsonFiles(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  }

  function hookCapturing(outFile: string, envFile: string) {
    return { args: [process.execPath, "-e", HOOK_SCRIPT], env: { HOOK_OUT: outFile, HOOK_ENV: envFile } };
  }

  it("poll path (fs events suppressed): a signed record delivered AFTER startup is presented, and new/ is left untouched", async () => {
    const received: string[] = [];
    let seenId: string | undefined;
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 30,
      watchImpl: NO_FS_EVENTS,
      onMessage: (msg) => { received.push(msg.body); seenId = msg.id; },
    });

    await sleep(60);
    const env = deliverSigned("poll delivered");
    await sleep(300);
    watcher.stop();

    expect(received).toContain("poll delivered");
    // The callback's id is the VERIFIED envelope id, not the unsigned wrapper id.
    expect(seenId).toBe(env.messageId);
    // NON-CONSUMING: the source file is still in new/, nothing in cur/.
    const inbox = getInbox(AGENT);
    expect(jsonFiles(inbox.fresh)).toHaveLength(1);
    expect(jsonFiles(inbox.cur)).toHaveLength(0);
  });

  it("poll path (fs events suppressed): an unsigned record delivered AFTER startup reaches NEITHER onMessage nor the hook", async () => {
    const received: string[] = [];
    const out = join(tempRoot, "unsigned-poll-hook.txt");
    const envOut = join(tempRoot, "unsigned-poll-env.json");
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 30,
      watchImpl: NO_FS_EVENTS,
      hook: hookCapturing(out, envOut),
      onMessage: (msg) => { received.push(msg.body); },
    });

    await sleep(60);
    deliverUnsigned("not signed", "unsigned-poll");
    await sleep(300);
    watcher.stop();

    expect(received).toEqual([]);
    expect(existsSync(out), "the hook never ran").toBe(false);
    // Still in new/ (the watcher consumed nothing), and not in cur/.
    const inbox = getInbox(AGENT);
    expect(jsonFiles(inbox.fresh)).toHaveLength(1);
    expect(jsonFiles(inbox.cur)).toHaveLength(0);
  });

  it("event path: a signed record delivered AFTER startup is presented", async () => {
    const received: string[] = [];
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      onMessage: (msg) => { received.push(msg.body); },
    });

    await sleep(60);
    deliverSigned("event delivered");
    await sleep(400);
    watcher.stop();

    expect(received).toContain("event delivered");
  });

  it("event path: an unsigned record reaches NEITHER onMessage nor the hook", async () => {
    const received: string[] = [];
    const out = join(tempRoot, "unsigned-event-hook.txt");
    const envOut = join(tempRoot, "unsigned-event-env.json");
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      hook: hookCapturing(out, envOut),
      onMessage: (msg) => { received.push(msg.body); },
    });

    await sleep(60);
    deliverUnsigned("event unsigned", "unsigned-event");
    await sleep(400);
    watcher.stop();

    expect(received).toEqual([]);
    expect(existsSync(out), "the hook never ran").toBe(false);
  });

  it("an envelope with an altered wrapper SENDER is never presented, and never launches the hook", async () => {
    const received: string[] = [];
    const out = join(tempRoot, "tampered-hook.txt");
    const envOut = join(tempRoot, "tampered-env.json");
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 30,
      hook: hookCapturing(out, envOut),
      onMessage: (msg) => { received.push(msg.body); },
    });

    await sleep(60);
    const env = buildSignedEnvelope("flint", AGENT, "tampered", SEEDS);
    // The signature is valid, but the wrapper SENDER differs from the signed
    // sender: the wrapper-sender↔signed-sender binding fails, so the record is
    // neither presented nor handed to the hook.
    writeRecord({
      id: "tampered-1",
      from: "someone-else",
      to: AGENT,
      body: JSON.stringify(env),
      timestamp: env.timestamp,
      read: false,
    });
    await sleep(300);
    watcher.stop();

    expect(received).toEqual([]);
    expect(existsSync(out), "the hook never ran").toBe(false);
  });

  it("presents a record ONCE while its file stays in new/ (dedup by envelope id)", async () => {
    const received: string[] = [];
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 30,
      onMessage: (msg) => { received.push(msg.body); },
    });

    await sleep(60);
    deliverSigned("once only");
    await sleep(400); // several poll cycles
    watcher.stop();

    expect(received.filter((b) => b === "once only")).toHaveLength(1);
  });

  it("dedups by the VERIFIED envelope id: two files bearing the same signed id are presented once", async () => {
    const received: string[] = [];
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 30,
      watchImpl: NO_FS_EVENTS,
      onMessage: (msg) => { received.push(msg.id); },
    });

    await sleep(60);
    const env = buildSignedEnvelope("flint", AGENT, "same id", SEEDS);
    const wrapper = (id: string) => ({
      id,
      from: "flint",
      to: AGENT,
      body: JSON.stringify(env),
      timestamp: env.timestamp,
      read: false,
    });
    writeRecord(wrapper("copy-A"));
    writeRecord(wrapper("copy-B"));
    await sleep(400);
    watcher.stop();

    // Two files, ONE verified envelope id → presented once.
    expect(received).toEqual([env.messageId]);
  });

  it("presents a message AGAIN after its file leaves and re-enters new/", async () => {
    const received: string[] = [];
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 30,
      onMessage: (msg) => { received.push(msg.body); },
    });

    await sleep(60);
    deliverSigned("redelivered");
    await sleep(250);
    expect(received.filter((b) => b === "redelivered")).toHaveLength(1);

    // The file leaves new/ (e.g. a consumer took it) — the watcher forgets it.
    const inbox = getInbox(AGENT);
    const [file] = jsonFiles(inbox.fresh);
    const bytes = readFileSync(join(inbox.fresh, file));
    rmSync(join(inbox.fresh, file));
    await sleep(120);

    // It re-enters new/ with the same envelope.
    writeFileSync(join(inbox.fresh, `re-${file}`), bytes);
    await sleep(300);
    watcher.stop();

    expect(received.filter((b) => b === "redelivered")).toHaveLength(2);
  });

  it("a transient new/ listing failure does not present a still-present file twice", async () => {
    const received: string[] = [];
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 30,
      watchImpl: NO_FS_EVENTS,
      onMessage: (msg) => { received.push(msg.id); },
    });
    await sleep(60);
    const env = deliverSigned("resilient");
    await sleep(200);
    expect(received).toEqual([env.messageId]);

    // Make one new/ LISTING fail while the file stays put. A failed read must not
    // be read as "every file left": the dedup state is kept, so the file is not
    // presented again when the listing recovers.
    const fresh = getInbox(AGENT).fresh;
    chmodSync(fresh, 0o000);
    try {
      await sleep(120);
    } finally {
      chmodSync(fresh, 0o755);
    }
    await sleep(200);
    watcher.stop();

    expect(received).toEqual([env.messageId]);
  }, 10_000);

  it("the hook receives the verified body and the four TPS_MAIL_* variables from verified fields, even when the unsigned wrapper id/headers are changed", async () => {
    const out = join(tempRoot, "hook-out.txt");
    const envOut = join(tempRoot, "hook-env.json");
    const cb: MailMessage[] = [];
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 30,
      watchImpl: NO_FS_EVENTS,
      onMessage: (msg) => { cb.push(msg); },
      hook: hookCapturing(out, envOut),
    });

    await sleep(60);
    const body = "hello — verified ✅\nsecond line";
    const env = buildSignedEnvelope("flint", AGENT, body, SEEDS);
    // The wrapper `id` and `headers` are UNSIGNED: changing them must not change
    // what reaches the hook.
    writeRecord({
      id: "wrapper-id-not-the-envelope-id",
      from: "flint",
      to: AGENT,
      body: JSON.stringify(env),
      timestamp: env.timestamp,
      read: false,
      headers: { "X-TPS-Trust": "operator", "X-TPS-Sender": "attacker" },
    });
    await sleep(400);
    watcher.stop();

    expect(existsSync(out), "the hook ran").toBe(true);
    expect(readFileSync(out, "utf-8")).toBe(body); // verified body, byte-identical
    const h = JSON.parse(readFileSync(envOut, "utf-8")) as {
      id: string;
      from: string;
      to: string;
      timestamp: string;
    };
    expect(h.id).toBe(env.messageId); // the VERIFIED envelope id
    expect(h.id).not.toBe("wrapper-id-not-the-envelope-id"); // never the wrapper id
    expect(h.from).toBe("flint");
    expect(h.to).toBe(AGENT); // the watched agent
    expect(h.timestamp).toBe(env.timestamp);

    // The callback projection carries the verified fields; the unsigned wrapper
    // `id`/`headers` above are absent.
    expect(cb).toHaveLength(1);
    expect(cb[0].id).toBe(env.messageId); // the VERIFIED envelope id
    expect(cb[0].from).toBe("flint");
    expect(cb[0].to).toBe(AGENT);
    expect(cb[0].body).toBe(body);
    expect(cb[0].timestamp).toBe(env.timestamp);
    expect(cb[0].id).not.toBe("wrapper-id-not-the-envelope-id"); // never the wrapper id
    expect("headers" in cb[0]).toBe(false); // the unsigned wrapper headers are dropped
  });

  it("stop() prevents further callbacks after stopping", async () => {
    const received: string[] = [];
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      onMessage: (msg) => { received.push(msg.body); },
    });

    await sleep(50);
    watcher.stop();
    deliverSigned("after stop");
    await sleep(300);

    expect(received).toEqual([]);
  });

  it("fires onPoll once at startup and on each poll cycle (liveness heartbeat, ops-i3vw)", async () => {
    let beats = 0;
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 40,
      onPoll: () => { beats++; },
    });

    await sleep(150);
    watcher.stop();
    expect(beats).toBeGreaterThanOrEqual(2);
  });

  it("a throwing onPoll never crashes the watcher (heartbeat failure is swallowed)", async () => {
    const received: string[] = [];
    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 40,
      onPoll: () => { throw new Error("simulated heartbeat failure"); },
      onMessage: (msg) => { received.push(msg.body); },
    });

    await sleep(60);
    deliverSigned("still alive");
    await sleep(400);
    watcher.stop();
    expect(received).toContain("still alive");
  });
});

// ---------------------------------------------------------------------------
// Concurrency limit
// ---------------------------------------------------------------------------

describe("watchMail concurrency", () => {
  let tempRoot = "";
  let keysDir = "";
  let stub: StubFlair;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "mail-watch-conc-"));
    keysDir = join(tempRoot, "keys");
    stub = startStubFlair(SEEDS);
    writeKeyFile(keysDir, AGENT, KERN_SEED);
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH"]) savedEnv[k] = process.env[k];
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

  it("respects maxConcurrent=2 and still presents every verified message (over-cap mail is queued)", async () => {
    let active = 0;
    let maxSeen = 0;
    const received: string[] = [];

    const watcher = watchMail({
      agent: AGENT,
      debounceMs: 20,
      pollMs: 30,
      watchImpl: () => ({ close() {} }),
      maxConcurrent: 2,
      onMessage: async (msg) => {
        active++;
        maxSeen = Math.max(maxSeen, active);
        await sleep(60);
        received.push(msg.body);
        active--;
      },
    });

    await sleep(60);
    for (let i = 0; i < 5; i++) {
      const env = buildSignedEnvelope("flint", AGENT, `body${i}`, SEEDS);
      sendMessage(AGENT, JSON.stringify(env), "flint");
    }
    await sleep(1000);
    watcher.stop();

    expect(maxSeen).toBeLessThanOrEqual(2);
    expect(received.sort()).toEqual(["body0", "body1", "body2", "body3", "body4"]);
  });
});

// ---------------------------------------------------------------------------
// Daemon install (macOS only — validates args without actually calling launchctl)
// ---------------------------------------------------------------------------

describe("installDaemon / uninstallDaemon arg validation", () => {
  it("installDaemon throws on invalid agent ID", () => {
    const { installDaemon } = require("../src/commands/mail-watch.js");
    expect(() => installDaemon("agent;rm -rf")).toThrow(/Invalid agent ID/);
  });

  it("uninstallDaemon throws on invalid agent ID", () => {
    const { uninstallDaemon } = require("../src/commands/mail-watch.js");
    expect(() => uninstallDaemon("../../etc/passwd")).toThrow(/Invalid agent ID/);
  });
});
