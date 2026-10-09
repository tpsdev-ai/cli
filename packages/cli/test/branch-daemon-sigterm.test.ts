import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, saveKeyPair, type TpsKeyPair } from "../src/utils/identity.js";
import { NoiseIkTransport } from "../src/utils/noise-ik-transport.js";
import { writeBranchConf } from "../src/commands/branch.js";
import type { TransportChannel } from "../src/utils/transport.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const EXIT_BOUND_MS = 3000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("no address")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/** Connect an authenticated host over TCP, retrying while the daemon binds. */
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
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe("branch daemon SIGTERM with a host connected", () => {
  let root: string;
  let child: ChildProcess | undefined;
  let cleanups: Array<Promise<void> | void>;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ["HOME", "TPS_ROOT", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_AGENT_ID", "TPS_VAULT_KEY"]) {
      savedEnv[key] = process.env[key];
    }
    root = mkdtempSync(join(tmpdir(), "tps-daemon-sigterm-"));
    process.env.HOME = root;
    process.env.TPS_ROOT = join(root, ".tps");
    process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
    process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
    process.env.TPS_AGENT_ID = "agent-a";
    process.env.TPS_VAULT_KEY = "daemon-sigterm-test";
    cleanups = [];
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch {
        /* best effort */
      }
    }
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // The daemon runs under each runtime: the CLI ships to hosts that run it on
  // node, and the branch daemon is exercised on bun too.
  for (const runtime of ["node", "bun"] as const) {
    test(`the daemon exits within the bound on SIGTERM with a host connected over TCP (${runtime})`, async () => {
      const branch = generateKeyPair();
      const host = generateKeyPair();
      saveKeyPair(branch, process.env.TPS_IDENTITY_DIR!, "branch");
      writeFileSync(
        join(process.env.TPS_IDENTITY_DIR!, "host.json"),
        JSON.stringify({ publicKey: Buffer.from(host.encryption.publicKey).toString("base64url") })
      );
      const port = await freePort();
      writeBranchConf(port, "127.0.0.1", "tcp", undefined, "agent-a");

      const env: NodeJS.ProcessEnv = { ...process.env, TPS_BRANCH_NO_DAEMON: "1" };
      delete env.TPS_BRANCH_DAEMON;
      child = spawn(runtime, [TPS_BIN, "branch", "start"], { env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child!.once("exit", (code, signal) => resolve({ code, signal }));
      });

      const channel = await connectHost(port, host, branch);
      cleanups.push(() => {
        void channel.close();
      });
      expect(channel.isAlive()).toBe(true);

      const started = Date.now();
      child.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), EXIT_BOUND_MS)),
      ]);
      if (result === "timeout") {
        child.kill("SIGKILL");
        await exited;
        const log = existsSync(join(process.env.TPS_ROOT!, "branch.log"))
          ? readFileSync(join(process.env.TPS_ROOT!, "branch.log"), "utf8")
          : "(no branch.log)";
        throw new Error(
          `the daemon did not exit within ${EXIT_BOUND_MS}ms of SIGTERM with a host connected; stderr=${stderr}; log=${log}`
        );
      }
      const elapsed = Date.now() - started;
      expect(result).toEqual({ code: 0, signal: null });
      expect(elapsed).toBeLessThan(EXIT_BOUND_MS);
    }, 30_000);
  }
});
