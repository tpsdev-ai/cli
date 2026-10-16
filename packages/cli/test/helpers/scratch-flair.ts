/** Scratch Harper serving @tpsdev-ai/flair 0.58.0 for the real-Flair lane. */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { FlairClient } from "../../src/utils/flair-client.js";
import { generateKeyPair } from "../../src/utils/identity.js";

/** The published Flair the scratch instance runs. */
export const FLAIR_PACKAGE = "@tpsdev-ai/flair";
export const FLAIR_VERSION = "0.58.0";

/** The operator (Harper admin) credential the helper boots and seeds with. */
export const ADMIN_AUTH = "admin:test123";

/** The agents the lane seeds, by name. */
export const SEEDED_AGENTS = ["agent-a", "agent-b"] as const;

const SCRATCH_PREFIX = "flair-test-";

const BOOT_TIMEOUT_MS = 180_000;

const execFileAsync = promisify(execFile);

/**
 * The node binary the scratch Harper runs under. Harper's native modules need
 * node; the helper itself may run under bun, so this is resolved by name from PATH.
 */
const NODE_BIN = process.env.NODE_BIN ?? "node";

export interface ScratchAgent {
  id: string;
  /** The private key file, written under the scratch HOME's identity dir. */
  keyPath: string;
  /** The base64 public key stored in the agent's Flair row. */
  publicKey: string;
  /** A signed client for this agent, pointed at the scratch instance. */
  client: FlairClient;
}

export interface ScratchFlair {
  baseUrl: string;
  opsUrl: string;
  httpPort: number;
  opsPort: number;
  admin: string;
  root: string;
  agents: Record<string, ScratchAgent>;
  /** A POST to the operator API with the instance's admin credential. */
  ops(body: unknown): Promise<Response>;
  /** The captured stdout+stderr of the Harper process. */
  log(): string;
}

/** The Flair a real-seam test talks to: base URL, operator URL, operator credential. */
export interface FlairTarget {
  baseUrl: string;
  opsUrl: string;
  admin: string;
}

/** Ask the OS for `count` distinct free loopback TCP ports. */
async function freePorts(count: number): Promise<number[]> {
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push(server);
    }
    return servers.map((server) => (server.address() as AddressInfo).port);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

/** The environment the scratch Harper and its installer run under. */
function scratchEnv(root: string, home: string, models: string, httpPort: number, opsPort: number): NodeJS.ProcessEnv {
  // Built from names, not spread from the caller: no credential in this process's
  // environment (NPM_TOKEN, GITHUB_TOKEN, an operator's FLAIR_* variables) reaches
  // the child. PATH is passed so the tools Harper spawns are found.
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    ROOTPATH: root,
    HOME: home,
    DEFAULTS_MODE: "dev",
    HDB_ADMIN_USERNAME: "admin",
    HDB_ADMIN_PASSWORD: "test123",
    NODE_HOSTNAME: "127.0.0.1",
    THREADS_COUNT: "1",
    MQTT_NETWORK_PORT: "null",
    MQTT_NETWORK_SECUREPORT: "null",
    MQTT_WEBSOCKET: "false",
    THREADS_DEBUG: "false",
    FLAIR_MODELS_DIR: models,
    OPERATIONSAPI_NETWORK_PORT: `127.0.0.1:${opsPort}`,
    HTTP_PORT: `127.0.0.1:${httpPort}`,
  };
}

/** Poll a URL until it answers OK, or the deadline passes. */
export async function waitForOk(url: string, deadline: number, signal?: AbortSignal): Promise<boolean> {
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const res = await fetch(url, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now())))]) });
      await res.body?.cancel();
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(500, deadline - Date.now()))));
  }
  return false;
}

function killScratchProcesses(proc: ChildProcess | undefined, root: string, signal: NodeJS.Signals = "SIGTERM"): void {
  if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
    try {
      process.kill(proc.pid, signal);
    } catch {
      /* already gone */
    }
  }
  try {
    const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 5000 });
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid === process.pid || !match[2].includes(root)) continue;
      try {
        process.kill(pid, signal);
      } catch {
        /* gone between the scan and the signal */
      }
    }
  } catch {
    /* ps unreadable: the parent signal above is the best effort */
  }
}

/** The process handle and tree a `stopScratchFlair` call tears down. */
export interface ScratchProcess {
  proc?: ChildProcess;
  root: string;
}

/** Stop the instance and remove its tree. */
export async function stopScratchFlair(instance: ScratchProcess): Promise<void> {
  killScratchProcesses(instance.proc, instance.root);
  if (instance.proc) await new Promise((resolve) => setTimeout(resolve, 4000));
  killScratchProcesses(instance.proc, instance.root, "SIGKILL");
  rmSync(instance.root, { recursive: true, force: true, maxRetries: 4 });
}

export async function withScratchFlair<T>(
  run: (flair: ScratchFlair & ScratchProcess, signal: AbortSignal) => Promise<T>,
  initialize = initializeScratchFlair,
): Promise<T> {
  const instance: ScratchProcess = { root: mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)) };
  const controller = new AbortController();
  const terminate = () => controller.abort(new Error("real-Flair lane interrupted"));
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  try {
    const flair = await initialize(instance, controller.signal);
    controller.signal.throwIfAborted();
    const result = await run(flair, controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    try {
      await stopScratchFlair(instance);
    } finally {
      process.removeListener("SIGINT", terminate);
      process.removeListener("SIGTERM", terminate);
    }
  }
}

export function assertListenerAddresses(port: number, addresses: string[]): void {
  if (addresses.length === 0 || addresses.some((address) => address !== `127.0.0.1:${port}`)) {
    throw new ScratchFlairBindError(`real-flair lane: port ${port} must listen only on 127.0.0.1; got ${JSON.stringify(addresses)}`);
  }
}

/** The socket-table tools the listener checker can read a port through. */
export type DiscoveryTool = "lsof" | "ss";

/** The listening addresses on `port` as lsof reports them; an unbound port makes lsof exit non-zero. */
function lsofListeners(port: number): string[] {
  const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
  return out.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
}

/** The listening addresses on `port` as ss reports them; an empty list means no listener. */
function ssListeners(port: number): string[] {
  const out = execFileSync("ss", ["-H", "-ltn", "sport", "=", `:${port}`], { encoding: "utf8" });
  return out.trim().split("\n").filter(Boolean).map((line) => line.trim().split(/\s+/)[3]);
}

/**
 * Refuse any port not listening only on 127.0.0.1. With no `tool`, lsof is read
 * and ss takes over when lsof is not installed; a caller passing `tool` forces
 * that one tool, so a test can cover either path.
 */
export function assertLoopbackListeners(ports: number[], tool?: DiscoveryTool): void {
  for (const port of ports) {
    let addresses: string[];
    if (tool === "ss") {
      addresses = ssListeners(port);
    } else {
      try {
        addresses = lsofListeners(port);
      } catch (error) {
        if (tool === "lsof" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        addresses = ssListeners(port);
      }
    }
    assertListenerAddresses(port, addresses);
    console.log(`real-flair lane: listening socket ${port}: ${addresses.join(", ")}`);
  }
}

export class ScratchFlairBindError extends Error {
  override name = "ScratchFlairBindError";
}

async function bootScratchFlair(instance: ScratchProcess, signal: AbortSignal) {
  const { root } = instance;
  const home = join(root, "home");
  const models = join(root, "models");
  const prefix = join(root, "install");
  mkdirSync(home, { recursive: true });
  mkdirSync(models, { recursive: true });
  mkdirSync(prefix, { recursive: true });

  // Install the published Flair (it brings Harper). Isolated prefix, isolated
  // npm cache (HOME is the scratch home).
  await execFileAsync(
    "npm",
    ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel", "error", `${FLAIR_PACKAGE}@${FLAIR_VERSION}`],
    { env: { PATH: process.env.PATH ?? "", HOME: home, npm_config_cache: join(home, ".npm") }, signal, timeout: 300_000 },
  );

  const flairDir = join(prefix, "node_modules", "@tpsdev-ai", "flair");
  const harperBin = join(prefix, "node_modules", "harper", "dist", "bin", "harper.js");
  if (!existsSync(flairDir) || !existsSync(harperBin)) {
    throw new Error(`scratch Flair install is incomplete: ${flairDir} or ${harperBin} is missing`);
  }

  const [httpPort, opsPort] = await freePorts(2);
  const env = scratchEnv(root, home, models, httpPort, opsPort);
  await execFileAsync(NODE_BIN, [harperBin, "install"], { cwd: flairDir, env, signal, timeout: 120_000 });

  const proc = spawn(NODE_BIN, [harperBin, "run", "."], { cwd: flairDir, env, stdio: ["ignore", "pipe", "pipe"] });
  instance.proc = proc;
  let log = "";
  proc.once("error", (error) => { log += String(error); });
  proc.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (log += d.toString()));

  return { home, httpPort, opsPort, log: () => log };
}

export async function initializeScratchFlair(
  instance: ScratchProcess,
  signal: AbortSignal,
  boot = bootScratchFlair,
  checkListeners = assertLoopbackListeners,
): Promise<ScratchFlair & ScratchProcess> {
  const { home, httpPort, opsPort, log } = await boot(instance, signal);
  const { root, proc } = instance;
  const httpUrl = `http://127.0.0.1:${httpPort}`;
  const opsUrl = `http://127.0.0.1:${opsPort}`;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  // HTTP /Health answers with the Flair version; the operator API's liveness
  // probe is /health (lowercase) on its own port.
  const httpUp = await waitForOk(`${httpUrl}/Health`, deadline, signal);
  const opsUp = httpUp && (await waitForOk(`${opsUrl}/health`, deadline, signal));
  if (!httpUp || !opsUp) {
    throw new Error(`scratch Flair did not start within ${BOOT_TIMEOUT_MS}ms (http=${httpUp} ops=${opsUp}). Boot log tail:\n${log().slice(-4000)}`);
  }

  checkListeners([httpPort, opsPort]);

  const adminB64 = Buffer.from(ADMIN_AUTH).toString("base64");
  const ops = (body: unknown) =>
    fetch(opsUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), method: "POST", headers: { Authorization: `Basic ${adminB64}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const keysDir = join(home, ".tps", "identity");
  mkdirSync(keysDir, { recursive: true });

  // Seed two agents, each with an Ed25519 keypair: the private key lands in the
  // scratch HOME (what a signed client reads), the public key in the agent's Flair
  // row (what Flair verifies against). The operator is Harper's admin credential.
  const records: Array<Record<string, string>> = [];
  const agents: Record<string, ScratchAgent> = {};
  for (const id of SEEDED_AGENTS) {
    const keyPair = generateKeyPair();
    const keyPath = join(keysDir, `${id}.key`);
    writeFileSync(keyPath, Buffer.from(keyPair.signing.privateKey), { mode: 0o600 });
    const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64");
    records.push({ id, name: id, publicKey, createdAt: new Date().toISOString() });
    agents[id] = { id, keyPath, publicKey, client: new FlairClient({ agentId: id, keyPath, baseUrl: httpUrl }) };
  }
  const seeded = await ops({ operation: "insert", database: "flair", table: "Agent", records });
  if (!seeded.ok) {
    const text = await seeded.text().catch(() => "");
    throw new Error(`scratch Flair refused the seed insert (${seeded.status}): ${text.slice(0, 500)}`);
  }

  const warmupStarted = performance.now();
  await agents[SEEDED_AGENTS[0]].client.writeMemory("embedding-warmup", "Warm the embedding model before the real-Flair tests.");
  console.log(`real-flair lane: embedding warm-up took ${Math.round(performance.now() - warmupStarted)}ms`);

  return { baseUrl: httpUrl, opsUrl, httpPort, opsPort, admin: ADMIN_AUTH, root, agents, ops, log, proc };
}

function parsePort(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`real-flair lane: ${name} must be a decimal integer in 1–65535`);
  }
  return port;
}

export function flairTarget(env: NodeJS.ProcessEnv = process.env): FlairTarget {
  const httpPort = parsePort(env.TPS_TEST_FLAIR_HTTP_PORT, "TPS_TEST_FLAIR_HTTP_PORT", 9926);
  const opsPort = parsePort(env.TPS_TEST_FLAIR_OPS_PORT, "TPS_TEST_FLAIR_OPS_PORT", 9925);
  return {
    baseUrl: env.TPS_TEST_FLAIR_URL ?? `http://127.0.0.1:${httpPort}`,
    opsUrl: env.TPS_TEST_FLAIR_OPS_URL ?? `http://127.0.0.1:${opsPort}`,
    admin: env.TPS_TEST_FLAIR_ADMIN ?? ADMIN_AUTH,
  };
}

/** A fresh agent id for a test that must not collide with the seed or a sibling. */
export function freshAgentId(prefix = "agent"): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Create a keypair, register its public key through the operator API, and return a
 * signed client for it. Call cleanup when the client is no longer needed.
 * A non-OK registration response throws.
 */
export async function provisionAgent(
  target: FlairTarget,
  id: string = freshAgentId(),
): Promise<{ id: string; keyPath: string; publicKey: string; client: FlairClient; cleanup(): void }> {
  const keyPair = generateKeyPair();
  const keyDir = mkdtempSync(join(tmpdir(), "flair-agent-"));
  const cleanup = () => rmSync(keyDir, { recursive: true, force: true });
  try {
    const keyPath = join(keyDir, "flair-key-private");
    writeFileSync(keyPath, Buffer.from(keyPair.signing.privateKey), { mode: 0o600 });
    const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64");
    const adminB64 = Buffer.from(target.admin).toString("base64");
    const registered = await fetch(target.opsUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${adminB64}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent", records: [{ id, name: id, publicKey, createdAt: new Date().toISOString() }] }),
    });
    if (!registered.ok) {
      const text = await registered.text().catch(() => "");
      throw new Error(`provisionAgent could not register ${id} (${registered.status}): ${text.slice(0, 300)}`);
    }
    return { id, keyPath, publicKey, client: new FlairClient({ agentId: id, keyPath, baseUrl: target.baseUrl }), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
