/**
 * cli#667, cli#677, cli#681 — launch snapshot ownership and sweeping.
 *
 * Snapshots are private `config-*` directories under `~/.tps/launch`. A snapshot
 * is created as `.pending-config-*`, gets its owner record (pid, and a start
 * token when one is readable), and is renamed to `config-*`. The sweep attempts
 * to remove a published or pending entry whose recorded owner is dead, or that
 * has no readable owner record past its grace period (one minute published, 24
 * hours pending); a removal that fails is logged and the entry is kept. Age is
 * the entry directory's mtime.
 */
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { processStartToken } from "@tpsdev-ai/agent";
import { createPrivateLaunchDir, launchDirLabel } from "../src/utils/launch-attestation.js";
import {
  LAUNCH_SNAPSHOT_OWNER_FILE,
  LAUNCH_SNAPSHOT_OWNER_GRACE_MS,
  LAUNCH_SNAPSHOT_PENDING_OWNER_GRACE_MS,
  sweepStaleLaunchSnapshots,
  writeLaunchSnapshotOwner,
} from "../src/utils/launch-snapshots.js";

const AGENT_MODULE = resolve(import.meta.dir, "../dist/src/commands/agent.js");
const SNAPSHOTS_MODULE = resolve(import.meta.dir, "../src/utils/launch-snapshots.ts");

interface Fixture {
  root: string;
  launch: string;
}

function makeFixture(base: string = tmpdir()): Fixture {
  const root = mkdtempSync(join(base, "tps-667-"));
  const launch = join(root, "home", ".tps", "launch");
  mkdirSync(launch, { recursive: true });
  return { root, launch };
}

function writeOwner(snapshotDir: string, owner: Record<string, unknown>): void {
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, LAUNCH_SNAPSHOT_OWNER_FILE), JSON.stringify(owner));
}

function makeSnapshot(launchDir: string, name: string): string {
  const dir = join(launchDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Make a snapshot look older than the default grace period. */
function ageSnapshot(dir: string): void {
  const past = (Date.now() - LAUNCH_SNAPSHOT_OWNER_GRACE_MS - 60_000) / 1000;
  utimesSync(dir, past, past);
}

/** Make a snapshot look older than the pending grace period. */
function agePastPendingGrace(dir: string): void {
  const past = (Date.now() - LAUNCH_SNAPSHOT_PENDING_OWNER_GRACE_MS - 60_000) / 1000;
  utimesSync(dir, past, past);
}

function makeFifo(path: string): void {
  const result = spawnSync("mkfifo", [path], { encoding: "utf-8", timeout: 10_000 });
  expect(result.status).toBe(0);
}

/** A pid that has exited and been reaped by this process. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 });
  expect(result.pid).toBeGreaterThan(0);
  return result.pid as number;
}

/** A running child process and its start token. */
async function liveProcess(): Promise<{ child: ReturnType<typeof spawn>; pid: number; token: string }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
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

describe("launch snapshot owner record", () => {
  test("records the launching pid and its process start token, or null when none is readable", () => {
    const fixture = makeFixture();
    try {
      const snapshot = makeSnapshot(fixture.launch, "config-new000");
      writeLaunchSnapshotOwner(snapshot);
      const owner = JSON.parse(readFileSync(join(snapshot, LAUNCH_SNAPSHOT_OWNER_FILE), "utf-8"));
      expect(owner.pid).toBe(process.pid);
      expect(owner.startToken).toBe(processStartToken(process.pid));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("sweepStaleLaunchSnapshots", () => {
  test("removes a dead owner's snapshot and keeps a live launcher's snapshot", () => {
    const fixture = makeFixture();
    try {
      const stale = makeSnapshot(fixture.launch, "config-stale0");
      const live = makeSnapshot(fixture.launch, "config-live00");
      writeOwner(stale, { pid: deadPid(), startToken: "proc:1" });
      writeOwner(live, { pid: process.pid, startToken: processStartToken(process.pid) });
      // A same-named directory outside the launch directory is not in scope.
      const outside = makeSnapshot(join(fixture.root, "elsewhere"), "config-stale0");
      writeOwner(outside, { pid: deadPid(), startToken: "proc:1" });

      const removed = sweepStaleLaunchSnapshots(fixture.launch);

      expect(removed).toEqual([stale]);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("treats the current pid with a planted mismatched start token from the same source as dead", () => {
    const fixture = makeFixture();
    try {
      const reused = makeSnapshot(fixture.launch, "config-reused");
      const token = processStartToken(process.pid);
      expect(token).not.toBeNull();
      const source = token!.slice(0, token!.indexOf(":") + 1);
      writeOwner(reused, { pid: process.pid, startToken: `${source}stale-token` });

      expect(sweepStaleLaunchSnapshots(fixture.launch)).toEqual([reused]);
      expect(existsSync(reused)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps an ownerless snapshot inside the grace period and removes one past it", () => {
    const fixture = makeFixture();
    try {
      const young = makeSnapshot(fixture.launch, "config-young0");
      const old = makeSnapshot(fixture.launch, "config-old000");
      writeFileSync(join(young, "agent.yaml"), "agentId: probe\n");
      writeFileSync(join(old, "agent.yaml"), "agentId: probe\n");
      const past = (Date.now() - LAUNCH_SNAPSHOT_OWNER_GRACE_MS - 60_000) / 1000;
      utimesSync(old, past, past);

      expect(sweepStaleLaunchSnapshots(fixture.launch)).toEqual([old]);
      expect(existsSync(young)).toBe(true);
      expect(existsSync(old)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("does not follow a symlinked snapshot entry", () => {
    const fixture = makeFixture();
    try {
      const target = join(fixture.root, "target");
      mkdirSync(target);
      writeFileSync(join(target, "keep.txt"), "keep\n");
      const link = join(fixture.launch, "config-link00");
      symlinkSync(target, link);
      const pendingLink = join(fixture.launch, ".pending-config-link00");
      symlinkSync(target, pendingLink);

      expect(sweepStaleLaunchSnapshots(fixture.launch)).toEqual([]);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(lstatSync(pendingLink).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(target, "keep.txt"), "utf-8")).toBe("keep\n");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
  test("keeps a pending snapshot with no readable owner past the published grace period and removes one past 24 hours", () => {
    const fixture = makeFixture();
    try {
      const young = makeSnapshot(fixture.launch, ".pending-config-young0");
      ageSnapshot(young);
      const old = makeSnapshot(fixture.launch, ".pending-config-old000");
      // An unparsable record, as a forced kill during the owner write can leave.
      writeFileSync(join(old, LAUNCH_SNAPSHOT_OWNER_FILE), '{"pid":');
      agePastPendingGrace(old);
      const oldEmpty = makeSnapshot(fixture.launch, ".pending-config-empty0");
      agePastPendingGrace(oldEmpty);

      expect(sweepStaleLaunchSnapshots(fixture.launch).sort()).toEqual([old, oldEmpty].sort());
      expect(existsSync(young)).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("removes a pending snapshot whose recorded owner is dead and keeps one owned by a running process", async () => {
    const fixture = makeFixture();
    const live = await liveProcess();
    try {
      const gone = makeSnapshot(fixture.launch, ".pending-config-gone00");
      writeOwner(gone, { pid: deadPid(), startToken: "proc:1" });
      const token = processStartToken(process.pid);
      expect(token).not.toBeNull();
      const source = token!.slice(0, token!.indexOf(":") + 1);
      const reused = makeSnapshot(fixture.launch, ".pending-config-reused");
      writeOwner(reused, { pid: process.pid, startToken: `${source}stale-token` });
      // Owned by a running process: kept however old, with its token and with none.
      const owned = makeSnapshot(fixture.launch, ".pending-config-owned0");
      writeOwner(owned, { pid: live.pid, startToken: live.token });
      agePastPendingGrace(owned);
      const ownedNoToken = makeSnapshot(fixture.launch, ".pending-config-ownedn");
      writeOwner(ownedNoToken, { pid: live.pid, startToken: null });
      agePastPendingGrace(ownedNoToken);

      expect(sweepStaleLaunchSnapshots(fixture.launch).sort()).toEqual([gone, reused].sort());
      expect(existsSync(owned)).toBe(true);
      expect(existsSync(ownedNoToken)).toBe(true);
    } finally {
      live.child.kill("SIGKILL");
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("does not block on a FIFO owner record and removes it past the grace period", () => {
    const fixture = makeFixture();
    try {
      const fifoSnapshot = makeSnapshot(fixture.launch, "config-fifo00");
      makeFifo(join(fifoSnapshot, LAUNCH_SNAPSHOT_OWNER_FILE));
      ageSnapshot(fifoSnapshot);

      // Run the sweep in a child with a hard timeout: a blocking open would
      // hang the child instead of the test process.
      const scriptPath = join(fixture.root, "sweep-fifo.mjs");
      writeFileSync(
        scriptPath,
        `
import { sweepStaleLaunchSnapshots } from ${JSON.stringify(SNAPSHOTS_MODULE)};
console.log("REMOVED " + JSON.stringify(sweepStaleLaunchSnapshots(${JSON.stringify(fixture.launch)}, { graceMs: 0 })));
`,
      );
      const result = spawnSync("bun", [scriptPath], { encoding: "utf-8", timeout: 10_000 });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`REMOVED [${JSON.stringify(fifoSnapshot)}]`);
      expect(existsSync(fifoSnapshot)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("refuses an oversized owner record and removes it past the grace period", () => {
    const fixture = makeFixture();
    try {
      const oversized = makeSnapshot(fixture.launch, "config-oversz");
      writeFileSync(
        join(oversized, LAUNCH_SNAPSHOT_OWNER_FILE),
        JSON.stringify({ pid: process.pid, startToken: "proc:1", pad: "x".repeat(5000) }),
      );
      ageSnapshot(oversized);

      expect(sweepStaleLaunchSnapshots(fixture.launch)).toEqual([oversized]);
      expect(existsSync(oversized)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("treats an owner pid outside 1..2147483647 as an unreadable record and keeps the current pid and pid 1", () => {
    const fixture = makeFixture();
    try {
      const unsupported = (
        [
          ["config-pidbig", 2_147_483_648],
          ["config-pidzer", 0],
          ["config-pidneg", -1],
        ] as const
      ).map(([name, pid]) => {
        const dir = makeSnapshot(fixture.launch, name);
        writeOwner(dir, { pid, startToken: null });
        ageSnapshot(dir);
        return dir;
      });
      // The same record inside the grace period is kept, as an unreadable owner
      // record is.
      const young = makeSnapshot(fixture.launch, "config-pidbgy");
      writeOwner(young, { pid: 2_147_483_648, startToken: null });
      // Aged snapshots of live pids: this process with its own token, and pid 1
      // with none (pid 1 always exists; when this process may not signal it,
      // the check fails with EPERM).
      const live = makeSnapshot(fixture.launch, "config-live00");
      writeOwner(live, { pid: process.pid, startToken: processStartToken(process.pid) });
      ageSnapshot(live);
      const pidOne = makeSnapshot(fixture.launch, "config-pidone");
      writeOwner(pidOne, { pid: 1, startToken: null });
      ageSnapshot(pidOne);

      expect(sweepStaleLaunchSnapshots(fixture.launch).sort()).toEqual([...unsupported].sort());
      expect(existsSync(young)).toBe(true);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(pidOne)).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("refuses an owner record whose pid or start token has the wrong shape", () => {
    const fixture = makeFixture();
    try {
      const shapes: Array<[string, unknown]> = [
        ["config-pidstr", { pid: String(process.pid), startToken: "proc:1" }],
        ["config-pidfra", { pid: 1.5, startToken: "proc:1" }],
        ["config-toknum", { pid: process.pid, startToken: 7 }],
        ["config-tokmis", { pid: process.pid }],
      ];
      const dirs = shapes.map(([name, owner]) => {
        const dir = makeSnapshot(fixture.launch, name);
        writeOwner(dir, owner as Record<string, unknown>);
        ageSnapshot(dir);
        return dir;
      });

      expect(sweepStaleLaunchSnapshots(fixture.launch).sort()).toEqual([...dirs].sort());
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("selects only snapshot names with a six-character suffix, never an attestation directory's name", () => {
    const fixture = makeFixture();
    try {
      // Attestation labels as launchDirLabel builds them: the full form, and the
      // hashed short form a long agent id gets.
      // The home string sets which form fits in sun_path on macOS and Linux alike.
      const home = `/${"h".repeat(40)}`;
      const nonce = "0123456789abcdef0123456789abcdef";
      const labels = ["config", "config-x", "conf", "configx", "config-abcdef", ".pending-config", ".pending-config-x"].map(
        (id) => launchDirLabel(home, id, nonce),
      );
      labels.push(launchDirLabel(home, `config-${"x".repeat(57)}`, nonce));
      expect(labels).toContain("config-01234567");
      expect(labels.some((label) => label.length === 25)).toBe(true);
      // Names one character short of, or past, the snapshot shape.
      const nearMisses = ["config-abc12", "config-abc1234", ".pending-config-abc12", ".pending-config-abc1234"];
      const kept = [...labels, ...nearMisses].map((name) => {
        const dir = makeSnapshot(fixture.launch, name);
        agePastPendingGrace(dir);
        return dir;
      });
      const published = makeSnapshot(fixture.launch, "config-abc123");
      agePastPendingGrace(published);
      const pending = makeSnapshot(fixture.launch, ".pending-config-abc123");
      agePastPendingGrace(pending);

      expect(sweepStaleLaunchSnapshots(fixture.launch).sort()).toEqual([published, pending].sort());
      for (const dir of kept) expect(existsSync(dir), basename(dir)).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

function launchScript(config: string, sweepThrows: boolean): string {
  return `
import { runAgent } from ${JSON.stringify(AGENT_MODULE)};
try {
  await runAgent({ action: "start", config: ${JSON.stringify(config)} }, {
    beforeSnapshotSweep: () => {
      ${sweepThrows ? 'throw new Error("sweep boom");' : ""}
    },
    afterConfigSnapshot: () => {
      console.log("SNAPSHOT_REACHED");
      throw new Error("stop after snapshot");
    },
  });
  console.log("LAUNCH_BODY_REACHED");
} catch (error) {
  if (error?.message === "stop after snapshot") process.exit(0);
  throw error;
}
`;
}

function runLaunchChild(fixture: Fixture, script: string) {
  const scriptPath = join(fixture.root, "launch-child.mjs");
  writeFileSync(scriptPath, script);
  return spawnSync("bun", [scriptPath], {
    cwd: fixture.root,
    encoding: "utf-8",
    timeout: 20_000,
    env: { ...process.env, HOME: join(fixture.root, "home") },
  });
}

describe("launch integration", () => {
  test("the next launch removes a stale snapshot and keeps a published snapshot with a live owner record", async () => {
    const fixture = makeFixture();
    const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const livePid = live.pid;
      expect(livePid).toBeGreaterThan(0);
      let liveToken: string | null = null;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        liveToken = processStartToken(livePid!);
        if (liveToken !== null) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      expect(liveToken).not.toBeNull();

      const stale = makeSnapshot(fixture.launch, "config-stale0");
      writeOwner(stale, { pid: deadPid(), startToken: "proc:1" });
      const liveSnapshot = makeSnapshot(fixture.launch, "config-live00");
      writeOwner(liveSnapshot, { pid: livePid, startToken: liveToken });

      const config = join(fixture.root, "agent.yaml");
      writeFileSync(config, "agentId: probe\n");

      const result = runLaunchChild(fixture, launchScript(config, false));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SNAPSHOT_REACHED");
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(liveSnapshot)).toBe(true);
    } finally {
      live.kill("SIGKILL");
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("a sweep error is logged and does not fail the launch", () => {
    const fixture = makeFixture();
    try {
      const config = join(fixture.root, "agent.yaml");
      writeFileSync(config, "agentId: probe\n");

      const result = runLaunchChild(fixture, launchScript(config, true));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SNAPSHOT_REACHED");
      expect(result.stderr).toContain("warning: could not sweep stale launch snapshots");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("a second launch keeps a first launch paused before it publishes, whose published snapshot then has its owner", async () => {
    const fixture = makeFixture();
    const config = join(fixture.root, "agent.yaml");
    writeFileSync(config, "agentId: probe\n");
    const pauseFile = join(fixture.root, "paused.json");
    const releaseFile = join(fixture.root, "release");
    const resultFile = join(fixture.root, "result.json");
    const scriptPath = join(fixture.root, "paused-launch.mjs");
    writeFileSync(
      scriptPath,
      `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runAgent } from ${JSON.stringify(AGENT_MODULE)};
try {
  await runAgent({ action: "start", config: ${JSON.stringify(config)} }, {
    afterPendingSnapshot: (path) => {
      writeFileSync(${JSON.stringify(pauseFile)}, JSON.stringify({ path }));
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !existsSync(${JSON.stringify(releaseFile)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    },
    afterConfigSnapshot: (configPath) => {
      const snapshotDir = dirname(configPath);
      writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
        snapshot: basename(snapshotDir),
        owner: JSON.parse(readFileSync(join(snapshotDir, "owner.json"), "utf8")),
      }));
      throw new Error("stop after snapshot");
    },
  });
} catch (error) {
  if (error?.message === "stop after snapshot") process.exit(0);
  throw error;
}
`,
    );
    const first = spawn("bun", [scriptPath], {
      cwd: fixture.root,
      encoding: "utf-8",
      env: { ...process.env, HOME: join(fixture.root, "home") },
    });
    try {
      const pauseDeadline = Date.now() + 10_000;
      while (Date.now() < pauseDeadline && !existsSync(pauseFile)) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      expect(existsSync(pauseFile)).toBe(true);
      const paused = JSON.parse(readFileSync(pauseFile, "utf-8")).path as string;

      // Old enough that a sweep would remove it were it an ownerless
      // published entry.
      ageSnapshot(paused);

      const second = runLaunchChild(fixture, launchScript(config, false));
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("SNAPSHOT_REACHED");
      expect(existsSync(paused), "the second launch's sweep removed a paused launch's directory").toBe(true);
      // The paused directory must not be visible under its published name, and
      // carries the name shape the sweep selects.
      expect(basename(paused)).toMatch(/^\.pending-config-[A-Za-z0-9]{6}$/);

      writeFileSync(releaseFile, "");
      const exitCode = await new Promise<number | null>((resolveExit) => {
        const timer = setTimeout(() => resolveExit(null), 15_000);
        first.once("exit", (code) => {
          clearTimeout(timer);
          resolveExit(code);
        });
      });
      expect(exitCode).toBe(0);

      const published = JSON.parse(readFileSync(resultFile, "utf-8"));
      expect(published.snapshot).toMatch(/^config-[A-Za-z0-9]{6}$/);
      expect(published.owner.pid).toBe(first.pid);
      expect(published.owner.startToken === null || typeof published.owner.startToken === "string").toBe(true);
    } finally {
      first.kill("SIGKILL");
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 40_000);

  test("a SIGTERM while the launch is paused before it publishes leaves no pending directory, and the launch exits", async () => {
    const fixture = makeFixture();
    const config = join(fixture.root, "agent.yaml");
    writeFileSync(config, "agentId: probe\n");
    const pauseFile = join(fixture.root, "paused.json");
    const releaseFile = join(fixture.root, "release");
    const scriptPath = join(fixture.root, "signalled-launch.mjs");
    writeFileSync(
      scriptPath,
      `
import { existsSync, writeFileSync } from "node:fs";
import { runAgent } from ${JSON.stringify(AGENT_MODULE)};
try {
  await runAgent({ action: "start", config: ${JSON.stringify(config)} }, {
    afterPendingSnapshot: (path) => {
      writeFileSync(${JSON.stringify(pauseFile)}, JSON.stringify({ path }));
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !existsSync(${JSON.stringify(releaseFile)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    },
    afterConfigSnapshot: () => {
      throw new Error("stop after snapshot");
    },
  });
} catch (error) {
  if (error?.message === "stop after snapshot") process.exit(0);
  throw error;
}
`,
    );
    const child = spawn("bun", [scriptPath], {
      cwd: fixture.root,
      env: { ...process.env, HOME: join(fixture.root, "home") },
      stdio: "ignore",
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    try {
      let paused: string | undefined;
      const pauseDeadline = Date.now() + 10_000;
      while (paused === undefined && Date.now() < pauseDeadline) {
        try {
          paused = JSON.parse(readFileSync(pauseFile, "utf-8")).path as string;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
      }
      expect(paused, "the launch never paused before publishing").toBeDefined();
      expect(basename(paused as string).startsWith(".pending-config-")).toBe(true);

      expect(child.kill("SIGTERM")).toBe(true);
      writeFileSync(releaseFile, "");
      const exit = await Promise.race([
        exited,
        new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), 15_000)),
      ]);

      expect(exit, "the launch did not exit after SIGTERM").not.toBeNull();
      expect(existsSync(paused as string), "a SIGTERM in the pending window left the pending directory").toBe(false);
      expect(readdirSync(fixture.launch).filter((name) => name.includes("config-"))).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 40_000);

  test("an owner-record write failure rejects the launch, removes the pending directory, and leaves no exit or signal listener", () => {
    const fixture = makeFixture();
    try {
      const config = join(fixture.root, "agent.yaml");
      writeFileSync(config, "agentId: probe\n");
      const script = `
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from ${JSON.stringify(AGENT_MODULE)};
const counts = () => Object.fromEntries(["exit", "SIGINT", "SIGTERM", "SIGHUP"].map((name) => [name, process.listenerCount(name)]));
const before = counts();
let pending = null;
let during = null;
let error = null;
try {
  await runAgent({ action: "start", config: ${JSON.stringify(config)} }, {
    afterPendingSnapshot: (path) => {
      pending = path;
      during = counts();
      // A directory where the owner record goes makes its exclusive write fail.
      mkdirSync(join(path, "owner.json"));
    },
    afterConfigSnapshot: () => {
      throw new Error("stop after snapshot");
    },
  });
} catch (caught) {
  error = caught?.code ?? String(caught?.message ?? caught);
}
console.log("RESULT " + JSON.stringify({ before, during, after: counts(), pending, pendingExists: pending !== null && existsSync(pending), error }));
`;

      const result = runLaunchChild(fixture, script);

      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
      expect(line, result.stdout).toBeDefined();
      const report = JSON.parse((line as string).slice("RESULT ".length));
      expect(report.error).toBe("EEXIST");
      expect(report.pendingExists).toBe(false);
      expect(report.after).toEqual(report.before);
      // The exit and signal handlers were installed while the pending directory existed.
      for (const name of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
        expect(report.during[name], name).toBe(report.before[name] + 1);
      }
      expect(readdirSync(fixture.launch).filter((name) => name.includes("config-"))).toEqual([]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a FIFO owner record does not block the launch", () => {
    const fixture = makeFixture();
    try {
      const fifoSnapshot = makeSnapshot(fixture.launch, "config-fifo00");
      makeFifo(join(fifoSnapshot, LAUNCH_SNAPSHOT_OWNER_FILE));
      ageSnapshot(fifoSnapshot);
      const config = join(fixture.root, "agent.yaml");
      writeFileSync(config, "agentId: probe\n");

      const result = runLaunchChild(fixture, launchScript(config, false));

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("SNAPSHOT_REACHED");
      expect(existsSync(fifoSnapshot)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("an oversized owner record does not block the launch", () => {
    const fixture = makeFixture();
    try {
      const oversized = makeSnapshot(fixture.launch, "config-oversz");
      writeFileSync(
        join(oversized, LAUNCH_SNAPSHOT_OWNER_FILE),
        JSON.stringify({ pid: process.pid, startToken: "proc:1", pad: "x".repeat(5000) }),
      );
      ageSnapshot(oversized);
      const config = join(fixture.root, "agent.yaml");
      writeFileSync(config, "agentId: probe\n");

      const result = runLaunchChild(fixture, launchScript(config, false));

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("SNAPSHOT_REACHED");
      expect(existsSync(oversized)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);
  test("the next launch removes a pending snapshot whose recorded owner is dead and keeps one owned by a running process", async () => {
    const fixture = makeFixture();
    const live = await liveProcess();
    try {
      const gone = makeSnapshot(fixture.launch, ".pending-config-gone00");
      writeOwner(gone, { pid: deadPid(), startToken: "proc:1" });
      const owned = makeSnapshot(fixture.launch, ".pending-config-owned0");
      writeOwner(owned, { pid: live.pid, startToken: live.token });
      agePastPendingGrace(owned);
      const config = join(fixture.root, "agent.yaml");
      writeFileSync(config, "agentId: probe\n");

      const result = runLaunchChild(fixture, launchScript(config, false));

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("SNAPSHOT_REACHED");
      expect(existsSync(gone)).toBe(false);
      expect(existsSync(owned)).toBe(true);
    } finally {
      live.child.kill("SIGKILL");
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a launch whose ownerless pending directory a sweep removes while it is paused fails writing the owner record and publishes nothing", () => {
    const fixture = makeFixture();
    try {
      const config = join(fixture.root, "agent.yaml");
      writeFileSync(config, "agentId: probe\n");
      const script = `
import { utimesSync } from "node:fs";
import { dirname } from "node:path";
import { runAgent } from ${JSON.stringify(AGENT_MODULE)};
import { LAUNCH_SNAPSHOT_PENDING_OWNER_GRACE_MS, sweepStaleLaunchSnapshots } from ${JSON.stringify(SNAPSHOTS_MODULE)};
let pending = null;
let removed = null;
let error = null;
try {
  await runAgent({ action: "start", config: ${JSON.stringify(config)} }, {
    afterPendingSnapshot: (path) => {
      pending = path;
      // The directory as a later launch's sweep finds it once this launcher has been stopped here past the grace period.
      const past = (Date.now() - LAUNCH_SNAPSHOT_PENDING_OWNER_GRACE_MS - 60_000) / 1000;
      utimesSync(path, past, past);
      removed = sweepStaleLaunchSnapshots(dirname(path));
    },
    afterConfigSnapshot: () => {
      throw new Error("stop after snapshot");
    },
  });
} catch (caught) {
  error = caught?.code ?? String(caught?.message ?? caught);
}
console.log("RESULT " + JSON.stringify({ pending, removed, error }));
`;

      const result = runLaunchChild(fixture, script);

      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
      expect(line, result.stdout).toBeDefined();
      const report = JSON.parse((line as string).slice("RESULT ".length));
      expect(report.removed).toEqual([report.pending]);
      expect(report.error).toBe("ENOENT");
      expect(readdirSync(fixture.launch).filter((name) => name.includes("config-"))).toEqual([]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a SIGTERM while the launch waits at its pending snapshot, with nothing else failing, removes the pending directory through the signal handler", async () => {
    const fixture = makeFixture();
    const config = join(fixture.root, "agent.yaml");
    writeFileSync(config, "agentId: probe\n");
    const pauseFile = join(fixture.root, "paused.json");
    const scriptPath = join(fixture.root, "signal-only-launch.mjs");
    writeFileSync(
      scriptPath,
      `
import { writeFileSync } from "node:fs";
import { runAgent } from ${JSON.stringify(AGENT_MODULE)};
await runAgent({ action: "start", config: ${JSON.stringify(config)} }, {
  // Waits on the event loop, so the SIGTERM handler can run while the snapshot is pending.
  afterPendingSnapshot: (path) => new Promise(() => {
    writeFileSync(${JSON.stringify(pauseFile)}, JSON.stringify({ path }));
    // A bound: SIGKILL runs no handler, so a launch that no signal handler ended exits with its directory left.
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 20_000);
  }),
});
console.log("LAUNCH_CONTINUED");
`,
    );
    const child = spawn("bun", [scriptPath], {
      cwd: fixture.root,
      env: { ...process.env, HOME: join(fixture.root, "home") },
      stdio: "ignore",
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    try {
      let paused: string | undefined;
      const pauseDeadline = Date.now() + 10_000;
      while (paused === undefined && Date.now() < pauseDeadline) {
        try {
          paused = JSON.parse(readFileSync(pauseFile, "utf-8")).path as string;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
      }
      expect(paused, "the launch never paused at its pending snapshot").toBeDefined();
      expect(basename(paused as string).startsWith(".pending-config-")).toBe(true);

      expect(child.kill("SIGTERM")).toBe(true);
      const exit = await Promise.race([
        exited,
        new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), 15_000)),
      ]);

      // The handler re-raises the signal once it has cleaned up.
      expect(exit).toEqual({ code: null, signal: "SIGTERM" });
      expect(existsSync(paused as string), "the SIGTERM handler left the pending directory").toBe(false);
      expect(readdirSync(fixture.launch).filter((name) => name.includes("config-"))).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 40_000);

  test("a launch keeps the attestation directories of agents named config and config-x through its sweep and removes stale snapshots", () => {
    // A short root: the attestation directory's socket path must fit in sun_path.
    const fixture = makeFixture("/var/tmp");
    try {
      const home = join(fixture.root, "home");
      const attestations = ["config", "config-x"].map((agentId) => {
        const dir = createPrivateLaunchDir({ home, agentId });
        agePastPendingGrace(dir.root);
        return dir;
      });
      expect(attestations.map((dir) => basename(dir.root).startsWith("config-"))).toEqual([true, true]);
      const stale = makeSnapshot(fixture.launch, "config-stale0");
      writeOwner(stale, { pid: deadPid(), startToken: "proc:1" });
      const ownerless = makeSnapshot(fixture.launch, "config-old000");
      ageSnapshot(ownerless);
      const config = join(fixture.root, "agent.yaml");
      writeFileSync(config, "agentId: probe\n");

      const result = runLaunchChild(fixture, launchScript(config, false));

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("SNAPSHOT_REACHED");
      for (const dir of attestations) {
        expect(readFileSync(dir.outsideCanary, "utf-8"), basename(dir.root)).toBe(dir.outsideNonce);
        expect(readFileSync(dir.insideCanary, "utf-8"), basename(dir.root)).toBe(dir.insideNonce);
      }
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(ownerless)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  // Directory permissions do not stop root, so this case cannot produce the error under root and is skipped there.
  const RUNS_AS_ROOT = process.getuid?.() === 0;
  test.skipIf(RUNS_AS_ROOT)("a stale snapshot the sweep cannot read or remove is logged and kept, another stale snapshot is removed, and the launch continues", () => {
    const fixture = makeFixture();
    const stuck = makeSnapshot(fixture.launch, "config-stuck0");
    try {
      writeFileSync(join(stuck, "agent.yaml"), "agentId: probe\n");
      ageSnapshot(stuck);
      chmodSync(stuck, 0o000);
      const stale = makeSnapshot(fixture.launch, "config-stale0");
      writeOwner(stale, { pid: deadPid(), startToken: "proc:1" });
      const config = join(fixture.root, "agent.yaml");
      writeFileSync(config, "agentId: probe\n");

      const result = runLaunchChild(fixture, launchScript(config, false));
      chmodSync(stuck, 0o700);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("SNAPSHOT_REACHED");
      expect(result.stderr).toContain("warning: could not remove stale launch snapshot ");
      expect(result.stderr).toContain(`${basename(stuck)}: `);
      expect(readFileSync(join(stuck, "agent.yaml"), "utf-8")).toBe("agentId: probe\n");
      expect(existsSync(stale)).toBe(false);
    } finally {
      chmodSync(stuck, 0o700);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);
});
