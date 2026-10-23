/**
 * cli#667 — launch snapshot ownership and sweeping.
 *
 * Snapshots are private `config-*` directories under `~/.tps/launch`. Each
 * records its owning launcher (pid and process start token); the next launch
 * removes entries whose recorded owner is gone.
 */
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processStartToken } from "@tpsdev-ai/agent";
import {
  LAUNCH_SNAPSHOT_OWNER_FILE,
  LAUNCH_SNAPSHOT_OWNER_GRACE_MS,
  sweepStaleLaunchSnapshots,
  writeLaunchSnapshotOwner,
} from "../src/utils/launch-snapshots.js";

const AGENT_MODULE = resolve(import.meta.dir, "../dist/src/commands/agent.js");

interface Fixture {
  root: string;
  launch: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "tps-667-"));
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

/** A pid that has exited and been reaped by this process. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 });
  expect(result.pid).toBeGreaterThan(0);
  return result.pid as number;
}

describe("launch snapshot owner record", () => {
  test("records the launching pid and its process start token", () => {
    const fixture = makeFixture();
    try {
      const snapshot = makeSnapshot(fixture.launch, "config-new");
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
      const stale = makeSnapshot(fixture.launch, "config-stale");
      const live = makeSnapshot(fixture.launch, "config-live");
      writeOwner(stale, { pid: deadPid(), startToken: "proc:1" });
      writeOwner(live, { pid: process.pid, startToken: processStartToken(process.pid) });
      // A same-named directory outside the launch directory is not in scope.
      const outside = makeSnapshot(join(fixture.root, "elsewhere"), "config-stale");
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

  test("treats a reused pid with a different start token as dead", () => {
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
      const young = makeSnapshot(fixture.launch, "config-young");
      const old = makeSnapshot(fixture.launch, "config-old");
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
      const link = join(fixture.launch, "config-link");
      symlinkSync(target, link);

      expect(sweepStaleLaunchSnapshots(fixture.launch)).toEqual([]);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(target, "keep.txt"), "utf-8")).toBe("keep\n");
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
  test("the next launch removes a stale snapshot and keeps a live launcher's snapshot", async () => {
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

      const stale = makeSnapshot(fixture.launch, "config-stale");
      writeOwner(stale, { pid: deadPid(), startToken: "proc:1" });
      const liveSnapshot = makeSnapshot(fixture.launch, "config-live");
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
});
