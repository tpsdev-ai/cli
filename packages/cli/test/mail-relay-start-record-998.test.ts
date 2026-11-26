/** cli#998 / cli#992 — relay start, publication and signal cleanup. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireMailLockSync, pidState, processStartToken, type MailLock } from "@tpsdev-ai/agent";
import { readPidFile } from "../src/utils/pid-file.js";
import { RELAY_PID_LOCK_TIMEOUT_MS, readRelayPidFile, relayPidLockRoot } from "../src/utils/mail-relay.js";
import { relayStartTestHooks, runMail, setRelayPidRemoval } from "../src/commands/mail.js";
import { patchShared } from "./helpers/patch-shared.js";
import { PROC_START_TOKENS_PRELOAD, stageProcStartTokens } from "../../../test/helpers/start-token-source-test.js";

const RELAY_MODULE = resolve(import.meta.dir, "../src/utils/mail-relay.ts");
const MAIL_MODULE = resolve(import.meta.dir, "../src/commands/mail.ts");
const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const CASE_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 20_000;
const WAIT_DEADLINE_MS = 10_000;

let home: string;
let relayPid: string;
let savedHome: string | undefined;
const children: Bun.Subprocess[] = [];

function holdRecordLock(): MailLock {
  const lock = acquireMailLockSync(relayPidLockRoot(), { timeoutMs: 1000 });
  if (!lock) throw new Error("could not hold record lock");
  return lock;
}

function spawnScript(source: string): Bun.Subprocess {
  const child = Bun.spawn([process.execPath, "--eval", source], {
    env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(child);
  return child;
}

function record(pid: number, token: string | null): string {
  return `${JSON.stringify({ pid, startToken: token })}\n`;
}

function spawnSleep(seconds = "60"): Bun.Subprocess {
  const child = Bun.spawn(["sleep", seconds], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return child;
}

function killPid(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  // A pid read from an empty or malformed file parses as 0 or NaN; 0 and negative pids signal process groups.
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${WAIT_DEADLINE_MS} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (pidState(pid) !== "gone") {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for pid ${pid} to exit`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The pids of relay daemons whose argv carries this test's HOME. */
function relayDaemonPids(): number[] {
  const out = spawnSync("ps", ["-ww", "-eo", "pid=,args="], { encoding: "utf8" }).stdout ?? "";
  return out
    .split("\n")
    .filter((line) => line.includes(home) && line.includes("relay") && line.includes("_run"))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isFinite(pid));
}

function runCli(args: string[], timeout = CLI_TIMEOUT_MS): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TPS_BIN, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function runCliAsync(args: string[], runtimeArgs: string[] = [], timeout = CLI_TIMEOUT_MS): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, ...runtimeArgs, TPS_BIN, ...args], {
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, timeout);
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function expectAbandonedClaimRefusal(claimantPid: number, runtimeArgs: string[] = []): Promise<void> {
  const claim = readFileSync(relayPid, "utf8");
  const launched = join(home, "restart-launched");
  const preload = join(home, "restart-preload.ts");
  writeFileSync(preload, `
    import { writeFileSync } from "node:fs";
    import { relayStartTestHooks } from ${JSON.stringify(MAIL_MODULE)};
    relayStartTestHooks.spawn = () => {
      writeFileSync(${JSON.stringify(launched)}, "spawn called");
      throw new Error("unexpected restart spawn");
    };
  `);
  const result = await runCliAsync(["mail", "relay", "start"], [...runtimeArgs, "--preload", preload]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`Mail relay start refused: abandoned start claim ${relayPid}: the recorded claimant process is no longer running (pid ${claimantPid})`);
  expect(result.stderr).toContain("this command launched no relay");
  expectClaimRemedy(result.stderr, claimantPid);
  const stopped = await runCliAsync(["mail", "relay", "stop"], runtimeArgs);
  expect(stopped.status).not.toBe(0);
  expect(stopped.stderr).toContain(`the recorded claimant process is no longer running (pid ${claimantPid})`);
  expect(stopped.stderr).toContain("no process was signalled");
  expectClaimRemedy(stopped.stderr, claimantPid);
  expect(readFileSync(relayPid, "utf8")).toBe(claim);
  expect(existsSync(launched)).toBe(false);
}

function expectClaimRemedy(message: string, claimantPid: number): void {
  expect(message).toContain(`Inspect ps -p ${claimantPid} -o pid=,command= and ps -eo pid=,command= for tps mail relay _run ${join(home, ".tps", "mail")} processes.`);
  expect(message).toContain(`Stop any relay or start process found for this mailbox by its pid, then remove ${relayPid}.`);
  expect(message).not.toContain("tps mail relay status");
}

/** Kill a relay recorded at the path, by that recorded pid. */
function stopRecordedRelay(): void {
  try {
    const state = readPidFile(relayPid);
    if (state.kind === "running" || state.kind === "unverified" || state.kind === "stale") {
      if (state.pid !== process.pid) killPid(state.pid);
    }
  } catch {
    /* no record */
  }
}

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "tps-relay-start-998-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".tps", "mail"), { recursive: true });
  relayPid = join(home, ".tps", "relay.pid");
});

afterEach(() => {
  stopRecordedRelay();
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("relay start and the pid record", () => {
  test(
    "(a) a torn record naming a live process is kept, refused and spawns nothing",
    () => {
      const child = spawnSleep();
      const torn = `{"pid":${child.pid},"startToken":"proc:`;
      writeFileSync(relayPid, torn);
      const before = readFileSync(relayPid);

      const result = runCli(["mail", "relay", "start"]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(relayPid);
      expect(result.stderr).toMatch(/is invalid/);
      expect(result.stderr).toMatch(/by hand/);
      expect(readFileSync(relayPid).equals(before)).toBe(true);
      expect(relayDaemonPids()).toEqual([]);
      expect(pidState(child.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(b) a stale record is replaced and a relay is launched",
    async () => {
      const dead = spawnSleep("5");
      const deadPid = dead.pid;
      const token = processStartToken(deadPid);
      killPid(deadPid);
      await dead.exited;
      expect(pidState(deadPid)).toBe("gone");
      writeFileSync(relayPid, record(deadPid, token));

      const result = runCli(["mail", "relay", "start"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Mail relay started: pid=");
      const state = readPidFile(relayPid);
      expect(["running", "unverified"]).toContain(state.kind);
      if (state.kind !== "running" && state.kind !== "unverified") throw new Error("no relay record");
      expect(state.pid).not.toBe(deadPid);
      expect(pidState(state.pid)).toBe("alive");
      process.kill(state.pid, "SIGTERM");
      await waitGone(state.pid);
      await waitUntil(() => !existsSync(relayPid), "the daemon to remove its record");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(c) two concurrent starts launch one relay and the loser exits non-zero",
    async () => {
      const [first, second] = await Promise.all([
        runCliAsync(["mail", "relay", "start"]),
        runCliAsync(["mail", "relay", "start"]),
      ]);

      expect([first.status, second.status].filter((status) => status === 0)).toHaveLength(1);
      const loser = first.status === 0 ? second : first;
      expect(loser.status).not.toBe(0);
      expect(loser.stderr).toContain(relayPid);
      expect(relayDaemonPids()).toHaveLength(1);

      const state = readPidFile(relayPid);
      expect(["running", "unverified"]).toContain(state.kind);
      if (state.kind !== "running" && state.kind !== "unverified") throw new Error("no relay record");
      expect(pidState(state.pid)).toBe("alive");
      process.kill(state.pid, "SIGTERM");
      await waitGone(state.pid);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(d) a real daemon keeps a replacement written before SIGTERM",
    async () => {
      const daemon = Bun.spawn([process.execPath, TPS_BIN, "mail", "relay", "_run", join(home, ".tps", "mail")], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "ignore", "ignore"],
      });
      children.push(daemon);
      await waitUntil(() => {
        const state = readPidFile(relayPid);
        return (state.kind === "running" || state.kind === "unverified") && state.pid === daemon.pid;
      }, "the daemon's own record");

      const replacement = spawnSleep();
      const newRecord = record(replacement.pid, processStartToken(replacement.pid));
      writeFileSync(relayPid, newRecord);
      process.kill(daemon.pid, "SIGTERM");
      await daemon.exited;

      expect(existsSync(relayPid)).toBe(true);
      expect(readFileSync(relayPid, "utf8")).toBe(newRecord);
      expect(pidState(replacement.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );

  test.each(["claim", "whitespace"])("stop refuses a same-pid same-token %s replacement", async (replacementKind) => {
    stageProcStartTokens();
    const child = spawnSleep();
    const token = processStartToken(child.pid);
    expect(token).not.toBeNull();
    writeFileSync(relayPid, record(child.pid, token));
    const replacement = replacementKind === "claim"
      ? `${JSON.stringify({ pid: child.pid, startToken: token, relayClaim: true })}\n`
      : `${record(child.pid, token)} `;
    const firstState = join(home, "first-state");
    const preload = join(home, "stop-reread.ts");
    writeFileSync(preload, `
      import { writeFileSync } from "node:fs";
      import { setRelayStopRecordReader } from ${JSON.stringify(MAIL_MODULE)};
      import { snapshotPidRecord } from ${JSON.stringify(resolve(import.meta.dir, "../src/utils/pid-file.ts"))};
      let reads = 0;
      setRelayStopRecordReader(() => {
        const snapshot = snapshotPidRecord(${JSON.stringify(relayPid)});
        if (++reads === 1) {
          writeFileSync(${JSON.stringify(firstState)}, snapshot.state.kind);
          writeFileSync(${JSON.stringify(relayPid)}, ${JSON.stringify(replacement)});
        }
        return snapshot;
      });
    `);
    const result = await runCliAsync(["mail", "relay", "stop"], ["--preload", PROC_START_TOKENS_PRELOAD, "--preload", preload]);
    expect(readFileSync(firstState, "utf8")).toBe("running");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("record changed before it was signalled");
    expect(result.stderr).toContain(`The process named by the original record (pid ${child.pid})`);
    expect(result.stderr).not.toContain("The relay process (pid");
    expect(readFileSync(relayPid, "utf8")).toBe(replacement);
    expect(pidState(child.pid)).toBe("alive");
  }, CASE_TIMEOUT_MS);

  test.each([false, true])("SIGINT cleanup (replacement: %s)", async (replace) => {
    const ready = join(home, "sigint-ready");
    const daemon = spawnScript(`
      import { writeFileSync } from "node:fs";
      import { runRelayDaemon } from ${JSON.stringify(RELAY_MODULE)};
      const loop = runRelayDaemon(${JSON.stringify(join(home, ".tps", "mail"))});
      writeFileSync(${JSON.stringify(ready)}, "ready");
      await loop;
    `);
    await waitUntil(() => existsSync(ready), "the daemon's signal handlers");
    expect(JSON.parse(readFileSync(relayPid, "utf8")).pid).toBe(daemon.pid);
    const replacement = spawnSleep();
    const newRecord = record(replacement.pid, processStartToken(replacement.pid));
    if (replace) writeFileSync(relayPid, newRecord);
    process.kill(daemon.pid, "SIGINT");
    await daemon.exited;
    expect(existsSync(relayPid)).toBe(replace);
    if (replace) expect(readFileSync(relayPid, "utf8")).toBe(newRecord);
    expect(pidState(replacement.pid)).toBe("alive");
  }, CASE_TIMEOUT_MS);

  test.each([true, false])("(e) runRelayDaemon publishes the temporary inode (existing record: %s)", async (existing) => {
    const oldRecord = record(11111, "proc:1");
    if (existing) writeFileSync(relayPid, oldRecord);
    const evidence = join(home, "publication.json");
    const daemon = spawnScript(`
      import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      import { runRelayDaemon, relayWriteTestHooks } from ${JSON.stringify(RELAY_MODULE)};
      let observation = {};
      relayWriteTestHooks.afterTempWrite = (tmp, path) => {
        observation = { old: existsSync(path) ? readFileSync(path, "utf8") : null, tmp: statSync(tmp).ino,
          sameDirectory: dirname(tmp) === dirname(path), bytes: readFileSync(tmp, "utf8") };
      };
      const loop = runRelayDaemon(${JSON.stringify(join(home, ".tps", "mail"))});
      writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ ...observation,
        published: statSync(${JSON.stringify(relayPid)}).ino,
        record: readFileSync(${JSON.stringify(relayPid)}, "utf8") }));
      process.kill(process.pid, "SIGTERM");
      await loop;
    `);
    expect(await daemon.exited).toBe(0);
    const observed = JSON.parse(readFileSync(evidence, "utf8"));
    expect(observed.old).toBe(existing ? oldRecord : null);
    expect(observed.sameDirectory).toBe(true);
    expect(observed.tmp).toBeNumber();
    expect(observed.published).toBe(observed.tmp);
    expect(observed.record).toBe(observed.bytes);
    expect(JSON.parse(observed.record).pid).toBe(daemon.pid);
    expect(readdirSync(dirname(relayPid)).filter((name) => name.includes(".relay.pid.tmp."))).toEqual([]);
  }, CASE_TIMEOUT_MS);

  test("start refuses while the real record lock is held", async () => {
    const lock = holdRecordLock();
    try {
      const result = await runCliAsync(["mail", "relay", "start"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing to start the relay.");
      expect(existsSync(relayPid)).toBe(false);
    } finally {
      lock.release();
    }
  }, CASE_TIMEOUT_MS);

  test("daemon publication refuses while the real record lock is held", async () => {
    const old = record(11111, "proc:1");
    writeFileSync(relayPid, old);
    const lock = holdRecordLock();
    try {
      const result = await runCliAsync(["mail", "relay", "_run", join(home, ".tps", "mail")]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing to write the relay pid record.");
      expect(readFileSync(relayPid, "utf8")).toBe(old);
    } finally {
      lock.release();
    }
  }, CASE_TIMEOUT_MS);

  test("daemon signal cleanup keeps its record while the real record lock is held", async () => {
    const ready = join(home, "ready");
    const daemon = spawnScript(`
      import { writeFileSync } from "node:fs";
      import { runRelayDaemon } from ${JSON.stringify(RELAY_MODULE)};
      const loop = runRelayDaemon(${JSON.stringify(join(home, ".tps", "mail"))});
      writeFileSync(${JSON.stringify(ready)}, "ready");
      await loop;
    `);
    await waitUntil(() => existsSync(ready), "the signal handlers");
    const ownRecord = readFileSync(relayPid, "utf8");
    const lock = holdRecordLock();
    try {
      process.kill(daemon.pid, "SIGTERM");
      expect(await daemon.exited).toBe(0);
      expect(readFileSync(relayPid, "utf8")).toBe(ownRecord);
    } finally {
      lock.release();
    }
  }, CASE_TIMEOUT_MS);

  test("failed claim unlink reports the retained claim and remedy", async () => {
    const restoreSpawn = patchShared(relayStartTestHooks, "spawn", () => { throw new Error("injected spawn failure"); });
    const previous = setRelayPidRemoval(() => { throw new Error("injected unlink failure"); });
    try {
      await expect(runMail({ action: "relay", agent: "start" })).rejects.toThrow(
        `The claim was not released; inspect ${relayPid} and remove it if no relay start or daemon is running.`,
      );
      expect(JSON.parse(readFileSync(relayPid, "utf8")).relayClaim).toBe(true);
    } finally {
      setRelayPidRemoval(previous);
      restoreSpawn();
    }
  }, CASE_TIMEOUT_MS);

  test("failed start retains its claim under record lock contention", async () => {
    let lock: MailLock | undefined;
    const restore = patchShared(relayStartTestHooks, "spawn", () => {
      lock = holdRecordLock();
      throw new Error("injected spawn failure");
    });
    try {
      await expect(runMail({ action: "relay", agent: "start" })).rejects.toThrow("The claim was not released;");
      expect(JSON.parse(readFileSync(relayPid, "utf8")).relayClaim).toBe(true);
    } finally {
      lock?.release();
      restore();
    }
  }, CASE_TIMEOUT_MS);

  test("startup timeout waits for the delayed child to exit before releasing the claim", async () => {
    const observed = join(home, "claim-before-exit");
    let child: ReturnType<typeof spawn> | undefined;
    const restore = patchShared(relayStartTestHooks, "spawn", () => {
      child = spawn(process.execPath, ["--eval", `
        import { existsSync, writeFileSync } from "node:fs";
        process.on("SIGTERM", () => setTimeout(() => {
          writeFileSync(${JSON.stringify(observed)}, String(existsSync(${JSON.stringify(relayPid)})));
          process.exit(0);
        }, 250));
        setTimeout(async () => {
          const { runRelayDaemon } = await import(${JSON.stringify(RELAY_MODULE)});
          await runRelayDaemon(${JSON.stringify(join(home, ".tps", "mail"))});
        }, 6000);
      `], { env: { ...process.env, HOME: home }, stdio: "ignore" });
      return child;
    });
    try {
      await expect(runMail({ action: "relay", agent: "start" })).rejects.toThrow(`The claim at ${relayPid} was released.`);
      expect(child?.exitCode).toBe(0);
      expect(pidState(child!.pid!)).toBe("gone");
      expect(readFileSync(observed, "utf8")).toBe("true");
      expect(existsSync(relayPid)).toBe(false);
    } finally {
      child?.kill("SIGKILL");
      restore();
    }
  }, CASE_TIMEOUT_MS);

  test("timed-out CLI exits with a child claim that requires claim removal after child exit", async () => {
    const childPidFile = join(home, "child.pid");
    const signalled = join(home, "child-signalled");
    const preload = join(home, "starter-preload.ts");
    const fixture = `
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => writeFileSync(${JSON.stringify(signalled)}, "SIGTERM"));
      writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    writeFileSync(preload, `
      import { spawn } from "node:child_process";
      import { relayStartTestHooks } from ${JSON.stringify(MAIL_MODULE)};
      relayStartTestHooks.spawn = () => spawn(process.execPath, ["--eval", ${JSON.stringify(fixture)}],
        { detached: true, env: process.env, stdio: "ignore" });
    `);
    let childPid: number | undefined;
    try {
      const first = await runCliAsync(["mail", "relay", "start"], ["--preload", preload]);
      childPid = Number(readFileSync(childPidFile, "utf8"));
      expect(first.status).toBe(1);
      expect(first.stderr).toContain(`child (pid ${childPid}) exit not confirmed; SIGTERM sent.`);
      expect(first.stderr).toContain(`The claim at ${relayPid} names child pid ${childPid}.`);
      expect(readFileSync(signalled, "utf8")).toBe("SIGTERM");
      expect(pidState(childPid)).toBe("alive");
      const claim = readFileSync(relayPid, "utf8");

      const second = runCli(["mail", "relay", "start"]);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toContain(`pid ${childPid}`);
      expect(second.stderr).toContain(relayPid);
      expect(second.stderr).toContain("This command launched no relay");
      expect(readFileSync(relayPid, "utf8")).toBe(claim);
      expect(JSON.parse(claim)).toEqual({ pid: childPid, startToken: processStartToken(childPid), relayClaim: true });

      killPid(childPid);
      await waitGone(childPid);
      const third = runCli(["mail", "relay", "start"]);
      expect(third.status).not.toBe(0);
      expect(readFileSync(relayPid, "utf8")).toBe(claim);
      rmSync(relayPid);
      const fourth = runCli(["mail", "relay", "start"]);
      expect(fourth.status).toBe(0);
      expect(fourth.stdout).toContain("Mail relay started: pid=");
    } finally {
      if (childPid === undefined && existsSync(childPidFile)) childPid = Number(readFileSync(childPidFile, "utf8"));
      if (childPid !== undefined) killPid(childPid);
    }
  }, CASE_TIMEOUT_MS);

  test("timed-out CLI stops retrying a failing claim handoff at the deadline and reports unconfirmed child exit", async () => {
    const childPidFile = join(home, "child.pid");
    const attempts = join(home, "handoff-attempts");
    const preload = join(home, "starter-preload.ts");
    const fixture = `
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    writeFileSync(preload, `
      import { appendFileSync } from "node:fs";
      import { spawn } from "node:child_process";
      import { relayStartTestHooks } from ${JSON.stringify(MAIL_MODULE)};
      import { relayWriteTestHooks } from ${JSON.stringify(RELAY_MODULE)};
      relayStartTestHooks.spawn = () => spawn(process.execPath, ["--eval", ${JSON.stringify(fixture)}],
        { detached: true, env: process.env, stdio: "ignore" });
      relayWriteTestHooks.afterTempWrite = () => {
        appendFileSync(${JSON.stringify(attempts)}, Date.now() + "\\n");
        throw new Error("injected handoff write failure");
      };
    `);
    let childPid: number | undefined;
    try {
      const first = await runCliAsync(["mail", "relay", "start"], ["--preload", preload], CLI_TIMEOUT_MS + 5000);
      const returned = Date.now();
      childPid = Number(readFileSync(childPidFile, "utf8"));
      const claim = JSON.parse(readFileSync(relayPid, "utf8"));
      const tried = readFileSync(attempts, "utf8").trim().split("\n").map(Number);
      expect(first.status).toBe(1);
      expect(first.stderr).toContain(`child (pid ${childPid}) exit not confirmed; SIGTERM sent.`);
      expect(first.stderr).toContain(`The claim at ${relayPid} still names the starter pid ${claim.pid}.`);
      expect(first.stderr).toContain(`within ${RELAY_PID_LOCK_TIMEOUT_MS} ms (injected handoff write failure).`);
      expect(first.stderr).toContain(`Stop pid ${childPid} before starting the relay again.`);
      expect(claim.relayClaim).toBe(true);
      expect(claim.pid).not.toBe(childPid);
      expect(pidState(childPid)).toBe("alive");
      expect(tried.length).toBeGreaterThan(1);
      expect(tried[tried.length - 1]! - tried[0]!).toBeGreaterThanOrEqual(RELAY_PID_LOCK_TIMEOUT_MS / 2);
      expect(returned - tried[0]!).toBeLessThan(RELAY_PID_LOCK_TIMEOUT_MS + 3000);
      await expectAbandonedClaimRefusal(claim.pid);
    } finally {
      if (childPid === undefined) {
        try {
          childPid = Number(readFileSync(childPidFile, "utf8"));
        } catch {
          /* pid unavailable */
        }
      }
      if (childPid !== undefined && Number.isInteger(childPid) && childPid > 1) killPid(childPid);
    }
  }, CASE_TIMEOUT_MS);

  test("killed CLI starter leaves a claim requiring manual resolution before restart", async () => {
    const childPidFile = join(home, "child.pid");
    const preload = join(home, "starter-preload.ts");
    const fixture = `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    writeFileSync(preload, `
      import { spawn } from "node:child_process";
      import { relayStartTestHooks } from ${JSON.stringify(MAIL_MODULE)};
      relayStartTestHooks.spawn = () => spawn(process.execPath, ["--eval", ${JSON.stringify(fixture)}],
        { detached: true, env: process.env, stdio: "ignore" });
    `);
    const starter = Bun.spawn([process.execPath, "--preload", preload, TPS_BIN, "mail", "relay", "start"], {
      env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "ignore"],
    });
    children.push(starter);
    let childPid: number | undefined;
    try {
      await waitUntil(() => existsSync(childPidFile) && Number(readFileSync(childPidFile, "utf8")) > 1, "the child pid");
      childPid = Number(readFileSync(childPidFile, "utf8"));
      expect(JSON.parse(readFileSync(relayPid, "utf8")).pid).toBe(starter.pid);
      killPid(starter.pid);
      await starter.exited;
      expect(pidState(childPid)).toBe("alive");
      await expectAbandonedClaimRefusal(starter.pid);

      killPid(childPid);
      await waitGone(childPid);
      rmSync(relayPid);
      const restarted = runCli(["mail", "relay", "start"]);
      expect(restarted.status).toBe(0);
      expect(restarted.stdout).toContain("Mail relay started: pid=");
    } finally {
      killPid(starter.pid);
      if (childPid === undefined && existsSync(childPidFile)) childPid = Number(readFileSync(childPidFile, "utf8"));
      if (childPid !== undefined) killPid(childPid);
      stopRecordedRelay();
    }
  }, CASE_TIMEOUT_MS);

  test.each([false, true])("timeout reports a changed record after late publication (child exits: %s)", async (exits) => {
    let child: ReturnType<typeof spawn> | undefined;
    const restore = patchShared(relayStartTestHooks, "spawn", () => {
      child = spawn(process.execPath, ["--eval", `
        process.on("SIGTERM", async () => {
          const { runRelayDaemon } = await import(${JSON.stringify(RELAY_MODULE)});
          void runRelayDaemon(${JSON.stringify(join(home, ".tps", "mail"))});
          ${exits ? "process.exit(0);" : ""}
        });
        setInterval(() => {}, 1000);
      `], { env: { ...process.env, HOME: home }, stdio: "ignore" });
      return child;
    });
    try {
      const error = await runMail({ action: "relay", agent: "start" }).then(() => null, (error: Error) => error);
      expect(error?.message).toContain(`child (pid ${child!.pid}) ${exits ? "exited" : "exit not confirmed"}; SIGTERM sent.`);
      expect(error?.message).toContain(`The pid record at ${relayPid} changed; inspect it before removing it.`);
      expect(error?.message).not.toMatch(/claim/);
      const published = JSON.parse(readFileSync(relayPid, "utf8"));
      expect(published.pid).toBe(child!.pid);
      expect(published.relayClaim).toBeUndefined();
    } finally {
      child?.kill("SIGKILL");
      restore();
    }
  }, CASE_TIMEOUT_MS);

  test.each(["false", "throw"])("timeout reports SIGTERM not sent (kill: %s)", async (result) => {
    let child: ReturnType<typeof spawn> | undefined;
    const restore = patchShared(relayStartTestHooks, "spawn", () => {
      child = spawn(process.execPath, ["--eval", 'setTimeout(() => process.exit(0), 5500);'],
        { env: { ...process.env, HOME: home }, stdio: "ignore" });
      child.kill = () => {
        if (result === "throw") throw new Error("injected signal failure");
        return false;
      };
      return child;
    });
    try {
      const error = await runMail({ action: "relay", agent: "start" }).then(() => null, (error: Error) => error);
      expect(error?.message).toContain(`child (pid ${child!.pid}) exited; SIGTERM not sent (kill ${result === "throw" ? "threw" : "returned false"}).`);
      expect(error?.message).toContain(`The claim at ${relayPid} was released.`);
      expect(existsSync(relayPid)).toBe(false);
    } finally {
      if (child?.pid) killPid(child.pid);
      restore();
    }
  }, CASE_TIMEOUT_MS);

  test("an abandoned claim with a reused live pid reports the recorded process and remedy", async () => {
    stageProcStartTokens();
    const claimant = spawnSleep();
    const token = processStartToken(claimant.pid);
    expect(token).toMatch(/^proc:\d+$/);
    const differentToken = token === "proc:1" ? "proc:2" : "proc:1";
    writeFileSync(relayPid, `${JSON.stringify({ pid: claimant.pid, startToken: differentToken, relayClaim: true })}\n`);
    expect(readRelayPidFile().kind).toBe("abandoned-claim");
    await expectAbandonedClaimRefusal(claimant.pid, ["--preload", PROC_START_TOKENS_PRELOAD]);
    expect(pidState(claimant.pid)).toBe("alive");
  }, CASE_TIMEOUT_MS);

  test.each(["start", "stop"])("%s remedy uses the runtime HOME mailbox", async (action) => {
    expect(home).not.toBe(homedir());
    const claimant = spawnSleep("0");
    await claimant.exited;
    writeFileSync(relayPid, `${JSON.stringify({ pid: claimant.pid, startToken: null, relayClaim: true })}\n`);
    expect(readRelayPidFile().kind).toBe("abandoned-claim");
    const error = await runMail({ action: "relay", agent: action }).then(() => null, (error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expectClaimRemedy(error!.message, claimant.pid);
    expect(error!.message).not.toContain(join(homedir(), ".tps", "mail"));
  }, CASE_TIMEOUT_MS);

  test.each(["matching token", "null token", "probe error"])("claim messages describe the recorded pid (%s)", async (scenario) => {
    const verified = scenario === "matching token";
    stageProcStartTokens();
    const starter = spawnSleep();
    const token = processStartToken(starter.pid);
    expect(token).toMatch(/^proc:\d+$/);
    const claim = `${JSON.stringify({ pid: starter.pid, startToken: verified ? token : null, relayClaim: true })}\n`;
    writeFileSync(relayPid, claim);
    expect(readRelayPidFile()).toMatchObject({ kind: "claim", identityVerified: verified });
    const verifiedMessage = `The start claim names a live process (pid ${starter.pid}) whose start token matches the claim; it may or may not have started a relay (pid file ${relayPid}).`;
    const unverifiedMessage = `The start claim names pid ${starter.pid}, which could not be shown to have exited; whether it is the claimant could not be verified (pid file ${relayPid}).`;
    const runtimeArgs = ["--preload", PROC_START_TOKENS_PRELOAD];
    const probed = join(home, "probe-error-observed");
    if (scenario === "probe error") {
      const preload = join(home, "probe-error.ts");
      writeFileSync(preload, `
        import { writeFileSync } from "node:fs";
        const kill = process.kill.bind(process);
        process.kill = (pid, signal) => {
          if (pid === ${starter.pid} && signal === 0) {
            writeFileSync(${JSON.stringify(probed)}, "EIO");
            throw Object.assign(new Error("injected probe error"), { code: "EIO" });
          }
          return kill(pid, signal);
        };
      `);
      runtimeArgs.push("--preload", preload);
    }
    for (const action of ["status", "start", "stop"]) {
      rmSync(probed, { force: true });
      const result = await runCliAsync(["mail", "relay", action], runtimeArgs);
      if (scenario === "probe error") expect(readFileSync(probed, "utf8")).toBe("EIO");
      expect(result.status).toBe(action === "status" ? 0 : 1);
      const message = action === "status" ? result.stdout : result.stderr;
      expect(message).toContain(verified ? verifiedMessage : unverifiedMessage);
      expect(message).not.toContain(verified ? unverifiedMessage : verifiedMessage);
      expect(readFileSync(relayPid, "utf8")).toBe(claim);
      expect(pidState(starter.pid)).toBe("alive");
    }
  }, CASE_TIMEOUT_MS);
});
