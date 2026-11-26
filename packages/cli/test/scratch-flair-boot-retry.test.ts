/**
 * cli#1025 — the scratch-Flair boot retries a port pair when a port was taken.
 * The operations port is checked inside the retried attempt, so a lost
 * operations port restarts the child on a new pair instead of failing the lane.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
let restorePorts: () => void;
let nextPort = 45_000;
beforeEach(() => {
  restorePorts = patchShared(net, "createServer", (() => {
    const server = new EventEmitter();
    return Object.assign(server, {
      listen: (_port: number, _host: string, ready: () => void) => { ready(); },
      address: () => ({ port: ++nextPort }),
      close: (done: () => void) => { done(); },
    });
  }) as typeof net.createServer);
});
afterEach(() => restorePorts());
import type { ChildProcess } from "node:child_process";
import { bootOnRetriedPorts, waitForOk } from "./helpers/scratch-flair.js";
import { spawnStandIn } from "../../../test/helpers/stand-in.mjs";

/** A stand-in child that records its own pid when it is stopped; the signal is ignored. */
function fakeChild(pid: number, killed: number[]): ChildProcess {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill: () => {
      killed.push(pid);
      return true;
    },
  } as unknown as ChildProcess;
}

test("a taken operations port restarts the scratch child on a new pair", async () => {
  const attempts: Array<{ httpPort: number; opsPort: number }> = [];
  const killed: number[] = [];
  const children = [fakeChild(4_101, killed), fakeChild(4_102, killed)];
  const logs = ["Error: listen EADDRINUSE: address already in use 127.0.0.1:0", ""];

  const result = await bootOnRetriedPorts({
    timeoutMs: 1_000,
    spawn: (httpPort, opsPort) => {
      attempts.push({ httpPort, opsPort });
      const index = attempts.length - 1;
      return { proc: children[index]!, log: () => logs[index]! };
    },
    // HTTP answers on every attempt; operations answers only on the second.
    ready: async (url) => url.endsWith("/Health") || attempts.length > 1,
    stop: (proc) => {
      proc.kill("SIGKILL");
    },
  });

  expect(attempts).toHaveLength(2);
  expect(killed).toEqual([4_101]);
  expect(result.httpPort).toBe(attempts[1]!.httpPort);
  expect(result.opsPort).toBe(attempts[1]!.opsPort);
}, 10_000);

for (const rejectedStage of [1, 2]) {
  test(`readiness rejection at stage ${rejectedStage} stops the scratch child`, async () => {
    const killed: number[] = [];
    const controller = new AbortController();
    const failure = new Error("boot cancelled");
    let stage = 0;
    await expect(bootOnRetriedPorts({
      timeoutMs: 1_000,
      spawn: () => ({ proc: fakeChild(4_201, killed), log: () => "" }),
      ready: async () => {
        if (++stage === rejectedStage) controller.abort(failure);
        if (controller.signal.aborted) return waitForOk("http://127.0.0.1/Health", Date.now() + 1_000, controller.signal);
        return true;
      },
      stop: (proc) => { proc.kill("SIGKILL"); },
    })).rejects.toBe(failure);
    expect(killed).toEqual([4_201]);
  });
}

for (const status of ["bind-error", "exited", "signaled"] as const) {
  test(`healthy endpoints do not accept a ${status} scratch child`, async () => {
    const killed: number[] = [];
    let attempts = 0;
    const result = bootOnRetriedPorts({
      timeoutMs: 1_000,
      spawn: () => {
        const proc = fakeChild(4_300 + ++attempts, killed);
        if (attempts === 1 && status === "exited") Object.assign(proc, { exitCode: 1 });
        if (attempts === 1 && status === "signaled") Object.assign(proc, { signalCode: "SIGKILL" });
        return { proc, log: () => attempts === 1 && status === "bind-error" ? "EADDRINUSE" : "" };
      },
      ready: async () => true,
      stop: (proc) => { proc.kill("SIGKILL"); },
    });
    if (status === "bind-error") {
      await result;
      expect(attempts).toBe(2);
    } else {
      await expect(result).rejects.toThrow("exited before readiness");
      expect(attempts).toBe(1);
    }
    expect(killed).toEqual([4_301]);
  });
}

test("readiness cancellation stops a real scratch child", async () => {
  const proc = spawnStandIn({ command: "node" });
  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
  const controller = new AbortController();
  const failure = new Error("boot cancelled");
  try {
    await expect(bootOnRetriedPorts({
      timeoutMs: 1_000,
      spawn: () => ({ proc, log: () => "" }),
      ready: async () => {
        controller.abort(failure);
        return waitForOk("http://127.0.0.1/Health", Date.now() + 1_000, controller.signal);
      },
      stop: (child) => { child.kill("SIGKILL"); },
    })).rejects.toBe(failure);
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("child survived cancellation")), 1_000))]);
    expect(proc.signalCode).toBe("SIGKILL");
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await closed;
  }
});
