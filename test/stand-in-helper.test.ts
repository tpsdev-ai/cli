/**
 * cli#1016 — the stand-in helper. A stand-in stays alive while its owner lives
 * and exits on its own once the owner is gone.
 *
 * cli#1087 — the owner is an identity, not a pid: an owner pid that now names
 * another process, an owner that exited but was not reaped, and an owner the
 * probe cannot verify all count as gone.
 */
import { expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { procStat } from "./fixtures/heartbeat-lane-fixture-teardown.mjs";
import { spawnStandIn, standInOwnerStartToken, standInTail } from "./helpers/stand-in.mjs";

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

async function waitFor(check: () => boolean, description: string, timeoutMs = EXIT_BOUND_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
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

test("a stand-in exits when its owner pid now names a different process", async () => {
  // The watched pid stays live; the token is another live process's, as after a
  // pid reuse. The test process started long before the stand-in.
  const owner = spawnStandIn();
  const standIn = spawnStandIn({ ownerPid: owner.pid, ownerStart: standInOwnerStartToken(process.pid) });
  try {
    expect(standIn.pid).toBeGreaterThan(0);
    expect(await exited(standIn, EXIT_BOUND_MS)).toBe(true);
  } finally {
    await stop(standIn);
    await stop(owner);
  }
}, 15_000);

test("a stand-in exits when the owner probe cannot verify the owner", async () => {
  const owner = spawnStandIn();
  const unverifiable = () => {
    throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
  };
  const standIn = spawnStandIn({ ownerPid: owner.pid, probe: unverifiable });
  try {
    expect(owner.exitCode).toBeNull();
    expect(standIn.pid).toBeGreaterThan(0);
    expect(await exited(standIn, EXIT_BOUND_MS)).toBe(true);
  } finally {
    await stop(standIn);
    await stop(owner);
  }
}, 15_000);

test("a stand-in exits when its owner is killed and not reaped", async () => {
  const root = mkdtempSync(join(tmpdir(), "stand-in-zombie-"));
  // The shell execs a sleeper, so the killed child below is never reaped: its
  // pid stays a zombie under the same parent pid.
  const ownerSource = [
    "sleep 60 &",
    "p=$!",
    'printf "%s" "$p" > "$ZOMBIE_DIR/child.pid"',
    'while [ ! -f "$ZOMBIE_DIR/kill" ]; do sleep 0.05; done',
    'kill -9 "$p"',
    "exec sleep 60",
    "",
  ].join("\n");
  const parent = spawn("sh", ["-c", ownerSource], { stdio: "ignore", env: { ...process.env, ZOMBIE_DIR: root } });
  let standIn: ChildProcess | undefined;
  try {
    await waitFor(() => readFixtureFile(root, "child.pid") !== null, "the owner pid");
    const zombiePid = Number(readFixtureFile(root, "child.pid"));
    expect(zombiePid).toBeGreaterThan(0);
    // Captured while the owner is alive, before the stand-in starts.
    const ownerStart = standInOwnerStartToken(zombiePid);
    writeFileSync(join(root, "kill"), "1");
    await waitFor(() => processState(zombiePid)?.startsWith("Z") === true, "the owner to exit unreaped");
    // A bare pid probe still finds it: only the identity check can tell.
    expect(processState(zombiePid)?.startsWith("Z")).toBe(true);
    standIn = spawnStandIn({ ownerPid: zombiePid, ownerStart });
    expect(await exited(standIn, EXIT_BOUND_MS)).toBe(true);
  } finally {
    await stop(standIn);
    await stop(parent);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("the helper loads its builtins without process.getBuiltinModule", () => {
  // Node 22.0-22.2 have no process.getBuiltinModule, and Node gives an ES module no require.
  const helperUrl = new URL("./helpers/stand-in.mjs", import.meta.url).href;
  const program = [
    "delete process.getBuiltinModule;",
    `const { standInOwnerStartToken } = await import(${JSON.stringify(helperUrl)});`,
    "process.stdout.write(standInOwnerStartToken(process.pid));",
  ].join("\n");
  const run = spawnSync(process.env.NODE_BIN ?? "node", ["--input-type=module", "-e", program], { encoding: "utf8" });
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toMatch(/^(linux|ps):/);
});

for (const format of ["esm", "cjs"] as const) {
  test(`the generated ${format} tail stays up while its owner lives and exits once it is killed`, async () => {
    const owner = spawn(process.env.NODE_BIN ?? "node", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const ownerPid = owner.pid;
    let program: ChildProcess | undefined;
    try {
      if (ownerPid === undefined) throw new Error("the owner did not start");
      const source = [
        // Node 22.0-22.2 have no process.getBuiltinModule.
        "delete process.getBuiltinModule;",
        standInTail(ownerPid, standInOwnerStartToken(ownerPid), undefined, format),
      ].join("\n");
      const args = format === "esm" ? ["--input-type=module", "-e", source] : ["-e", source];
      program = spawn(process.env.NODE_BIN ?? "node", args, { stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(program.exitCode).toBeNull();
      expect(program.signalCode).toBeNull();
      owner.kill("SIGKILL");
      expect(await exited(program, EXIT_BOUND_MS)).toBe(true);
    } finally {
      await stop(program);
      await stop(owner);
    }
  }, 15_000);
}

const FIXTURE_BOUND_MS = 10_000;

/** A pid's state from /proc on Linux, from `ps -o stat=` elsewhere. Null when
 *  the pid has no entry. */
function processState(pid: number): string | null {
  if (process.platform === "linux") return procStat(pid)?.state ?? null;
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (ps.error) throw ps.error;
  const out = (ps.stdout ?? "").trim();
  return out === "" ? null : out.split(/\s+/)[0];
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`the owner watch exits 0 on ${signal}`, async () => {
    const watchPath = fileURLToPath(new URL("./helpers/stand-in-owner-watch.mjs", import.meta.url));
    const watch = spawn(process.env.NODE_BIN ?? "node", [watchPath], {
      env: {
        ...process.env,
        TPS_STAND_IN_OWNER_PID: String(process.pid),
        TPS_STAND_IN_OWNER_START: standInOwnerStartToken(process.pid),
      },
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(watch.exitCode).toBeNull();
      watch.kill(signal);
      expect(await exited(watch, EXIT_BOUND_MS)).toBe(true);
      expect(watch.exitCode).toBe(0);
      expect(watch.signalCode).toBeNull();
    } finally {
      await stop(watch);
    }
  }, 15_000);
}

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

async function fixtureOwnerCase(name: string, ownerDies: boolean): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "stand-in-fixture-"));
  const fixturePath = fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
  const helperPath = fileURLToPath(new URL("./helpers/stand-in.mjs", import.meta.url));
  const ownerSource = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { standInOwnerStartToken as ownerStartToken } from ${JSON.stringify(helperPath)};
const fixture = spawn(process.execPath, [${JSON.stringify(fixturePath)}], {
  env: {
    ...process.env,
    TEARDOWN_DIR: ${JSON.stringify(root)},
    TPS_STAND_IN_OWNER_PID: String(process.pid),
    TPS_STAND_IN_OWNER_START: ownerStartToken(process.pid),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(${JSON.stringify(join(root, "fixture.pid"))}, String(fixture.pid));
${standInTail(process.pid, undefined, undefined, "esm")}
`;
  const owner = spawn(process.env.NODE_BIN ?? "node", ["--input-type=module", "-e", ownerSource], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  owner.stdout?.on("data", (chunk) => { stdout += chunk; });
  const files = ["fixture.pid", "gateway.pid", "gateway-child.pid"];
  try {
    await waitFor(() => stdout.includes("TEARDOWN_FIXTURE_READY"), `fixture readiness: ${name}`, FIXTURE_BOUND_MS);
    const fixturePid = Number(readFixtureFile(root, "fixture.pid"));
    expect(fixturePid).toBeGreaterThan(0);
    expect(alive(fixturePid)).toBe(true);
    const pids = [fixturePid];
    if (name === "heartbeat-lane-terminated") {
      await waitFor(() => Number(readFixtureFile(root, "gateway.port")) > 0, "gateway readiness", FIXTURE_BOUND_MS);
      for (const file of files.slice(1)) {
        const pid = Number(readFixtureFile(root, file));
        expect(pid).toBeGreaterThan(0);
        expect(alive(pid)).toBe(true);
        pids.push(pid);
      }
    } else {
      await waitFor(() => readFixtureFile(root, "gateway-exited") === "yes", "gateway exit", FIXTURE_BOUND_MS);
    }
    if (ownerDies) {
      const ownerExit = exited(owner, EXIT_BOUND_MS);
      owner.kill("SIGKILL");
      expect(await ownerExit).toBe(true);
      expect(owner.signalCode).toBe("SIGKILL");
      await waitFor(() => pids.every((pid) => !alive(pid)), "fixture and gateway exits", FIXTURE_BOUND_MS);
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
    await waitFor(() => pids.every((pid) => !alive(pid)), "PID cleanup", FIXTURE_BOUND_MS);
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
