import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, saveKeyPair, type TpsKeyPair } from "../src/utils/identity.js";
import { NoiseIkTransport } from "../src/utils/noise-ik-transport.js";
import { writeBranchConf } from "../src/commands/branch.js";
import { branchStatePath, writeBranchState } from "../src/utils/connection-state.js";
import type { TransportChannel, TpsMessage } from "../src/utils/transport.js";
import { MSG_HEARTBEAT } from "../src/utils/wire-mail.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

async function freePort(): Promise<number> {
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

async function connectHost(port: number, host: TpsKeyPair, branch: TpsKeyPair): Promise<TransportChannel> {
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      return await new NoiseIkTransport(host).connect({
        host: "127.0.0.1",
        port,
        branchId: "agent-a",
        hostPublicKey: branch.encryption.publicKey,
      });
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
}

function exchange(channel: TransportChannel, message: TpsMessage, replyType: number): Promise<TpsMessage> {
  return new Promise((resolveReply, reject) => {
    const cleanup = () => { clearTimeout(timer); channel.offMessage(handler); };
    const handler = (received: TpsMessage) => {
      if (received.type !== replyType || received.seq !== message.seq) return;
      cleanup();
      resolveReply(received);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("reply timeout")); }, 5000);
    channel.onMessage(handler);
    channel.send(message).catch((error: unknown) => { cleanup(); reject(error); });
  });
}

describe("branch daemon state-write failure", () => {
  let root: string;
  let child: ChildProcess | undefined;
  let channel: TransportChannel | undefined;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ["HOME", "TPS_ROOT", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_AGENT_ID", "TPS_VAULT_KEY"]) {
      savedEnv[key] = process.env[key];
    }
    root = mkdtempSync(join(tmpdir(), "tps-branch-state-write-"));
    process.env.HOME = root;
    process.env.TPS_ROOT = join(root, ".tps");
    process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
    process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
    process.env.TPS_AGENT_ID = "agent-a";
    process.env.TPS_VAULT_KEY = "branch-state-write-test";
  });

  afterEach(async () => {
    if (channel) {
      await channel.close().catch(() => {});
      channel = undefined;
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => child!.once("exit", () => resolveExit()));
      child.kill("SIGKILL");
      await exited;
    }
    child = undefined;
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("a state-write failure is logged and the heartbeat echo still runs", async () => {
    const branch = generateKeyPair();
    const host = generateKeyPair();
    saveKeyPair(branch, process.env.TPS_IDENTITY_DIR!, "branch");
    mkdirSync(process.env.TPS_ROOT!, { recursive: true });
    writeFileSync(
      join(process.env.TPS_IDENTITY_DIR!, "host.json"),
      JSON.stringify({ publicKey: Buffer.from(host.encryption.publicKey).toString("base64url") }),
    );
    // A regular file in the connections directory's place makes the record
    // write fail for every uid, including root in CI.
    writeFileSync(join(process.env.TPS_ROOT!, "connections"), "not a directory");
    const port = await freePort();
    writeBranchConf(port, "127.0.0.1", "tcp", undefined, "agent-a");

    // The daemon runs under the same runtime as this test, so the failure
    // message is the one this process sees for the same construction.
    let writeFailure: string | undefined;
    try {
      writeBranchState({ connectedAt: "a", lastSeen: "b", messagesReceived: 0, messagesPushed: 0 });
    } catch (error) {
      writeFailure = error instanceof Error ? error.message : String(error);
    }
    expect(writeFailure).toBeDefined();

    const env: NodeJS.ProcessEnv = { ...process.env, TPS_BRANCH_NO_DAEMON: "1" };
    delete env.TPS_BRANCH_DAEMON;
    child = spawn(process.execPath, [TPS_BIN, "branch", "start"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

    channel = await connectHost(port, host, branch);
    expect(channel.isAlive()).toBe(true);
    const echo = await exchange(channel, { type: MSG_HEARTBEAT, seq: 7, ts: new Date().toISOString(), body: {} }, MSG_HEARTBEAT);
    expect(echo.seq).toBe(7);

    const logPath = join(process.env.TPS_ROOT!, "branch.log");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").split("\n").filter((line) => line.includes("Branch state write failed"));
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    const prefix = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] /);
    expect(prefix).not.toBeNull();
    expect(line.slice(prefix![0].length)).toBe(`WARN: Branch state write failed at ${branchStatePath()}: ${writeFailure}`);
    expect(stderr).toBe("");
  }, 30_000);
});
