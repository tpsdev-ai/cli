import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidState } from "@tpsdev-ai/agent";
import { formatStopFailure, stopRealLaunch, type StopReport } from "./helpers/stop-real-launch.js";

describe("real-launch teardown reporting (cli#1037)", () => {
  test("survivors are named by role, pid and state, with the wait", () => {
    const report: StopReport = {
      stopped: false,
      waitedMs: 6_000,
      survivors: [
        { role: "released child", pid: 4242, state: "alive" },
        { role: "launcher", pid: 4243, state: "alive" },
      ],
    };
    const message = formatStopFailure(report);
    expect(message).toContain("released child pid 4242 (alive)");
    expect(message).toContain("launcher pid 4243 (alive)");
    expect(message).toContain("after 6000ms");
  });

  test("a single survivor is still named", () => {
    const message = formatStopFailure({
      stopped: false,
      waitedMs: 3_000,
      survivors: [{ role: "released child", pid: 7, state: "alive" }],
    });
    expect(message).toContain("released child pid 7 (alive)");
    expect(message).toContain("after 3000ms");
    expect(message).not.toContain("launcher pid");
  });

  test("a stopped report does not claim a survivor", () => {
    const message = formatStopFailure({ stopped: true, waitedMs: 75, survivors: [] });
    expect(message).not.toContain("could not confirm");
    expect(message).toContain("confirmed");
  });
});

async function sleepingChild(detached = false): Promise<ChildProcess> {
  const child = spawn("sleep", ["60"], { detached, stdio: "ignore" });
  await once(child, "spawn");
  return child;
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
}

function released(pid: number): string {
  return `released under nono session s1 (child pid ${pid})`;
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("fixture did not reach the expected process state");
    await Bun.sleep(5);
  }
}

describe("stopRealLaunch (cli#1037)", () => {
  test("the final check confirms a target gone after the in-loop checks", async () => {
    const child = await sleepingChild();
    let reads = 0;
    const signals: [number, NodeJS.Signals][] = [];
    try {
      const report = await stopRealLaunch({}, released(child.pid!), {
        signalBudgetMs: 0,
        pollMs: 1,
        sendSignal: (pid, name) => { signals.push([pid, name]); },
        readState: (pid) => {
          expect(pid).toBe(child.pid);
          return ++reads <= 2 ? "alive" : "gone";
        },
      });
      expect(reads).toBe(3);
      expect(signals).toEqual([[child.pid, "SIGTERM"], [child.pid, "SIGKILL"]]);
      expect(report.stopped).toBe(true);
      expect(report.survivors).toEqual([]);
      expect(formatStopFailure(report)).toBe("teardown confirmed the released child and launcher are gone");
    } finally {
      await killChild(child);
    }
  });

  test("a positive pid classified gone is not a survivor", async () => {
    const child = await sleepingChild();
    let reads = 0;
    try {
      expect(pidState(child.pid!)).toBe("alive");
      const report = await stopRealLaunch(child, released(child.pid!), {
        signalBudgetMs: 5,
        pollMs: 1,
        sendSignal: () => {},
        readState: (pid) => {
          expect(pid).toBe(child.pid);
          reads++;
          return "gone";
        },
      });
      expect(reads).toBeGreaterThan(0);
      expect(report.stopped).toBe(true);
      expect(report.survivors).toEqual([]);
      expect(pidState(child.pid!)).toBe("alive");
    } finally {
      await killChild(child);
    }
  });

  test("survivors and wait come from stopping live released and launcher pids", async () => {
    const launcher = await sleepingChild();
    const child = await sleepingChild();
    const signals: [number, NodeJS.Signals][] = [];
    try {
      const report = await stopRealLaunch(launcher, released(child.pid!), {
        signalBudgetMs: 10,
        pollMs: 1,
        sendSignal: (pid, name) => { signals.push([pid, name]); },
      });
      expect(signals).toEqual([
        [child.pid, "SIGTERM"], [launcher.pid, "SIGTERM"],
        [child.pid, "SIGKILL"], [launcher.pid, "SIGKILL"],
      ]);
      expect(report.stopped).toBe(false);
      expect(report.survivors).toEqual([
        { role: "released child", pid: child.pid, state: "alive" },
        { role: "launcher", pid: launcher.pid, state: "alive" },
      ]);
      expect(report.waitedMs).toBeGreaterThanOrEqual(20);
      expect(formatStopFailure(report)).toBe(
        `teardown could not confirm the released child and launcher are gone after ${report.waitedMs}ms: released child pid ${child.pid} (alive), launcher pid ${launcher.pid} (alive)`
      );
    } finally {
      await Promise.all([killChild(child), killChild(launcher)]);
    }
  });

  test("a live detached launcher reports its process group with a positive pid", async () => {
    const launcher = await sleepingChild(true);
    try {
      const report = await stopRealLaunch(launcher, "", {
        signalBudgetMs: 10,
        pollMs: 1,
        sendSignal: () => {},
      });
      expect(report.stopped).toBe(false);
      expect(report.survivors).toEqual([
        { role: "launcher process group", pid: launcher.pid, state: "alive" },
        { role: "launcher", pid: launcher.pid, state: "alive" },
      ]);
      expect(report.waitedMs).toBeGreaterThanOrEqual(20);
      expect(formatStopFailure(report)).toContain(`launcher process group pid ${launcher.pid} (alive)`);
    } finally {
      await killChild(launcher);
    }
  });

  test("the default signal sender stops a live child", async () => {
    const child = await sleepingChild();
    try {
      const report = await stopRealLaunch(child, released(child.pid!));
      expect(report.stopped).toBe(true);
      expect(report.survivors).toEqual([]);
      expect(pidState(child.pid!)).toBe("gone");
    } finally {
      await killChild(child);
    }
  });

  // Linux /proc exposes state Z; macOS pidState has no zombie classification.
  test.skipIf(process.platform !== "linux")("an unreaped Linux zombie is not a survivor", async () => {
    const root = mkdtempSync(join(tmpdir(), "nono-zombie-1037-"));
    const gate = join(root, "gate");
    writeFileSync(gate, "hold");
    const holder = spawn("sh", ["-c", 'while [ -e "$1" ]; do sleep 0.01; done & printf "%s\\n" "$!"; exec sleep 60', "sh", gate], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const launcher = await sleepingChild();
    let output = "";
    holder.stdout!.on("data", (chunk) => { output += chunk.toString(); });
    try {
      await waitUntil(() => output.includes("\n"));
      const zombiePid = Number(output.trim());
      expect(zombiePid).toBeGreaterThan(0);
      // The exec prevents the shell from reaping its background child.
      await waitUntil(() => readFileSync(`/proc/${holder.pid}/cmdline`, "utf8").startsWith("sleep\0"));
      rmSync(gate);
      await waitUntil(() => readFileSync(`/proc/${zombiePid}/stat`, "utf8").split(") ")[1]?.startsWith("Z ") === true);
      expect(() => process.kill(zombiePid, 0)).not.toThrow();
      expect(pidState(zombiePid)).toBe("gone");
      const report = await stopRealLaunch(launcher, released(zombiePid), { signalBudgetMs: 10, pollMs: 1 });
      expect(report.stopped).toBe(true);
      expect(report.survivors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      await Promise.all([killChild(holder), killChild(launcher)]);
    }
  });
});
