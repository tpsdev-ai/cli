/**
 * Sandbox VM utilities — direct socket access to Docker AI Sandboxes.
 *
 * Workaround for Docker Sandbox CLI v0.11.0 `exec` bug:
 * `docker sandbox exec` can't find running sandboxes, but each VM
 * exposes its own Docker daemon socket at:
 *   ~/.docker/sandboxes/vm/<name>/docker.sock
 *
 * We bypass `docker sandbox exec` and talk to the VM's daemon directly.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import snooplogg from "snooplogg";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:sandbox");


export interface SandboxInfo {
  name: string;
  agent: string;
  status: string;
  socketPath: string;
}

/**
 * Get the Docker daemon socket path for a sandbox VM.
 */
export function sandboxSocketPath(name: string): string {
  return join(
    process.env.HOME || homedir(),
    ".docker",
    "sandboxes",
    "vm",
    name,
    "docker.sock"
  );
}

/**
 * Check if a sandbox VM's Docker daemon is accessible.
 */
export function isSandboxReady(name: string): boolean {
  const sock = sandboxSocketPath(name);
  if (!existsSync(sock)) return false;

  const result = spawnSync("docker", ["-H", `unix://${sock}`, "info"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return result.status === 0;
}

/**
 * List sandboxes via `docker sandbox ls --json`.
 */
export function listSandboxes(): SandboxInfo[] {
  const result = spawnSync("docker", ["sandbox", "ls", "--json"], {
    encoding: "utf-8",
    timeout: 10000,
  });
  if (result.status !== 0) return [];

  try {
    const parsed = JSON.parse(result.stdout || "{}") as {
      vms?: Array<{ name: string; agent: string; status: string; socket_path?: string }>;
    };
    return (parsed.vms || []).map((vm) => ({
      name: vm.name,
      agent: vm.agent,
      status: vm.status,
      socketPath: vm.socket_path || sandboxSocketPath(vm.name),
    }));
  } catch {
    return [];
  }
}

/**
 * Execute a command inside a sandbox VM's Docker daemon.
 * Runs a container with the workspace mounted.
 */
export function sandboxExec(
  sandboxName: string,
  command: string[],
  options: { workspace?: string; image?: string } = {}
): SpawnSyncReturns<string> {
  const sock = sandboxSocketPath(sandboxName);
  const image = options.image || "alpine:latest";

  const args = ["-H", `unix://${sock}`, "run", "--rm"];

  if (options.workspace) {
    args.push("-v", `${options.workspace}:${options.workspace}`);
    args.push("-w", options.workspace);
  }

  args.push(image, ...command);

  return spawnSync("docker", args, {
    encoding: "utf-8",
    timeout: 60000,
  });
}

/**
 * Load an image into a sandbox VM by piping from host.
 * Uses `docker save | docker -H unix://<sock> load`.
 */
export function loadImageIntoSandbox(sandboxName: string, imageName: string): boolean {
  const sock = sandboxSocketPath(sandboxName);

  // Check if image exists in sandbox already
  const check = spawnSync("docker", ["-H", `unix://${sock}`, "images", "-q", imageName], {
    encoding: "utf-8",
    timeout: 10000,
  });
  if (check.status === 0 && check.stdout.trim()) {
    return true; // Already loaded
  }

  // Save from host and load into sandbox
  // Use --config with user-owned dir to bypass credential helper issues
  const noauthDir = join(process.env.HOME || homedir(), ".tps", "tmp", "docker-noauth");
  mkdirSync(noauthDir, { recursive: true });
  const save = spawnSync("docker", ["--config", noauthDir, "save", imageName], {
    timeout: 60000,
    maxBuffer: 500 * 1024 * 1024, // 500MB
  });
  if (save.status !== 0) return false;

  const load = spawnSync("docker", ["-H", `unix://${sock}`, "load"], {
    input: save.stdout,
    encoding: "utf-8",
    timeout: 60000,
  });
  return load.status === 0;
}

/**
 * Wait for a sandbox VM to become ready (socket accessible).
 */
export function waitForSandbox(name: string, timeoutMs = 30000): boolean {
  const sock = sandboxSocketPath(name);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isSandboxReady(name)) return true;
    // If socket parent dir doesn't exist, Docker's internal layout may have changed
    const parentDir = join(sock, "..");
    if (Date.now() - start > 15000 && !existsSync(parentDir)) {
      serror(
        `Docker Sandbox socket path not found: ${parentDir}\n` +
        `Docker may have changed its internal layout. Expected socket at:\n  ${sock}`
      );
      return false;
    }
    spawnSync("sleep", ["1"]);
  }
  return false;
}
