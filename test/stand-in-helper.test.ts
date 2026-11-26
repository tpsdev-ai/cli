/**
 * cli#1016 — the stand-in helper. A stand-in stays alive while its owner lives
 * and exits on its own once the owner is gone.
 */
import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { spawnStandIn } from "./helpers/stand-in.mjs";

/** Bound on a stand-in acting on its owner's death, with room for one poll. */
const EXIT_BOUND_MS = 5_000;

function exited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await exited(child, EXIT_BOUND_MS);
}

test("a stand-in exits within the bound once its owner is killed", async () => {
  const owner = spawnStandIn();
  const standIn = spawnStandIn({ ownerPid: owner.pid });
  try {
    expect(owner.pid).toBeGreaterThan(0);
    expect(standIn.pid).toBeGreaterThan(0);
    // Up before the owner dies, so the exit below is the owner watch's doing.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(standIn.exitCode).toBeNull();
    owner.kill("SIGKILL");
    expect(await exited(standIn, EXIT_BOUND_MS)).toBe(true);
  } finally {
    await stop(standIn);
    await stop(owner);
  }
}, 15_000);

test("a stand-in whose owner lives is still running after 3 s and exits on SIGTERM", async () => {
  const standIn = spawnStandIn();
  try {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(standIn.exitCode).toBeNull();
    expect(standIn.signalCode).toBeNull();
    const exit = exited(standIn, EXIT_BOUND_MS);
    standIn.kill("SIGTERM");
    expect(await exit).toBe(true);
    expect(standIn.signalCode).toBe("SIGTERM");
  } finally {
    await stop(standIn);
  }
}, 15_000);
