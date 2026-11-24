/**
 * cli#1045 — a process start token is the same whichever environment reads it,
 * and a live lock owner is never reclaimed on a `ps:` mismatch alone.
 *
 * Where /proc is unavailable (macOS), processStartToken reads `ps -o lstart=`,
 * whose text follows the reader's TZ and locale unless the call pins them. The
 * cross-environment tests below send processStartToken to that `ps` fallback by
 * making `/proc/<pid>/stat` reads fail as absent — with test-only substitution
 * (test/helpers/start-token-source.mjs: a `node:fs` spy in this process, a
 * `--preload` in every child) — so they exercise it on Linux too, where
 * `ps -o lstart=` also exists. The production package has no hook for this.
 * The classifyOwnerToken and ownerState tests inject tokens and check the rule
 * identically on every platform.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnLiveProcess } from "../../../test/helpers/live-process.js";
import {
  forcePsStartTokens,
  PROC_START_TOKENS_PRELOAD,
  PS_START_TOKENS_BUN_ARGS,
  stageProcStartTokens,
} from "../../../test/helpers/start-token-source-test.js";
import {
  acquireMailLockSync,
  classifyOwnerToken,
  mailLockPath,
  ownerState,
  processIsGone,
  processStartToken,
} from "../src/lib/mail-lock.js";

const MAIL_LOCK_MODULE = fileURLToPath(new URL("../src/lib/mail-lock.ts", import.meta.url));

/** Program text a child runs first: import the lock module. Children default to PS_START_TOKENS_BUN_ARGS. */
const CHILD_PRELUDE = `
  import { acquireMailLock, acquireMailLockSync, processStartToken } from ${JSON.stringify(MAIL_LOCK_MODULE)};
`;

/** Reader environments: a local zone (never UTC-equal), UTC, and UTC with another locale. */
const PACIFIC_ENV = { ...process.env, TZ: "America/Los_Angeles" };
const UTC_ENV = { ...process.env, TZ: "UTC" };
const UTC_GERMAN_ENV = { ...process.env, TZ: "UTC", LC_ALL: "de_DE.UTF-8" };
const READER_ENVS = [PACIFIC_ENV, UTC_ENV, UTC_GERMAN_ENV];
/** An intentionally non-UTC POSIX zone (UTC+13:17). */
const ODD_ZONE_ENV = { ...process.env, TZ: "XST-13:17" };

/** `pid`'s token, read through the real processStartToken in a child started with `env` and `preloadArgs`. */
function tokenReadUnder(pid: number, env: NodeJS.ProcessEnv, preloadArgs: readonly string[] = PS_START_TOKENS_BUN_ARGS): string | null {
  const result = spawnSync(process.execPath, [...preloadArgs, "--eval", `${CHILD_PRELUDE}
    process.stdout.write(JSON.stringify(processStartToken(${pid})));
  `], { env, encoding: "utf-8", timeout: 20_000 });
  if (result.status !== 0) throw new Error(`token reader exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout) as string | null;
}

/** `ps -o lstart=` for `pid` as an unpinned reader in `env` renders it. */
function unpinnedLstart(pid: number, env: NodeJS.ProcessEnv): string {
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env, encoding: "utf-8", timeout: 5_000 }).trim();
}

/** A running child and its start token as this process reads it. */
async function liveChild(): Promise<{ child: ChildProcess; pid: number; token: string }> {
  const child = spawnLiveProcess();
  const pid = child.pid as number;
  expect(pid).toBeGreaterThan(0);
  let token: string | null = null;
  const deadline = Date.now() + 5_000;
  while (token === null && Date.now() < deadline) {
    token = processStartToken(pid);
    if (token === null) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  expect(token).not.toBeNull();
  return { child, pid, token: token as string };
}

/** A pid that has exited and been reaped by this process. */
function reapedPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 });
  expect(result.pid).toBeGreaterThan(0);
  return result.pid as number;
}

describe("test-only start-token source (no production hook)", () => {
  test("in this process, forcing ps gives a live pid a ps: token", async () => {
    forcePsStartTokens();
    const { child, pid, token } = await liveChild();
    try {
      expect(token).toMatch(/^ps:\S/);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("in this process, staging proc gives a live pid a proc: token", async () => {
    stageProcStartTokens();
    const { child, pid, token } = await liveChild();
    try {
      expect(token).toMatch(/^proc:\d+$/);
      expect(processStartToken(pid)).toBe(token);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("in a child, the ps preload gives a ps: token and the proc preload a proc: token", async () => {
    const { child, pid } = await liveChild();
    try {
      expect(tokenReadUnder(pid, UTC_ENV)).toMatch(/^ps:\S/);
      expect(tokenReadUnder(pid, UTC_ENV, ["--preload", PROC_START_TOKENS_PRELOAD])).toMatch(/^proc:\d+$/);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});

describe("processStartToken is the same whichever environment reads it", () => {
  test("one live pid read under different TZ and locale values yields one token", async () => {
    forcePsStartTokens();
    const { child, pid, token } = await liveChild();
    try {
      expect(token).toStartWith("ps:");
      // The readers really do render this pid differently without a pin, so the
      // equality below is a test that can fail.
      const unpinned = READER_ENVS.map((env) => unpinnedLstart(pid, env));
      expect(new Set(unpinned).size).toBeGreaterThan(1);
      const tokens = READER_ENVS.map((env) => tokenReadUnder(pid, env));
      expect(tokens).toEqual([token, token, token]);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a reader in a non-UTC odd-offset zone agrees with a reader in a local zone", async () => {
    forcePsStartTokens();
    const { child, pid, token } = await liveChild();
    try {
      expect(token).toStartWith("ps:");
      // The odd-offset reader's unpinned output is a different text, so its
      // pinned token below can only match by the pin.
      expect(`ps:${unpinnedLstart(pid, ODD_ZONE_ENV)}`).not.toBe(token);
      const odd = tokenReadUnder(pid, ODD_ZONE_ENV);
      const local = tokenReadUnder(pid, PACIFIC_ENV);
      expect([odd, local]).toEqual([token, token]);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);
});

describe("classifyOwnerToken: one rule for a live pid's current and recorded tokens", () => {
  const psA = "ps:Tue Nov 17 02:39:30 2026";
  const psB = "ps:Tue Nov 17 10:39:30 2026";

  test("equal tokens are alive, from either source", () => {
    expect(classifyOwnerToken(psA, psA)).toBe("alive");
    expect(classifyOwnerToken("proc:100", "proc:100")).toBe("alive");
  });

  test("differing ps: tokens are unverifiable", () => {
    expect(classifyOwnerToken(psB, psA)).toBe("unverifiable");
  });

  test("differing proc: tokens are dead (pid reuse)", () => {
    expect(classifyOwnerToken("proc:200", "proc:100")).toBe("dead");
  });

  test("tokens from different sources are unverifiable, either way round", () => {
    expect(classifyOwnerToken("proc:100", psA)).toBe("unverifiable");
    expect(classifyOwnerToken(psA, "proc:100")).toBe("unverifiable");
  });

  test("only proc: proves reuse: differing tokens of any other source are unverifiable", () => {
    expect(classifyOwnerToken("other:2", "other:1")).toBe("unverifiable");
    expect(classifyOwnerToken("2", "1")).toBe("unverifiable");
  });

  test("a bare proc label or an empty proc: value is unverifiable against a live proc: token", () => {
    expect(classifyOwnerToken("proc:4242", "proc")).toBe("unverifiable");
    expect(classifyOwnerToken("proc", "proc:4242")).toBe("unverifiable");
    expect(classifyOwnerToken("proc:4242", "proc:")).toBe("unverifiable");
  });

  test("a differing malformed recorded proc: value is unverifiable, not pid reuse", () => {
    expect(classifyOwnerToken("proc:4242", "proc:bogus")).toBe("unverifiable");
    expect(classifyOwnerToken("proc:4242", "proc:12x")).toBe("unverifiable");
    expect(classifyOwnerToken("proc:4242", "proc: 12")).toBe("unverifiable");
    expect(classifyOwnerToken("proc:4242", "proc:-1")).toBe("unverifiable");
  });

  test("equal malformed tokens are alive", () => {
    expect(classifyOwnerToken("proc:bogus", "proc:bogus")).toBe("alive");
  });
});

describe("ownerState: a live owner is never reclaimed on a ps: mismatch alone", () => {
  let child: ChildProcess;
  let livePid: number;
  beforeEach(async () => {
    ({ child, pid: livePid } = await liveChild());
  });
  afterEach(() => {
    child?.kill("SIGKILL");
  });

  const recorded = "ps:Tue Nov 17 02:39:30 2026";
  const current = "ps:Tue Nov 17 10:39:30 2026";

  test("a live pid whose ps: token differs is unverifiable, not dead", () => {
    expect(ownerState({ pid: livePid, startToken: recorded }, () => current)).toBe("unverifiable");
  });

  test("a live pid whose proc: token differs is dead (pid reuse)", () => {
    expect(ownerState({ pid: livePid, startToken: "proc:100" }, () => "proc:200")).toBe("dead");
  });

  test("a live pid whose token matches is alive, from either source", () => {
    expect(ownerState({ pid: livePid, startToken: current }, () => current)).toBe("alive");
    expect(ownerState({ pid: livePid, startToken: "proc:100" }, () => "proc:100")).toBe("alive");
  });

  test("a live pid with a token from the other source stays unverifiable", () => {
    expect(ownerState({ pid: livePid, startToken: "proc:100" }, () => current)).toBe("unverifiable");
    expect(ownerState({ pid: livePid, startToken: recorded }, () => "proc:100")).toBe("unverifiable");
  });

  test("a gone pid is dead whatever its token's source", () => {
    const pid = reapedPid();
    for (const startToken of [recorded, "proc:100", null]) {
      expect(ownerState({ pid, startToken }, () => current)).toBe("dead");
      expect(ownerState({ pid, startToken }, () => "proc:200")).toBe("dead");
      expect(ownerState({ pid, startToken }, () => null)).toBe("dead");
    }
    expect(processIsGone(pid, recorded)).toBe(true);
    expect(processIsGone(pid, "proc:100")).toBe(true);
  });
});

describe("a mail lock naming a live pid with a different ps: token", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mail-lock-1045-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("is kept, and the pid is not gone", async () => {
    forcePsStartTokens();
    const { child, pid, token } = await liveChild();
    try {
      expect(token).toStartWith("ps:");
      // The text an unpinned writer in an intentionally non-UTC zone would have
      // recorded for this same live process; it differs from the pinned UTC `ps:`
      // token (asserted below).
      const legacy = `ps:${unpinnedLstart(pid, ODD_ZONE_ENV)}`;
      expect(legacy).not.toBe(token);
      const owner = { pid, startToken: legacy, nonce: "planted" };
      mkdirSync(mailLockPath(root));
      const ownerFile = join(mailLockPath(root), "owner.json");
      writeFileSync(ownerFile, JSON.stringify(owner));

      const lock = acquireMailLockSync(root, { timeoutMs: 100 });
      try {
        expect(lock).toBeNull();
      } finally {
        lock?.release();
      }
      expect(JSON.parse(readFileSync(ownerFile, "utf-8"))).toEqual(owner);
      expect(processIsGone(pid, legacy)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 15_000);
});

describe("a live holder keeps the mail lock against a contender in another TZ", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mail-lock-1045-tz-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a contender started with TZ=UTC does not take a lock held by a live process started in America/Los_Angeles", async () => {
    const holder = spawn(process.execPath, [...PS_START_TOKENS_BUN_ARGS, "--eval", `${CHILD_PRELUDE}
      const lock = await acquireMailLock(${JSON.stringify(root)}, { timeoutMs: 5000 });
      if (!lock) { process.stdout.write("unavailable"); process.exit(2); }
      process.stdout.write("ready");
      process.stdin.resume();
      process.stdin.once("end", () => { lock.release(); process.exit(0); });
    `], { env: PACIFIC_ENV, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolveExit) => {
      holder.once("exit", resolveExit);
      holder.once("error", () => resolveExit(null));
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error("lock holder did not become ready in time")), 15_000);
        holder.once("error", (err) => { clearTimeout(timer); rejectReady(err); });
        holder.once("exit", (code) => { clearTimeout(timer); rejectReady(new Error(`lock holder exited before readiness (code ${code})`)); });
        holder.stdout?.once("data", (chunk) => {
          clearTimeout(timer);
          const line = chunk.toString();
          if (line === "ready") resolveReady();
          else rejectReady(new Error(`lock holder signalled ${JSON.stringify(line)}`));
        });
      });

      const owner = JSON.parse(readFileSync(join(mailLockPath(root), "owner.json"), "utf-8")) as { pid: unknown; startToken: unknown };
      expect(owner.startToken).toEqual(expect.stringMatching(/^ps:/));

      const contender = spawnSync(process.execPath, [...PS_START_TOKENS_BUN_ARGS, "--eval", `${CHILD_PRELUDE}
        const lock = acquireMailLockSync(${JSON.stringify(root)}, { timeoutMs: 500 });
        if (lock) { lock.release(); process.stdout.write("acquired"); }
        else process.stdout.write("refused");
      `], { env: UTC_ENV, encoding: "utf-8", timeout: 20_000 });
      expect(contender.status).toBe(0);
      expect(contender.stdout).toBe("refused");
      const after = JSON.parse(readFileSync(join(mailLockPath(root), "owner.json"), "utf-8")) as { pid: unknown };
      expect(after.pid).toBe(holder.pid);
      expect(holder.exitCode).toBeNull();
    } finally {
      holder.stdin?.end();
      holder.kill("SIGKILL");
      await exited;
    }
  }, 60_000);
});
