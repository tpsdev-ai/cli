/**
 * mail-watch cli#1099: a `*.json` entry in new/ whose stat fails in either
 * listing (the scan's or the trim's) with an error other than ENOENT is that
 * entry's problem. Every successful listing of new/ (the scan and the trim)
 * updates the shared warning state; a name is warned once per continuous
 * observed failure, and again only after it is absent from, or stats
 * successfully on, a successful listing and then fails again. The readable
 * records beside it are still presented.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { linkSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchMail, type MailWatcher } from "../src/commands/mail-watch.js";
import { getInbox, sendMessage } from "../src/utils/mail.js";
import {
  buildSignedEnvelope,
  installStubFlairFetch,
  writeKeyFile,
  type StubFlair,
} from "./helpers/stub-flair.js";

afterEach(() => {
  mock.restore();
});

const AGENT = "agent-a";
const SENDER = "agent-b";
const AGENT_SEED = Buffer.alloc(32, 0x22);
const SENDER_SEED = Buffer.alloc(32, 0x33);
const SEEDS = { [AGENT]: AGENT_SEED, [SENDER]: SENDER_SEED };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Bounded poll: resolve when `cond` is true, else throw at `timeoutMs`. */
async function waitFor(cond: () => boolean, timeoutMs = 5000, describe?: () => string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${Date.now() - start}ms${describe ? `: ${describe()}` : ""}`);
    }
    await sleep(5);
  }
}

// Never fires an fs event.
const NO_FS_EVENTS = () => ({ close() {} });

const CASES = [
  {
    label: "ELOOP",
    code: "ELOOP",
    file: "loop.json",
    make: (fresh: string) => symlinkSync("loop.json", join(fresh, "loop.json")),
  },
  {
    label: "ENOTDIR",
    code: "ENOTDIR",
    file: "notdir.json",
    make: (fresh: string) => {
      writeFileSync(join(fresh, "blocker"), "not a directory");
      symlinkSync("blocker/child", join(fresh, "notdir.json"));
    },
  },
];

/** The one `*.json` name in new/: the record a case delivered. */
function onlyNewFileName(): string {
  const names = readdirSync(getInbox(AGENT).fresh).filter((f) => f.endsWith(".json"));
  expect(names).toHaveLength(1);
  return names[0]!;
}

/**
 * Make new/<name> unstatable without removing its inode: hard-link the record
 * aside, then atomically replace the name with a symlink that resolves to
 * itself (ELOOP). The name is never absent, so no scan can see a deletion.
 */
function makeUnstatable(fresh: string, name: string): string {
  const real = join(fresh, `${name}.real`);
  linkSync(join(fresh, name), real);
  const loop = join(fresh, `${name}.loop`);
  symlinkSync(name, loop);
  renameSync(loop, join(fresh, name));
  return real;
}

/** Replace an absent or free name with a self-symlink, with no stat-able window. */
function makeUnstatableName(fresh: string, name: string): void {
  const loop = join(fresh, `${name}.loop`);
  symlinkSync(name, loop);
  renameSync(loop, join(fresh, name));
}

/** Put the original inode back over the self-symlink in one rename. */
function restoreStatable(fresh: string, name: string, real: string): void {
  renameSync(real, join(fresh, name));
}

describe("watchMail: an unstat-able new/ entry", () => {
  let tempRoot = "";
  let keysDir = "";
  let stub: StubFlair;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "mail-watch-unstatable-"));
    keysDir = join(tempRoot, "keys");
    stub = installStubFlairFetch(SEEDS);
    writeKeyFile(keysDir, AGENT, AGENT_SEED);
    writeKeyFile(keysDir, SENDER, SENDER_SEED);

    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH"]) {
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

  for (const c of CASES) {
    it(`skips and names a ${c.label} entry beside a readable record`, async () => {
      const received: string[] = [];
      const lines: string[] = [];
      const logSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
      let polls = 0;
      let watcher: MailWatcher | undefined;
      try {
        watcher = watchMail({
          agent: AGENT,
          debounceMs: 20,
          pollMs: 25,
          watchImpl: NO_FS_EVENTS,
          onMessage: (msg) => { received.push(msg.id); },
          onPoll: () => { polls++; },
        });
        await sleep(60);

        const env = buildSignedEnvelope(SENDER, AGENT, `readable beside a ${c.label} entry`, SEEDS);
        sendMessage(AGENT, JSON.stringify(env), SENDER);
        c.make(getInbox(AGENT).fresh);

        // Give the watcher a few scans; it presents the readable record in one.
        const scannedAt = polls;
        await waitFor(() => received.length > 0 || polls - scannedAt >= 3, 5000, () => `log: ${lines.join(" | ")}`);
        expect(received).toEqual([env.messageId]);

        // The failing entry is named once, with its error code.
        const named = () => lines.filter((l) => l.includes(`${c.file} `) && l.includes(`(${c.code})`));
        await waitFor(() => named().length > 0 && polls >= 2, 5000, () => `log: ${lines.join(" | ")}`);
        expect(named()).toHaveLength(1);

        // Further scans neither re-present the record nor repeat the warning.
        const seenPolls = polls;
        await waitFor(() => polls - seenPolls >= 4, 5000);
        expect(received).toEqual([env.messageId]);
        expect(named()).toHaveLength(1);
      } finally {
        watcher?.stop();
        logSpy.mockRestore();
      }
    }, 10_000);
  }

  it("names an entry again when a listing stat failure stops and recurs, and does not name a dangling symlink", async () => {
    const received: string[] = [];
    const lines: string[] = [];
    const logSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    let polls = 0;
    let watcher: MailWatcher | undefined;
    try {
      watcher = watchMail({
        agent: AGENT,
        debounceMs: 20,
        pollMs: 25,
        watchImpl: NO_FS_EVENTS,
        onMessage: (msg) => { received.push(msg.id); },
        onPoll: () => { polls++; },
      });
      await sleep(60);

      const fresh = getInbox(AGENT).fresh;
      const env = buildSignedEnvelope(SENDER, AGENT, "readable beside the failing entries", SEEDS);
      sendMessage(AGENT, JSON.stringify(env), SENDER);
      writeFileSync(join(fresh, "blocked.json"), JSON.stringify(env));
      await waitFor(() => received.length > 0, 5000);

      // A dangling symlink is listed; its stat returns ENOENT, so it is dropped
      // without a warning and the readable record beside it is still presented.
      symlinkSync("missing-target.json", join(fresh, "dangling.json"));
      const beside = buildSignedEnvelope(SENDER, AGENT, "readable beside the dangling entry", SEEDS);
      sendMessage(AGENT, JSON.stringify(beside), SENDER);
      await waitFor(() => received.includes(beside.messageId), 5000, () => `log: ${lines.join(" | ")}`);

      const named = () => lines.filter((l) => l.includes("blocked.json ") && l.includes("(ELOOP)"));
      const real = makeUnstatable(fresh, "blocked.json");
      await waitFor(() => named().length === 1, 5000, () => `log: ${lines.join(" | ")}`);

      // Statable for observed scans: this clears the one-warning state.
      restoreStatable(fresh, "blocked.json", real);
      const restoredAt = polls;
      await waitFor(() => polls - restoredAt >= 3, 5000);

      // The same name fails again: a second warning.
      makeUnstatable(fresh, "blocked.json");
      await waitFor(() => named().length === 2, 5000, () => `log: ${lines.join(" | ")}`);

      expect(received).toContain(env.messageId);
      expect(received).toContain(beside.messageId);
      expect(lines.filter((l) => l.includes("dangling.json"))).toHaveLength(0);
    } finally {
      watcher?.stop();
      logSpy.mockRestore();
    }
  }, 15_000);

  it("names an entry again when a successful listing sees it absent, and not while it keeps failing", async () => {
    const received: string[] = [];
    const lines: string[] = [];
    const logSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    let polls = 0;
    let watcher: MailWatcher | undefined;
    try {
      watcher = watchMail({
        agent: AGENT,
        debounceMs: 20,
        pollMs: 25,
        watchImpl: NO_FS_EVENTS,
        onMessage: (msg) => { received.push(msg.id); },
        onPoll: () => { polls++; },
      });
      await sleep(60);

      const fresh = getInbox(AGENT).fresh;
      const env = buildSignedEnvelope(SENDER, AGENT, "readable beside the recurring entry", SEEDS);
      sendMessage(AGENT, JSON.stringify(env), SENDER);
      await waitFor(() => received.includes(env.messageId), 5000);

      writeFileSync(join(fresh, "blocked.json"), JSON.stringify(env));
      const named = () => lines.filter((l) => l.includes("blocked.json ") && l.includes("(ELOOP)"));
      const real = makeUnstatable(fresh, "blocked.json");
      await waitFor(() => named().length === 1, 5000, () => `log: ${lines.join(" | ")}`);

      // The name is gone entirely: the next successful listing sees it absent,
      // which ends the continuous failure even though no stat succeeded.
      rmSync(join(fresh, "blocked.json"));
      rmSync(real);
      const absentAt = polls;
      await waitFor(() => polls - absentAt >= 3, 5000);

      // The same name fails again: a second warning.
      makeUnstatableName(fresh, "blocked.json");
      await waitFor(() => named().length === 2, 5000, () => `log: ${lines.join(" | ")}`);

      // The failure persists across further listings: no third warning.
      const failingAt = polls;
      await waitFor(() => polls - failingAt >= 4, 5000);
      expect(named()).toHaveLength(2);
    } finally {
      watcher?.stop();
      logSpy.mockRestore();
    }
  }, 15_000);

  it("keeps a presented filename's dedup state while it is unstatable and after it is restored", async () => {
    const received: string[] = [];
    let polls = 0;
    let watcher: MailWatcher | undefined;
    try {
      watcher = watchMail({
        agent: AGENT,
        debounceMs: 20,
        pollMs: 25,
        watchImpl: NO_FS_EVENTS,
        onPoll: () => { polls++; },
        onMessage: (msg) => { received.push(msg.id); },
      });
      await sleep(60);

      const env = buildSignedEnvelope(SENDER, AGENT, "presented before the stat failure", SEEDS);
      const fresh = getInbox(AGENT).fresh;
      sendMessage(AGENT, JSON.stringify(env), SENDER);
      const name = onlyNewFileName();
      await waitFor(() => received.length > 0, 5000);

      // The SAME filename is unstatable across several scans, then restored.
      const real = makeUnstatable(fresh, name);
      const unstatableAt = polls;
      await waitFor(() => polls - unstatableAt >= 4, 5000);
      restoreStatable(fresh, name, real);
      const restoredAt = polls;
      await waitFor(() => polls - restoredAt >= 4, 5000);

      expect(received).toEqual([env.messageId]);
    } finally {
      watcher?.stop();
    }
  }, 15_000);

  it("names an entry that fails only at the trim listing once, and keeps the record", async () => {
    const received: string[] = [];
    const lines: string[] = [];
    const logSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    let polls = 0;
    let fresh = "";
    let name = "";
    let real = "";
    let mutated = false;
    let watcher: MailWatcher | undefined;
    try {
      fresh = getInbox(AGENT).fresh;
      watcher = watchMail({
        agent: AGENT,
        debounceMs: 20,
        pollMs: 25,
        watchImpl: NO_FS_EVENTS,
        onPoll: () => { polls++; },
        beforeVerify: async () => {
          if (mutated || name === "") return;
          mutated = true;
          real = makeUnstatable(fresh, name);
        },
        onMessage: (msg) => { received.push(msg.id); },
      });
      await sleep(60);

      const env = buildSignedEnvelope(SENDER, AGENT, "unstatable only at the trim listing", SEEDS);
      sendMessage(AGENT, JSON.stringify(env), SENDER);
      name = onlyNewFileName();

      // Statable in the scan's listing, so the record is delivered; delivery
      // follows the trim listing, so restoring now leaves the failure to it.
      await waitFor(() => received.length > 0, 5000, () => `log: ${lines.join(" | ")}`);
      expect(real).not.toBe("");
      restoreStatable(fresh, name, real);

      const named = () => lines.filter((l) => l.includes(`${name} `) && l.includes("(ELOOP)"));
      await waitFor(() => named().length === 1, 5000, () => `log: ${lines.join(" | ")}`);
      const restoredAt = polls;
      await waitFor(() => polls - restoredAt >= 4, 5000);
      expect(named()).toHaveLength(1);
      expect(received).toEqual([env.messageId]);
    } finally {
      watcher?.stop();
      logSpy.mockRestore();
    }
  }, 15_000);

  it("does not name a trim-listing failure twice while it continues", async () => {
    const received: string[] = [];
    const lines: string[] = [];
    const logSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    let polls = 0;
    let fresh = "";
    let name = "";
    let real = "";
    let mutated = false;
    let watcher: MailWatcher | undefined;
    try {
      fresh = getInbox(AGENT).fresh;
      watcher = watchMail({
        agent: AGENT,
        debounceMs: 20,
        pollMs: 25,
        watchImpl: NO_FS_EVENTS,
        onPoll: () => { polls++; },
        beforeVerify: async () => {
          if (mutated || name === "") return;
          mutated = true;
          real = makeUnstatable(fresh, name);
        },
        onMessage: (msg) => { received.push(msg.id); },
      });
      await sleep(60);

      const env = buildSignedEnvelope(SENDER, AGENT, "still unstatable at the next scan", SEEDS);
      sendMessage(AGENT, JSON.stringify(env), SENDER);
      name = onlyNewFileName();

      await waitFor(() => received.length > 0, 5000, () => `log: ${lines.join(" | ")}`);
      expect(real).not.toBe("");

      // The trim listing names it; the same failure at the next scan does not.
      const named = () => lines.filter((l) => l.includes(`${name} `) && l.includes("(ELOOP)"));
      await waitFor(() => named().length === 1, 5000, () => `log: ${lines.join(" | ")}`);
      const warnedAt = polls;
      await waitFor(() => polls - warnedAt >= 4, 5000);
      expect(named()).toHaveLength(1);

      restoreStatable(fresh, name, real);
      expect(received).toEqual([env.messageId]);
    } finally {
      watcher?.stop();
      logSpy.mockRestore();
    }
  }, 15_000);

  it("keeps a presented filename's dedup state when it turns unstatable before the trim listing", async () => {
    const received: string[] = [];
    let polls = 0;
    let fresh = "";
    let name = "";
    let real = "";
    let mutated = false;
    let watcher: MailWatcher | undefined;
    try {
      fresh = getInbox(AGENT).fresh;
      watcher = watchMail({
        agent: AGENT,
        debounceMs: 20,
        pollMs: 25,
        watchImpl: NO_FS_EVENTS,
        onPoll: () => { polls++; },
        beforeVerify: async () => {
          if (mutated) return;
          mutated = true;
          real = makeUnstatable(fresh, name);
        },
        onMessage: (msg) => { received.push(msg.id); },
      });
      await sleep(60);

      const env = buildSignedEnvelope(SENDER, AGENT, "unstatable before the trim listing", SEEDS);
      sendMessage(AGENT, JSON.stringify(env), SENDER);
      name = onlyNewFileName();

      // Presented, while the same scan's trim listing could not stat the name.
      await waitFor(() => received.length > 0, 5000);
      expect(real).not.toBe("");
      restoreStatable(fresh, name, real);
      const restoredAt = polls;
      await waitFor(() => polls - restoredAt >= 4, 5000);

      expect(received).toEqual([env.messageId]);
    } finally {
      watcher?.stop();
    }
  }, 15_000);

  it("names a trim-listing failure once when a new readable record arrives before the rescan", async () => {
    const received: string[] = [];
    const lines: string[] = [];
    const logSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    let polls = 0;
    let fresh = "";
    const name = "other.json";
    let real = "";
    let restored = false;
    let arrived: ReturnType<typeof buildSignedEnvelope> | undefined;
    let watcher: MailWatcher | undefined;
    try {
      fresh = getInbox(AGENT).fresh;
      watcher = watchMail({
        agent: AGENT,
        debounceMs: 20,
        pollMs: 25,
        watchImpl: NO_FS_EVENTS,
        onPoll: () => { polls++; },
        beforeVerify: async () => {
          if (arrived !== undefined) return;
          // Another entry, unstatable only at this pass's trim listing.
          const other = buildSignedEnvelope(SENDER, AGENT, "entry seen only at the trim listing", SEEDS);
          writeFileSync(join(fresh, name), JSON.stringify(other));
          real = makeUnstatable(fresh, name);
          // A readable record arrives during the awaited verification.
          arrived = buildSignedEnvelope(SENDER, AGENT, "readable record that triggers the rescan", SEEDS);
          sendMessage(AGENT, JSON.stringify(arrived), SENDER);
        },
        onMessage: (msg) => {
          received.push(msg.id);
          // After the trim listing, before the rescan: the other entry stats again.
          if (!restored && real !== "") { restored = true; restoreStatable(fresh, name, real); }
        },
      });
      await sleep(60);

      const env = buildSignedEnvelope(SENDER, AGENT, "anchor verified while the other entry fails at trim", SEEDS);
      sendMessage(AGENT, JSON.stringify(env), SENDER);
      await waitFor(() => restored, 5000, () => `log: ${lines.join(" | ")}`);

      const named = () => lines.filter((l) => l.includes(`${name} `) && l.includes("(ELOOP)"));
      await waitFor(() => named().length === 1, 5000, () => `log: ${lines.join(" | ")}`);
      const warnedAt = polls;
      await waitFor(() => polls - warnedAt >= 4, 5000);
      expect(named()).toHaveLength(1);
      expect(received).toContain(env.messageId);
      expect(received).toContain(arrived!.messageId);
    } finally {
      watcher?.stop();
      logSpy.mockRestore();
    }
  }, 15_000);

  it("warns again when a warned name stats at trim, a new identity returns, then it fails before the rescan", async () => {
    const received: string[] = [];
    const lines: string[] = [];
    const logSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    let polls = 0;
    let fresh = "";
    const name = "other.json";
    let real = "";
    let restored = false;
    let rebroken = false;
    let watcher: MailWatcher | undefined;
    try {
      fresh = getInbox(AGENT).fresh;
      const other = buildSignedEnvelope(SENDER, AGENT, "entry that fails again before the rescan", SEEDS);
      writeFileSync(join(fresh, name), JSON.stringify(other));
      real = makeUnstatable(fresh, name);
      watcher = watchMail({
        agent: AGENT,
        debounceMs: 20,
        pollMs: 25,
        watchImpl: NO_FS_EVENTS,
        onPoll: () => { polls++; },
        beforeVerify: async () => {
          if (restored) return;
          // This pass's trim listing stats the name again.
          restoreStatable(fresh, name, real);
          restored = true;
          const arrived = buildSignedEnvelope(SENDER, AGENT, "new identity during verification", SEEDS);
          sendMessage(AGENT, JSON.stringify(arrived), SENDER);
        },
        onMessage: (msg) => {
          received.push(msg.id);
          // After the trim listing, before the rescan: the name fails again.
          if (restored && !rebroken) { rebroken = true; real = makeUnstatable(fresh, name); }
        },
      });
      await sleep(60);

      const named = () => lines.filter((l) => l.includes(`${name} `) && l.includes("(ELOOP)"));
      // First warning: the name fails in a scan listing.
      await waitFor(() => named().length === 1, 5000, () => `log: ${lines.join(" | ")}`);

      const env = buildSignedEnvelope(SENDER, AGENT, "anchor verified while the other entry stats at trim", SEEDS);
      sendMessage(AGENT, JSON.stringify(env), SENDER);
      await waitFor(() => named().length === 2, 5000, () => `log: ${lines.join(" | ")}`);
      const warnedAt = polls;
      await waitFor(() => polls - warnedAt >= 4, 5000);
      expect(named()).toHaveLength(2);
      expect(received).toContain(env.messageId);
    } finally {
      watcher?.stop();
      logSpy.mockRestore();
    }
  }, 15_000);
});
