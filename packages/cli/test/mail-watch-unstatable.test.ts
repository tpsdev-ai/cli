/**
 * mail-watch cli#1099: a `*.json` entry in new/ whose stat fails (ELOOP, ENOTDIR)
 * is that entry's problem. The watcher logs it once by name and still presents
 * the readable records beside it.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
});
