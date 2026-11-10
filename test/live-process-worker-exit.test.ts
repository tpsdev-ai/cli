/**
 * cli#712 — a worker parked at a `release-*` gate must exit when the process
 * that started it is hard-killed. The worker and its spawner use the shared
 * live-process helper pieces that bridge-ack-path and mail-existing-updates use.
 */
import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  WORKER_OWNER_WATCH_SCRIPT,
  ownerAwareGateWaitScript,
  pidIsRunning,
  waitForPidGone,
} from "./helpers/live-process.js";

/** Operational allowance for a process to act on its owner's death. */
const EXIT_BOUND_MS = 10_000;
/** Long enough that the gate's own timeout cannot be mistaken for the owner watch. */
const GATE_TIMEOUT_MS = 60_000;
const HELPER_URL = pathToFileURL(join(import.meta.dir, "helpers/live-process.ts")).href;

/** The intermediate owner: starts the worker with the shared helper, records its pid, and parks. */
function writeOwnerScript(root: string, worker: string): string {
  const path = join(root, "owner.ts");
  writeFileSync(
    path,
    `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnWatchedWorker } from ${JSON.stringify(HELPER_URL)};
const root = process.argv[2];
const child = spawnWatchedWorker(${JSON.stringify(worker)}, [root]);
writeFileSync(join(root, "worker.pid"), String(child.pid));
setInterval(() => {}, 1000);
`,
  );
  return path;
}

/** The worker: watches its owner, then parks in the shared owner-aware gate. */
function writeWorkerScript(root: string): string {
  const path = join(root, "worker.ts");
  writeFileSync(
    path,
    `
import * as fs from "node:fs";
import { join } from "node:path";
${WORKER_OWNER_WATCH_SCRIPT}
const root = process.argv[2];
${ownerAwareGateWaitScript(GATE_TIMEOUT_MS, "worker-gate")}
wait("release-worker");
process.exit(0);
`,
  );
  return path;
}

async function readText(path: string, timeoutMs = EXIT_BOUND_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) return text;
    } catch {
      // not written yet
    }
    if (Date.now() >= deadline) throw new Error(`no text written to ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForProcessExit(child: ChildProcess, timeoutMs = EXIT_BOUND_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) throw new Error("owner did not exit at the deadline");
}

test("a gate-parked worker exits when the process that started it is SIGKILLed", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-worker-exit-"));
  const worker = writeWorkerScript(root);
  const owner = spawn(process.execPath, [writeOwnerScript(root, worker), root], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  let workerPid: number | undefined;
  try {
    workerPid = Number(await readText(join(root, "worker.pid")));
    expect(workerPid).toBeGreaterThan(0);
    expect(pidIsRunning(workerPid)).toBe(true);
    // Written from inside the gate loop: the worker is blocked there, not just about to be.
    await readText(join(root, "worker-gate"));
    owner.kill("SIGKILL");
    await waitForProcessExit(owner);
    expect(await waitForPidGone(workerPid, EXIT_BOUND_MS)).toBe(true);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      try {
        owner.kill("SIGKILL");
      } catch {
        // already gone
      }
      await waitForProcessExit(owner, 5_000).catch(() => undefined);
    }
    if (workerPid !== undefined) {
      if (pidIsRunning(workerPid)) {
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await waitForPidGone(workerPid, 5_000);
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
