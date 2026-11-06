/**
 * cli#731 — the single-daemon guard in `tps branch init` runs after the join.
 * This test performs a real join over the real transport: it starts the real
 * launcher, connects the host side of the Noise IK handshake, places a live
 * verified pid record while the init waits for JOIN_COMPLETE, and then sends
 * JOIN_COMPLETE. The launcher must refuse at the spawn point, naming the
 * record path and the stop remedy, and leave the record unchanged.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { fingerprint, generateKeyPair, saveKeyPair, type TpsKeyPair } from "../src/utils/identity.js";
import { NoiseIkTransport, type TransportChannel } from "../src/utils/noise-ik-transport.js";
import { MSG_JOIN_COMPLETE } from "../src/utils/wire-mail.js";
import { readPidFile, serializePidRecord } from "../src/utils/pid-file.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const WAIT_MS = 20_000;

let root: string;
let pidFile: string;
let savedEnv: Record<string, string | undefined>;
const started: { pid: number; startToken: string }[] = [];
const children: ChildProcess[] = [];

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("no address")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

function startToken(pid: number): string {
  const token = processStartToken(pid);
  if (token === null) throw new Error(`no start token for pid ${pid}`);
  return token;
}

function launcherEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_ENV;
  delete env.TPS_BRANCH_DAEMON;
  delete env.TPS_BRANCH_NO_DAEMON;
  return env;
}

async function waitForExit(child: ChildProcess, timeoutMs = WAIT_MS): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("launcher did not exit within the bound")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function waitForPidGone(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (pidState(pid) !== "gone") {
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 1).trimStart()[0] === "Z") return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      }
    }
    if (Date.now() >= deadline) throw new Error(`pid ${pid} was still alive after the wait bound`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

/** Connect the host side of the real join, retrying until the branch listens. */
async function connectToBranch(
  port: number,
  branchKp: TpsKeyPair,
  hostKp: TpsKeyPair
): Promise<TransportChannel> {
  const deadline = Date.now() + WAIT_MS;
  let last: Error | undefined;
  while (Date.now() < deadline) {
    const transport = new NoiseIkTransport(hostKp);
    try {
      return await transport.connect({
        host: "127.0.0.1",
        port,
        branchId: "branch-a",
        hostPublicKey: branchKp.encryption.publicKey,
      });
    } catch (error) {
      last = error as Error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error(`the branch launcher did not accept a join connection: ${last?.message ?? "unknown"}`);
}

/** Pids running this build's `branch start` with this test's HOME. */
function branchStartPids(): number[] {
  const ps = spawnSync("ps", ["-ax", "-ww", "-o", "pid=,command="], { encoding: "utf8" });
  if (ps.status !== 0 || typeof ps.stdout !== "string") {
    throw new Error(`could not enumerate processes: ps status ${ps.status}, ${String(ps.stderr ?? "")}`);
  }
  const pids: number[] = [];
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const command = match[2]!;
    if (!command.includes(TPS_BIN) || !/\bbranch start\b/.test(command)) continue;
    const pid = Number(match[1]);
    let ours: boolean;
    if (process.platform === "linux") {
      const environment = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (!environment) throw new Error(`could not read environment for pid ${pid}`);
      ours = environment.split("\0").includes(`HOME=${root}`);
    } else if (process.platform === "darwin") {
      const environment = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
      if (environment.status !== 0 || !/(?:^|\s)HOME=\S+/.test(environment.stdout ?? "")) {
        throw new Error(`could not read environment for pid ${pid}: ${String(environment.stderr ?? "")}`);
      }
      ours = ` ${environment.stdout.trim()} `.includes(` HOME=${root} `);
    } else {
      throw new Error(`cannot read process environments on ${process.platform}`);
    }
    if (ours) pids.push(pid);
  }
  return pids;
}

beforeAll(() => {
  if (!existsSync(TPS_BIN)) throw new Error(`tps binary not found at ${TPS_BIN}. Run 'bun run build' first.`);
});

beforeEach(() => {
  savedEnv = {};
  for (const key of [
    "HOME",
    "TPS_ROOT",
    "TPS_IDENTITY_DIR",
    "TPS_REGISTRY_DIR",
    "TPS_AGENT_ID",
    "TPS_VAULT_KEY",
  ]) {
    savedEnv[key] = process.env[key];
  }
  root = mkdtempSync(join(tmpdir(), "tps-branch-731-"));
  process.env.HOME = root;
  process.env.TPS_ROOT = join(root, ".tps");
  process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
  process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
  process.env.TPS_AGENT_ID = "agent-a";
  process.env.TPS_VAULT_KEY = "branch-731-test";
  pidFile = join(root, ".tps", "branch.pid");
  mkdirSync(join(root, ".tps"), { recursive: true });
});

afterEach(async () => {
  const failures: string[] = [];
  const records = [...started];
  const recorded = readPidFile(pidFile);
  if (recorded.kind === "running") records.push({ pid: recorded.pid, startToken: recorded.startToken });
  const seen = new Set<number>();
  for (const record of records) {
    if (seen.has(record.pid)) continue;
    seen.add(record.pid);
    if (pidState(record.pid) === "gone") continue;
    if (processStartToken(record.pid) !== record.startToken) {
      failures.push(`identity could not be verified for pid ${record.pid}; not signalled`);
      continue;
    }
    try {
      process.kill(record.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await waitForPidGone(record.pid).catch((error: Error) => failures.push(error.message));
  }
  for (const child of children.splice(0)) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (failures.length > 0) throw new Error(`process cleanup failed: ${failures.join("; ")}`);
});

describe("branch init single-daemon guard after a real join (cli#731)", () => {
  test("a live record present at spawn refuses the init and leaves the record in place", async () => {
    const port = await freePort();
    const branchKp = generateKeyPair();
    const hostKp = generateKeyPair();
    saveKeyPair(branchKp, process.env.TPS_IDENTITY_DIR!, "branch");

    const init = spawn(
      "node",
      [TPS_BIN, "branch", "init", "--listen", String(port), "--host", "127.0.0.1", "--transport", "tcp"],
      { env: launcherEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );
    children.push(init);
    started.push({ pid: init.pid!, startToken: startToken(init.pid!) });
    let stdout = "";
    let stderr = "";
    init.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    init.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    // The early recorded-process check has already run once the launcher is
    // listening; the record below is placed after it, while the join waits.
    const channel = await connectToBranch(port, branchKp, hostKp);

    const live = spawn("sleep", ["60"], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(live);
    const liveToken = startToken(live.pid!);
    started.push({ pid: live.pid!, startToken: liveToken });
    const recordBytes = serializePidRecord(live.pid!, liveToken);
    writeFileSync(pidFile, recordBytes);

    await channel.send({
      type: MSG_JOIN_COMPLETE,
      seq: 1,
      ts: new Date().toISOString(),
      body: {
        hostPubkey: Buffer.from(hostKp.encryption.publicKey).toString("base64url"),
        hostFingerprint: fingerprint(hostKp.encryption.publicKey),
        hostId: "host-a",
      },
    });

    const exit = await waitForExit(init);
    await channel.close();

    // The join completed and the launcher reached its spawn point, so the
    // refusal below comes from the guard after the join.
    expect(stdout).toContain("Joined to host 'host-a'");
    expect(stdout).toContain("Starting branch daemon...");
    expect(exit.code).not.toBe(0);
    expect(stderr).toContain(`Recorded process (pid ${live.pid}, start token matches) is still running; refusing to spawn`);
    expect(stderr).toContain(pidFile);
    expect(stderr).toContain(
      `If pid ${live.pid} is the branch daemon, stop it with "tps branch stop"; otherwise remove ${pidFile} only after confirming no branch daemon is running.`
    );
    expect(stdout).not.toContain("Branch daemon spawned");
    expect(branchStartPids()).toEqual([]);

    expect(readFileSync(pidFile, "utf8")).toBe(recordBytes);
    const state = readPidFile(pidFile);
    expect(state.kind).toBe("running");
    if (state.kind === "running") {
      expect(state.pid).toBe(live.pid!);
      expect(state.startToken).toBe(liveToken);
    }
    expect(pidState(live.pid!)).toBe("alive");
  }, 60_000);
});
