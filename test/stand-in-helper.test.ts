/**
 * cli#1016 — the stand-in helper. A stand-in stays alive while its owner lives
 * and exits on its own once the owner is gone.
 */
import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { procStat } from "./fixtures/heartbeat-lane-fixture-teardown.mjs";
import { spawnStandIn, standInTail } from "./helpers/stand-in.mjs";

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

const FIXTURE_BOUND_MS = 10_000;

function alive(pid: number): boolean {
  if (process.platform === "linux") {
    const stat = procStat(pid);
    return stat !== null && stat.state !== "Z";
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function readFixtureFile(root: string, name: string): string | null {
  try {
    return readFileSync(join(root, name), "utf8").trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function waitForFixture(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + FIXTURE_BOUND_MS;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function fixtureOwnerCase(name: string, ownerDies: boolean): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "stand-in-fixture-"));
  const fixturePath = fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
  const ownerSource = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const fixture = spawn(process.execPath, [${JSON.stringify(fixturePath)}], {
  env: { ...process.env, TEARDOWN_DIR: ${JSON.stringify(root)}, TPS_STAND_IN_OWNER_PID: String(process.pid) },
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(${JSON.stringify(join(root, "fixture.pid"))}, String(fixture.pid));
${standInTail(process.pid)}
`;
  const owner = spawn(process.env.NODE_BIN ?? "node", ["-e", ownerSource], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  owner.stdout?.on("data", (chunk) => { stdout += chunk; });
  const files = ["fixture.pid", "gateway.pid", "gateway-child.pid"];
  try {
    await waitForFixture(() => stdout.includes("TEARDOWN_FIXTURE_READY"), `fixture readiness: ${name}`);
    const fixturePid = Number(readFixtureFile(root, "fixture.pid"));
    expect(fixturePid).toBeGreaterThan(0);
    expect(alive(fixturePid)).toBe(true);
    const pids = [fixturePid];
    if (name === "heartbeat-lane-terminated") {
      await waitForFixture(() => Number(readFixtureFile(root, "gateway.port")) > 0, "gateway readiness");
      for (const file of files.slice(1)) {
        const pid = Number(readFixtureFile(root, file));
        expect(pid).toBeGreaterThan(0);
        expect(alive(pid)).toBe(true);
        pids.push(pid);
      }
    } else {
      await waitForFixture(() => readFixtureFile(root, "gateway-exited") === "yes", "gateway exit");
    }
    if (ownerDies) {
      const ownerExit = exited(owner, EXIT_BOUND_MS);
      owner.kill("SIGKILL");
      expect(await ownerExit).toBe(true);
      expect(owner.signalCode).toBe("SIGKILL");
      await waitForFixture(() => pids.every((pid) => !alive(pid)), "fixture and gateway exits");
    } else {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(owner.exitCode).toBeNull();
      expect(owner.signalCode).toBeNull();
      for (const pid of pids) expect(alive(pid)).toBe(true);
    }
  } finally {
    // Read recorded PIDs again so readiness failures still clean up spawned descendants.
    const pids = files.map((file) => Number(readFixtureFile(root, file)))
      .filter((pid) => Number.isInteger(pid) && pid > 0).reverse();
    try {
      for (const pid of pids) {
        if (!alive(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    } finally {
      await stop(owner);
      rmSync(root, { recursive: true, force: true });
    }
    await waitForFixture(() => pids.every((pid) => !alive(pid)), "PID cleanup");
  }
}

for (const name of ["heartbeat-lane-terminated", "heartbeat-lane-teardown-own-exit"]) {
  test(`${name} exits after its intermediate owner is killed and reaped`, async () => {
    await fixtureOwnerCase(name, true);
  }, 30_000);

  test(`${name} stays up with a live intermediate owner until PID cleanup`, async () => {
    await fixtureOwnerCase(name, false);
  }, 30_000);
}
