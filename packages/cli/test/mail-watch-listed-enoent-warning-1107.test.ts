/**
 * Audit verification (cli#1100 finding 1): the changelog promises an
 * unstatable new/ entry is named again ONLY after it is absent from, or stats
 * successfully on, a successful listing and then fails again. A name that stays
 * listed but whose stat returns ENOENT (a dangling symlink) is neither absent
 * nor statable, so it must not reset the one-warning state.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { linkSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchMail, type MailWatcher } from "../src/commands/mail-watch.js";
import { getInbox, sendMessage } from "../src/utils/mail.js";
import { buildSignedEnvelope, installStubFlairFetch, writeKeyFile, type StubFlair } from "./helpers/stub-flair.js";

afterEach(() => { mock.restore(); });

const AGENT = "agent-a";
const SENDER = "agent-b";
const AGENT_SEED = Buffer.alloc(32, 0x22);
const SENDER_SEED = Buffer.alloc(32, 0x33);
const SEEDS = { [AGENT]: AGENT_SEED, [SENDER]: SENDER_SEED };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 5000, describe?: () => string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out${describe ? `: ${describe()}` : ""}`);
    await sleep(5);
  }
}
const NO_FS_EVENTS = () => ({ close() {} });

/** Atomically replace new/<name> with a symlink to `target` (the name is never absent). */
function replaceWithSymlink(fresh: string, name: string, target: string, tag: string): void {
  const tmp = join(fresh, `${name}.${tag}`);
  symlinkSync(target, tmp);
  renameSync(tmp, join(fresh, name));
}

describe("verify f3: a listed ENOENT entry and the unstatable warning reset", () => {
  let tempRoot = "";
  let stub: StubFlair;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "verify-f3-"));
    const keysDir = join(tempRoot, "keys");
    stub = installStubFlairFetch(SEEDS);
    writeKeyFile(keysDir, AGENT, AGENT_SEED);
    writeKeyFile(keysDir, SENDER, SENDER_SEED);
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

  it("does not name an entry again when it stays listed with an ENOENT stat between two ELOOP failures", async () => {
    const received: string[] = [];
    const lines: string[] = [];
    const logSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    let polls = 0;
    let watcher: MailWatcher | undefined;
    try {
      watcher = watchMail({
        agent: AGENT, debounceMs: 20, pollMs: 25, watchImpl: NO_FS_EVENTS,
        onMessage: (msg) => { received.push(msg.id); },
        onPoll: () => { polls++; },
      });
      await sleep(60);
      const fresh = getInbox(AGENT).fresh;
      const env = buildSignedEnvelope(SENDER, AGENT, "readable beside the entry", SEEDS);
      sendMessage(AGENT, JSON.stringify(env), SENDER);
      await waitFor(() => received.includes(env.messageId), 5000);

      const named = () => lines.filter((l) => l.includes("blocked.json ") && l.includes("(ELOOP)"));
      // 1. ELOOP: named once.
      replaceWithSymlink(fresh, "blocked.json", "blocked.json", "loop");
      await waitFor(() => named().length === 1, 5000, () => `log: ${lines.join(" | ")}`);

      // 2. Same name, still listed, stat now ENOENT (dangling) for several scans.
      replaceWithSymlink(fresh, "blocked.json", "missing-target.json", "dangle");
      expect(readdirSync(fresh)).toContain("blocked.json");
      const danglingAt = polls;
      await waitFor(() => polls - danglingAt >= 4, 5000);
      expect(readdirSync(fresh)).toContain("blocked.json");

      // 3. Same name, ELOOP again, observed for several scans.
      replaceWithSymlink(fresh, "blocked.json", "blocked.json", "loop");
      const loopAgainAt = polls;
      await waitFor(() => polls - loopAgainAt >= 6, 5000);

      console.log(`[verify-f3] ELOOP warnings for blocked.json: ${named().length}; polls=${polls}; all lines: ${lines.length}`);
      // The name was never absent from a listing and never statted successfully,
      // so by the changelog's reset condition it is still one continuous failure.
      expect(named()).toHaveLength(1);
    } finally {
      watcher?.stop();
      logSpy.mockRestore();
    }
  }, 15_000);

  it("control: a real absence between the two failures does re-warn (the documented reset path)", async () => {
    const lines: string[] = [];
    const received: string[] = [];
    const logSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    let polls = 0;
    let watcher: MailWatcher | undefined;
    try {
      watcher = watchMail({
        agent: AGENT, debounceMs: 20, pollMs: 25, watchImpl: NO_FS_EVENTS,
        onMessage: (msg) => { received.push(msg.id); },
        onPoll: () => { polls++; },
      });
      await sleep(60);
      const fresh = getInbox(AGENT).fresh;
      const named = () => lines.filter((l) => l.includes("blocked.json ") && l.includes("(ELOOP)"));
      replaceWithSymlink(fresh, "blocked.json", "blocked.json", "loop");
      await waitFor(() => named().length === 1, 5000, () => `log: ${lines.join(" | ")}`);
      rmSync(join(fresh, "blocked.json"));
      const absentAt = polls;
      await waitFor(() => polls - absentAt >= 4, 5000);
      replaceWithSymlink(fresh, "blocked.json", "blocked.json", "loop");
      await waitFor(() => named().length === 2, 5000, () => `log: ${lines.join(" | ")}`);
      console.log(`[verify-f3] control absent-reset warnings: ${named().length}`);
      expect(named()).toHaveLength(2);
    } finally {
      watcher?.stop();
      logSpy.mockRestore();
    }
  }, 15_000);
});
