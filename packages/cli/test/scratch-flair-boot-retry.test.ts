/**
 * cli#1025 — the scratch-Flair boot retries a port pair when a port was taken.
 * The operations port is checked inside the retried attempt, so a lost
 * operations port restarts the child on a new pair instead of failing the lane.
 */
import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { bootOnRetriedPorts } from "./helpers/scratch-flair.js";

/** A stand-in child that records the signal it was stopped with. */
function fakeChild(pid: number, killed: number[]): ChildProcess {
  return {
    pid,
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
