import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidState } from "@tpsdev-ai/agent";
import { formatStopFailure, type GroupMemberIo, listGroupMembers, parsePsGroupMembers, stopRealLaunch, type StopReport } from "./helpers/stop-real-launch.js";

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

const groupMemberIo: GroupMemberIo = {
  platform: "linux",
  readdir: (path) => {
    expect(path).toBe("/proc");
    return ["4242"];
  },
  readFile: (path) => {
    expect(path).toBe("/proc/4242/stat");
    return "4242 (sleep) S 1 4242 0";
  },
  execPs: () => { throw new Error("unexpected ps call"); },
};

describe("group membership parsing (cli#1037)", () => {
  test.each(["Z", "Z+"])("ps excludes %s members and matches the requested PGID", (zombieState) => {
    const output = ` 4242 42 ${zombieState}\n 4243 42 Ss\n 4244 43 S+\n`;
    expect(parsePsGroupMembers(output, 42)).toEqual([4243]);
    expect(parsePsGroupMembers(output, 43)).toEqual([4244]);
    expect(listGroupMembers(42, { ...groupMemberIo, platform: "darwin", execPs: () => output })).toEqual([4243]);
  });

  test.each(["ENOENT", "ESRCH"])("a vanished proc entry (%s) leaves the remaining membership readable", (code) => {
    expect(listGroupMembers(4242, {
      ...groupMemberIo,
      readdir: () => ["4241", "4242"],
      readFile: (path) => {
        if (path === "/proc/4241/stat") throw Object.assign(new Error("vanished"), { code });
        return groupMemberIo.readFile(path);
      },
    })).toEqual([4242]);
  });
});

describe("stopRealLaunch (cli#1037)", () => {
  test("the final survivor entry uses one state observation", async () => {
    let reads = 0;
    const report = await stopRealLaunch({}, released(4242), {
      signalBudgetMs: 0,
      pollMs: 1,
      sendSignal: () => {},
      readState: () => ++reads <= 3 ? "alive" : "gone",
    });
    expect(reads).toBe(3);
    expect(report.survivors).toEqual([{ role: "released child", pid: 4242, state: "alive" }]);
    expect(report.stopped).toBe(false);
    expect(report.stopped).toBe(report.survivors.length === 0);
  });

  test("a zombie-only group has stopped", async () => {
    const launcher = await sleepingChild(true);
    try {
      expect(() => process.kill(-launcher.pid!, 0)).not.toThrow();
      const report = await stopRealLaunch(launcher, "", {
        signalBudgetMs: 0,
        pollMs: 1,
        sendSignal: () => {},
        listGroupMembers: (pgid) => {
          expect(pgid).toBe(launcher.pid);
          return [launcher.pid!];
        },
        // pidState maps a Linux zombie to gone while the group kill probe still succeeds.
        readState: () => "gone",
      });
      expect(report.survivors).toEqual([]);
      expect(report.stopped).toBe(true);
    } finally {
      await killChild(launcher);
    }
  });

  test("a group with a live member remains a survivor", async () => {
    const report = await stopRealLaunch({ pid: 4242 }, "", {
      signalBudgetMs: 0,
      pollMs: 1,
      sendSignal: () => {},
      listGroupMembers: (pgid) => {
        expect(pgid).toBe(4242);
        return [4242, 4243];
      },
      readState: (pid) => pid === 4243 ? "alive" : "gone",
    });
    expect(report.survivors).toEqual([{ role: "launcher process group", pid: 4242, state: "alive" }]);
    expect(report.stopped).toBe(false);
  });

  const membershipFailures: [string, Partial<GroupMemberIo>][] = [
    ["ps exits nonzero", {
      platform: "darwin",
      execPs: () => { throw Object.assign(new Error("ps failed"), { status: 1 }); },
    }],
    ["ps prints an unparseable line", { platform: "darwin", execPs: () => "4242 42 Ss\nunparseable" }],
    ["ps prints empty output", { platform: "darwin", execPs: () => "" }],
    ["proc directory is unreadable", {
      readdir: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    }],
    ["proc stat is unreadable", {
      readFile: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    }],
    ["proc stat lacks a closing parenthesis", { readFile: () => "4242 sleep S 1 4242 0" }],
    ["proc stat has a nonnumeric PGID", { readFile: () => "4242 (sleep) S 1 unknown 0" }],
    ["proc stat has a fractional PGID", { readFile: () => "4242 (sleep) S 1 42.5 0" }],
    ["proc stat has a negative PGID", { readFile: () => "4242 (sleep) S 1 -42 0" }],
  ];
  test.each(membershipFailures)("%s returns null and retains the kill probe", async (_name, overrides) => {
    const launcher = await sleepingChild(true);
    try {
      const io = { ...groupMemberIo, ...overrides };
      const members = listGroupMembers(launcher.pid!, io);
      expect(() => process.kill(-launcher.pid!, 0)).not.toThrow();
      const report = await stopRealLaunch(launcher, "", {
        signalBudgetMs: 0,
        pollMs: 1,
        sendSignal: () => {},
        listGroupMembers: (pgid) => {
          expect(pgid).toBe(launcher.pid);
          return listGroupMembers(pgid, io);
        },
        readState: () => "gone",
      });
      expect(report.survivors).toEqual([{ role: "launcher process group", pid: launcher.pid, state: "alive" }]);
      expect(report.stopped).toBe(false);
      expect(members).toBeNull();
    } finally {
      await killChild(launcher);
    }
  });

  const psAvailable = process.platform !== "darwin" || spawnSync("ps", ["-axo", "pid=,pgid=,stat="], { stdio: "ignore" }).status === 0;
  test.skipIf(!psAvailable)("the real group lister finds a detached launcher", async () => {
    const launcher = await sleepingChild(true);
    try {
      expect(listGroupMembers(launcher.pid!)).toContain(launcher.pid!);
      const report = await stopRealLaunch(launcher, "", {
        signalBudgetMs: 0,
        pollMs: 1,
        sendSignal: () => {},
        readState: () => "gone",
      });
      expect(report.survivors).toEqual([]);
      expect(report.stopped).toBe(true);
    } finally {
      await killChild(launcher);
    }
  });

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
      detached: true,
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
      expect(listGroupMembers(holder.pid!)).toContain(zombiePid);
      const report = await stopRealLaunch(launcher, released(zombiePid), { signalBudgetMs: 10, pollMs: 1 });
      expect(report.stopped).toBe(true);
      expect(report.survivors).toEqual([]);
      const groupReport = await stopRealLaunch(holder, "", { signalBudgetMs: 10, pollMs: 1 });
      expect(groupReport.stopped).toBe(true);
      expect(groupReport.survivors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      await Promise.all([killChild(holder), killChild(launcher)]);
    }
  });
});
