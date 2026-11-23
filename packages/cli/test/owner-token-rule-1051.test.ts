/**
 * cli#1051 — follow-ups from cli#1045.
 *
 * The cli consumers of the shared owner-token rule each get an independent
 * cross-source case (a recorded `proc:` token against a live `ps:` token, or
 * the reverse): the outbox per-delivery lock, pid files and the launch
 * snapshot sweep. The pid-file path is also driven through a CLI subprocess
 * with the test-only `ps` preload. A live owner whose tokens cannot be
 * compared is never treated as gone: its record is kept, and the lock,
 * pid-file and teardown checks report it.
 */
import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { spawnLiveProcess, spawnSigtermRecorder, waitForReadyLine } from "../../../test/helpers/live-process.js";
import {
  forcePsStartTokens,
  PS_START_TOKENS_NODE_ARGS,
  stageProcStartTokens,
} from "../../../test/helpers/start-token-source-test.js";
import { releasedAgentIdentity, stopLaunchProcesses } from "../src/utils/launch-attestation.js";
import { LAUNCH_SNAPSHOT_OWNER_FILE, LAUNCH_SNAPSHOT_PREFIX, sweepStaleLaunchSnapshots } from "../src/utils/launch-snapshots.js";
import { MailLockOwnerError, mailLockTestHooks, tryAcquireMailLock } from "../src/utils/mail-lock.js";
import { OutboxLockError, queueOutboxMessage } from "../src/utils/outbox.js";
import { readPidFile } from "../src/utils/pid-file.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
/** An intentionally non-UTC POSIX zone (UTC+13:17). */
const ODD_ZONE_ENV = { ...process.env, TZ: "XST-13:17" };
const GUIDANCE = "pause every process that acquires or reclaims this lock, confirm no delivery is active, remove the lock, and only then resume them";

/** The `ps:` text an unpinned writer in a non-UTC zone would have recorded. */
function legacyPsToken(pid: number): string {
  const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    env: ODD_ZONE_ENV,
    encoding: "utf-8",
    timeout: 5_000,
  }).trim();
  return `ps:${text}`;
}

/** The pinned `ps:` token current code reads for this pid. */
function pinnedPsToken(pid: number): string {
  const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    encoding: "utf-8",
    timeout: 5_000,
  }).trim();
  return `ps:${text}`;
}

let root: string;
let child: ChildProcess | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  root = mkdtempSync(join(tmpdir(), "owner-token-rule-1051-"));
});

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

function livePid(): number {
  child = spawnLiveProcess();
  const pid = child.pid as number;
  expect(pid).toBeGreaterThan(0);
  return pid;
}

describe("outbox per-delivery lock", () => {
  test("a live owner whose recorded token comes from another source is not broken", () => {
    forcePsStartTokens();
    const pid = livePid();
    const token = processStartToken(pid);
    expect(token).toMatch(/^ps:/);
    const lockDir = join(root, "delivery.lock");
    mkdirSync(lockDir);
    const ownerFile = join(lockDir, "owner.json");
    const owner = { pid, startToken: "proc:1" };
    writeFileSync(ownerFile, JSON.stringify(owner));

    let lock: ReturnType<typeof tryAcquireMailLock> = null;
    let thrown: unknown;
    try {
      lock = tryAcquireMailLock(lockDir);
    } catch (error) {
      thrown = error;
    } finally {
      lock?.release();
    }
    expect(lock).toBeNull();
    expect(thrown).toBeInstanceOf(MailLockOwnerError);
    expect(JSON.parse(readFileSync(ownerFile, "utf-8"))).toEqual(owner);
  });

  test("an unverifiable-owner refusal carries recovery guidance", () => {
    process.env.HOME = root;
    const pid = livePid();
    const legacy = legacyPsToken(pid);
    const deliveryId = "a".repeat(64);
    const lockDir = join(root, ".tps", "outbox", "new", `.github-${deliveryId}.lock`);
    mkdirSync(lockDir, { recursive: true });
    const ownerFile = join(lockDir, "owner.json");
    const owner = { pid, startToken: legacy };
    writeFileSync(ownerFile, JSON.stringify(owner));

    let thrown: unknown;
    try {
      queueOutboxMessage("agent-a", "body", "agent-a", deliveryId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OutboxLockError);
    expect((thrown as Error).message).toContain(GUIDANCE);
    expect(JSON.parse(readFileSync(ownerFile, "utf-8"))).toEqual(owner);
  });

  test("the outbox refusal for an unverifiable owner of this very pid tells the operator to pause, confirm and resume", () => {
    process.env.HOME = root;
    const deliveryId = "c".repeat(64);
    const lockDir = join(root, ".tps", "outbox", "new", `.github-${deliveryId}.lock`);
    mkdirSync(lockDir, { recursive: true });
    const ownerFile = join(lockDir, "owner.json");
    const owner = { pid: process.pid, startToken: "ps:Tue Nov 17 02:39:30 2026" };
    writeFileSync(ownerFile, JSON.stringify(owner));

    let thrown: unknown;
    try {
      queueOutboxMessage("agent-a", "body", "agent-a", deliveryId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OutboxLockError);
    const message = (thrown as Error).message;
    expect(message).toContain("pause every process that acquires or reclaims this lock");
    expect(message).toContain("confirm no delivery is active");
    expect(message).toContain("remove the lock, and only then resume them");
    expect(JSON.parse(readFileSync(ownerFile, "utf-8"))).toEqual(owner);
  });

  test("a reclaim that meets a live unverifiable owner reports the guidance and keeps the record", () => {
    process.env.HOME = root;
    const reaped = spawnSync(process.execPath, ["-e", ""]).pid as number;
    expect(pidState(reaped)).toBe("gone");
    const pid = livePid();
    const owner = { pid, startToken: legacyPsToken(pid) };
    const deliveryId = "b".repeat(64);
    const lockDir = join(root, ".tps", "outbox", "new", `.github-${deliveryId}.lock`);
    mkdirSync(lockDir, { recursive: true });
    const ownerFile = join(lockDir, "owner.json");
    const deadOwner = { pid: reaped, startToken: "proc:1" };
    writeFileSync(ownerFile, JSON.stringify(deadOwner));
    mkdirSync(`${lockDir}.reclaim`);
    writeFileSync(join(`${lockDir}.reclaim`, "owner.json"), JSON.stringify(deadOwner));
    const restore = patchShared(mailLockTestHooks, "beforeOwnerRead", (dir: string) => {
      if (!dir.endsWith(".reclaim")) return;
      writeFileSync(ownerFile, JSON.stringify(owner));
    });
    let thrown: unknown;
    try {
      queueOutboxMessage("agent-a", "body", "agent-a", deliveryId);
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    expect(thrown).toBeInstanceOf(OutboxLockError);
    expect((thrown as Error).message).toContain(GUIDANCE);
    expect(JSON.parse(readFileSync(ownerFile, "utf-8"))).toEqual(owner);
  });
});

describe("pid files", () => {
  test("a live owner whose recorded token comes from another source is unverified and kept", () => {
    stageProcStartTokens();
    const pid = livePid();
    expect(processStartToken(pid)).toMatch(/^proc:/);
    const path = join(root, "relay.pid");
    const bytes = `${JSON.stringify({ pid, startToken: "ps:Tue Nov 17 02:39:30 2026" })}\n`;
    writeFileSync(path, bytes);

    const state = readPidFile(path);
    expect(state.kind).toBe("unverified");
    expect(state.kind === "unverified" ? state.pid : null).toBe(pid);
    expect(readFileSync(path, "utf-8")).toBe(bytes);
  });

  test("mail relay stop refuses a recorded ps: token it cannot compare and sends no signal", async () => {
    const node = Bun.which("node");
    if (!node) throw new Error("Node is required for the mail relay stop subprocess test");
    process.env.HOME = root;
    mkdirSync(join(root, ".tps"), { recursive: true });
    // The recorder installs its SIGTERM handler before it reports ready, and
    // stays alive on SIGTERM, so the marker proves whether stop sent it SIGTERM.
    const marker = join(root, "sigterm.log");
    const recorder = spawnSigtermRecorder(marker);
    child = recorder;
    const pid = recorder.pid as number;
    expect(pid).toBeGreaterThan(0);
    expect(await waitForReadyLine(recorder)).toBe(true);
    const legacy = legacyPsToken(pid);
    const pinned = pinnedPsToken(pid);
    expect(legacy).not.toBe(pinned);
    const path = join(root, ".tps", "relay.pid");

    // Positive control: the preload really put this child on the ps: path. A
    // /proc read would report the relay unverified against this ps: token.
    writeFileSync(path, `${JSON.stringify({ pid, startToken: pinned })}\n`);
    const status = spawnSync(
      node,
      [...PS_START_TOKENS_NODE_ARGS, TPS_BIN, "mail", "relay", "status"],
      { env: { ...process.env, HOME: root }, encoding: "utf-8", timeout: 30_000 },
    );
    if (status.error) throw status.error;
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(`Mail relay running: pid=${pid}`);

    const bytes = `${JSON.stringify({ pid, startToken: legacy })}\n`;
    writeFileSync(path, bytes);

    // Record every signal the stop command sends, in the stop process itself and
    // before delivery: the record is complete when spawnSync returns, whatever the
    // recorder has handled by then, and it sees SIGKILL, which the marker cannot.
    const signalLog = join(root, "stop-signals.log");
    const recordSignals =
      `import { appendFileSync } from "node:fs";` +
      `const kill = process.kill.bind(process);` +
      `process.kill = (target, signal) => {` +
      ` if (signal !== 0 && signal !== "0") appendFileSync(${JSON.stringify(signalLog)}, target + " " + String(signal ?? "SIGTERM") + "\\n");` +
      ` return kill(target, signal);` +
      `};` +
      `console.log("stop-signal-recorder:installed");`;

    const result = spawnSync(
      node,
      [
        ...PS_START_TOKENS_NODE_ARGS,
        "--import",
        "data:text/javascript,console.log('owner-token-runtime:'+process.release.name+':'+Boolean(process.versions.bun))",
        "--import",
        `data:text/javascript,${encodeURIComponent(recordSignals)}`,
        TPS_BIN,
        "mail",
        "relay",
        "stop",
      ],
      { env: { ...process.env, HOME: root }, encoding: "utf-8", timeout: 30_000 },
    );
    if (result.error) throw result.error;
    expect(result.stdout).toContain("owner-token-runtime:node:false");
    expect(result.stdout).toContain("stop-signal-recorder:installed");
    expect(existsSync(signalLog) ? readFileSync(signalLog, "utf-8") : "").toBe("");
    expect(result.status).not.toBe(0);
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toContain("identity cannot be verified");
    expect(readFileSync(path, "utf-8")).toBe(bytes);
    expect(existsSync(marker) ? readFileSync(marker, "utf-8") : "").toBe("");
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(existsSync(path)).toBe(true);
  }, 30_000);
});

describe("launch snapshot sweep", () => {
  test("a live owner whose recorded token comes from another source is kept", () => {
    forcePsStartTokens();
    const pid = livePid();
    expect(processStartToken(pid)).toMatch(/^ps:/);
    const dir = join(root, `${LAUNCH_SNAPSHOT_PREFIX}a1051b`);
    mkdirSync(dir);
    writeFileSync(join(dir, LAUNCH_SNAPSHOT_OWNER_FILE), JSON.stringify({ pid, startToken: "proc:1" }));

    expect(sweepStaleLaunchSnapshots(root, { graceMs: 0 })).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
});

/**
 * Record every signal this process sends by pid while `run` is pending (a
 * `kill(pid, 0)` probe is not a signal). `onSignal` sees only the supervisor, so
 * an agent-directed send is visible only here.
 */
async function recordingKills<T>(run: () => Promise<T>): Promise<{ result: T; kills: Array<[number, string]> }> {
  const kills: Array<[number, string]> = [];
  const original = process.kill.bind(process);
  const restore = patchShared(process, "kill", ((target: number, signal?: string | number) => {
    if (signal !== 0 && signal !== "0") kills.push([target, String(signal ?? "SIGTERM")]);
    return original(target, signal);
  }) as typeof process.kill);
  try {
    return { result: await run(), kills };
  } finally {
    restore();
  }
}

describe("released-agent identity", () => {
  test("a live released agent recorded as a proc: token against its live ps: token is a survivor", async () => {
    forcePsStartTokens();
    const pid = livePid();
    const live = processStartToken(pid);
    expect(live).toMatch(/^ps:/);
    const signalled: number[] = [];
    try {
      expect(releasedAgentIdentity({ pid, startToken: "proc:1" })).toBe("unknown");
      const { result: stop, kills } = await recordingKills(() => stopLaunchProcesses(
        { supervisor: null, agent: { pid, startToken: "proc:1" } },
        "SIGTERM",
        { boundMs: 50, hooks: { startToken: () => live, onSignal: (signalledPid) => signalled.push(signalledPid) } },
      ));
      expect(kills.filter(([target]) => target === pid)).toEqual([]);
      expect(stop.stopped).toBe(false);
      expect(stop.survivors).toEqual([pid]);
      expect(signalled).toEqual([]);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      child?.kill("SIGKILL");
      child = undefined;
    }
  });

  test("a live released agent recorded as a ps: token against its live proc: token is a survivor", async () => {
    stageProcStartTokens();
    const pid = livePid();
    const legacy = legacyPsToken(pid);
    expect(processStartToken(pid)).toMatch(/^proc:/);
    const signalled: number[] = [];
    try {
      expect(releasedAgentIdentity({ pid, startToken: legacy })).toBe("unknown");
      const { result: stop, kills } = await recordingKills(() => stopLaunchProcesses(
        { supervisor: null, agent: { pid, startToken: legacy } },
        "SIGTERM",
        { boundMs: 50, hooks: { onSignal: (signalledPid) => signalled.push(signalledPid) } },
      ));
      expect(kills.filter(([target]) => target === pid)).toEqual([]);
      expect(stop.stopped).toBe(false);
      expect(stop.survivors).toEqual([pid]);
      expect(signalled).toEqual([]);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      child?.kill("SIGKILL");
      child = undefined;
    }
  });

  test("a live released agent with a legacy ps: token is a survivor, not a stopped launch", async () => {
    const pid = livePid();
    const legacy = legacyPsToken(pid);
    const pinned = pinnedPsToken(pid);
    expect(legacy).not.toBe(pinned);
    try {
      expect(releasedAgentIdentity({ pid, startToken: legacy }, () => pinned)).toBe("unknown");
      const { result: stop, kills } = await recordingKills(() => stopLaunchProcesses(
        { supervisor: null, agent: { pid, startToken: legacy } },
        "SIGTERM",
        { boundMs: 50, hooks: { startToken: () => pinned } },
      ));
      expect(kills.filter(([target]) => target === pid)).toEqual([]);
      expect(stop.stopped).toBe(false);
      expect(stop.survivors).toEqual([pid]);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      child?.kill("SIGKILL");
      child = undefined;
    }
  });
});
