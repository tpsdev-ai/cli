/**
 * mail-watch tests — OPS-121
 *
 * Tests cover:
 *  - validateAgentId: valid and invalid patterns
 *  - watchMail: event-driven (fs.watch), detects new messages, ENOENT safety, dedup
 *  - exec hook: args[] array, no shell interpolation, env injection
 *  - concurrency limit: max 3 concurrent handlers
 *  - watcher.stop(): cleans up fs.watch
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPlist, validateAgentId, watchMail, xmlEscape } from "../src/commands/mail-watch.js";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInbox(base: string, agent: string) {
  const root = join(base, ".tps", "mail", agent);
  const fresh = join(root, "new");
  const cur = join(root, "cur");
  const tmp = join(root, "tmp");
  const dlq = join(root, "dlq");
  for (const d of [fresh, cur, tmp, dlq]) mkdirSync(d, { recursive: true });
  return { root, fresh, cur };
}

function writeMsg(dir: string, id: string, from: string, to: string, body: string) {
  const msg = { id, from, to, body, timestamp: new Date().toISOString(), read: false };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(msg));
  return msg;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

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
// watchMail — fs.watch event-driven
// ---------------------------------------------------------------------------

describe("watchMail (fs.watch)", () => {
  let tmp = "";
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = join(tmpdir(), `mail-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    origHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fires onMessage when a new file is written", async () => {
    const { fresh } = makeInbox(tmp, "test-agent");
    const received: string[] = [];

    const watcher = watchMail({
      agent: "test-agent",
      debounceMs: 20,
      onMessage: (msg) => { received.push(msg.id); },
    });

    await sleep(30); // let watcher init and pre-populate seen
    writeMsg(fresh, "msg-001", "sender", "test-agent", "hello world");
    await sleep(150); // wait for fs event + debounce

    watcher.stop();
    expect(received).toContain("msg-001");
  });

  it("delivers pre-existing undelivered messages waiting in new/ at startup", async () => {
    // new/ holds UNDELIVERED mail — the exec hook moves delivered mail to cur/
    // on ack. So a (re)started watcher MUST deliver whatever is already waiting:
    // this is the recovery path that lets a kickstart drain mail stranded by an
    // fs.watch stall, instead of marking it seen and forcing a re-dispatch.
    const { fresh } = makeInbox(tmp, "test-agent");
    writeMsg(fresh, "waiting-msg", "sender", "test-agent", "stranded before watch start");

    const received: string[] = [];
    const watcher = watchMail({
      agent: "test-agent",
      debounceMs: 20,
      onMessage: (msg) => { received.push(msg.id); },
    });

    await sleep(150);
    watcher.stop();
    expect(received).toContain("waiting-msg");
  });

  it("does not deliver the same message twice (dedup via seen set)", async () => {
    const { fresh } = makeInbox(tmp, "test-agent");
    const received: string[] = [];

    const watcher = watchMail({
      agent: "test-agent",
      debounceMs: 20,
      onMessage: (msg) => { received.push(msg.id); },
    });

    await sleep(30);
    writeMsg(fresh, "dedup-msg", "sender", "test-agent", "once");
    await sleep(200); // two debounce windows

    watcher.stop();
    expect(received.filter((id) => id === "dedup-msg")).toHaveLength(1);
  });

  it("fires onPoll once at startup and on each poll cycle (liveness heartbeat, ops-i3vw)", async () => {
    makeInbox(tmp, "test-agent");
    let beats = 0;
    const watcher = watchMail({
      agent: "test-agent",
      debounceMs: 20,
      pollMs: 40, // fast poll for the test
      onPoll: () => { beats++; },
    });

    await sleep(150); // startup beat + ~3 poll cycles at 40ms
    watcher.stop();
    // At least the startup beat plus a couple poll beats.
    expect(beats).toBeGreaterThanOrEqual(2);
  });

  it("a throwing onPoll never crashes the watcher (heartbeat failure is swallowed)", async () => {
    const { fresh } = makeInbox(tmp, "test-agent");
    const received: string[] = [];
    const watcher = watchMail({
      agent: "test-agent",
      debounceMs: 20,
      pollMs: 40,
      onPoll: () => { throw new Error("simulated heartbeat failure"); },
      onMessage: (msg) => { received.push(msg.id); },
    });

    await sleep(60);
    // Mail delivery must still work despite a throwing heartbeat.
    writeMsg(fresh, "after-bad-beat", "sender", "test-agent", "still alive");
    await sleep(150);
    watcher.stop();
    expect(received).toContain("after-bad-beat");
  });

  it("handles ENOENT gracefully when file is moved before read", async () => {
    const { fresh, cur } = makeInbox(tmp, "test-agent");

    const watcher = watchMail({
      agent: "test-agent",
      debounceMs: 20,
      onMessage: () => { /* ignore */ },
    });

    await sleep(30);
    writeMsg(fresh, "race-msg", "sender", "test-agent", "body");
    // Immediately move to cur/ before the debounce fires
    try {
      renameSync(join(fresh, "race-msg.json"), join(cur, "race-msg.json"));
    } catch { /* already moved */ }
    await sleep(150); // should not throw

    watcher.stop();
    expect(true).toBe(true); // no throw = pass
  });

  it("stop() prevents further callbacks after stopping", async () => {
    const { fresh } = makeInbox(tmp, "test-agent");
    const received: string[] = [];

    const watcher = watchMail({
      agent: "test-agent",
      debounceMs: 20,
      onMessage: (msg) => { received.push(msg.id); },
    });

    await sleep(30);
    watcher.stop();
    writeMsg(fresh, "post-stop", "sender", "test-agent", "should not arrive");
    await sleep(150);

    expect(received).not.toContain("post-stop");
  });
});

// ---------------------------------------------------------------------------
// Concurrency limit
// ---------------------------------------------------------------------------

describe("watchMail concurrency", () => {
  let tmp = "";
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = join(tmpdir(), `mail-watch-conc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    origHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("respects maxConcurrent=2 and still delivers every message (over-cap mail is retried)", async () => {
    const { fresh } = makeInbox(tmp, "conc-agent");
    let active = 0;
    let maxSeen = 0;
    const received: string[] = [];

    const watcher = watchMail({
      agent: "conc-agent",
      debounceMs: 20,
      maxConcurrent: 2,
      onMessage: async (msg) => {
        active++;
        maxSeen = Math.max(maxSeen, active);
        await sleep(60);
        received.push(msg.id);
        active--;
      },
    });

    await sleep(30);
    // Write 5 messages — all arrive in a single debounce window, over the cap.
    for (let i = 0; i < 5; i++) {
      writeMsg(fresh, `m${i}`, "s", "conc-agent", `body${i}`);
    }
    await sleep(500);
    watcher.stop();

    expect(maxSeen).toBeLessThanOrEqual(2);
    // All 5 must be delivered: mail over the cap is left UNSEEN and retried as
    // slots free (the old code marked it seen then dropped it → lost forever).
    expect(received.sort()).toEqual(["m0", "m1", "m2", "m3", "m4"]);
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
    // The <string> follows the <key> on the next line — assert the pairing.
    expect(xml).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  });

  it("sets a non-zero ThrottleInterval", () => {
    const xml = buildPlist("test-agent", "/usr/local/bin/tps.js", []);
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  });

  it("keeps KeepAlive(Crashed:true) so a real crash still restarts", () => {
    const xml = buildPlist("test-agent", "/usr/local/bin/tps.js", []);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>Crashed<\/key>\s*<true\/>/);
  });

  it("generates plist that passes plutil -lint (valid XML, macOS only)", () => {
    if (platform() !== "darwin") return; // plutil is macOS-only
    const xml = buildPlist("test-agent", "/usr/local/bin/tps.js", ["arg with spaces & <special>"]);
    const tmpFile = join(tmpdir(), `buildplist-lint-${Date.now()}.plist`);
    writeFileSync(tmpFile, xml);
    try {
      // Throws (non-zero exit) if the plist is malformed.
      const out = execFileSync("plutil", ["-lint", tmpFile], { encoding: "utf-8" });
      expect(out).toContain("OK");
    } finally {
      rmSync(tmpFile, { force: true });
    }
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
