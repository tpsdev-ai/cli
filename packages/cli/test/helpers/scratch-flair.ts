/**
 * scratch-flair.ts — ONE scratch Flair for the tests that cross the Flair seam.
 *
 * Every other cli test of a Flair interaction drives a fake. This helper starts a
 * REAL one instead: it installs the published `@tpsdev-ai/flair` package into a
 * throwaway prefix, boots the Harper that serves it on OS-chosen loopback ports
 * with an isolated HOME and a short-root data dir, and seeds one operator and two
 * agents. The real-Flair lane (`.github/workflows/real-flair.yml`) starts it once,
 * runs the tests that carry the `TPS_TEST_REAL_FLAIR=1` flag cli#591 introduced,
 * and tears it down in a `finally`.
 *
 * It is the real component on the far side of the seam: the CLI's FlairClient
 * signs with an Ed25519 key and Flair verifies that signature against the public
 * key it stores, so a test that reaches this instance fails when the client and
 * Flair disagree about the wire, the signature or the read scope.
 *
 * Names are neutral (`agent-a`, `agent-b`): a fixture must not name a real fleet
 * host or agent.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FlairClient } from "../../src/utils/flair-client.js";
import { generateKeyPair } from "../../src/utils/identity.js";

/** The published Flair the scratch instance runs. */
export const FLAIR_PACKAGE = "@tpsdev-ai/flair";
export const FLAIR_VERSION = "0.58.0";

/** The operator (Harper admin) credential the helper boots and seeds with. */
export const ADMIN_AUTH = "admin:test123";

/** The agents `startScratchFlair` seeds, by name. */
export const SEEDED_AGENTS = ["agent-a", "agent-b"] as const;

/** The data root's name under the scratch tree; kept short for unix sockets. */
const SCRATCH_PREFIX = "flair-test-";

/** How long to wait for the two listeners before failing with the boot log. */
const BOOT_TIMEOUT_MS = 180_000;

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
  const servers = await Promise.all(
    Array.from({ length: count }, () =>
      new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
    ),
  );
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  return ports;
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
    OPERATIONSAPI_NETWORK_PORT: String(opsPort),
    HTTP_PORT: `127.0.0.1:${httpPort}`,
  };
}

/** Poll a URL until it answers OK, or the deadline passes. */
async function waitForOk(url: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Terminate the Harper process and every process whose argv names this
 * instance's own scratch root. Positive pids only, and only ones matching the
 * root this helper created — never a pattern sweep and never another instance's
 * process.
 */
function killScratchProcesses(proc: ChildProcess, root: string, signal: NodeJS.Signals = "SIGTERM"): void {
  if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
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
  proc: ChildProcess;
  root: string;
}

/** Stop the instance and remove its tree. */
export async function stopScratchFlair(instance: ScratchProcess): Promise<void> {
  killScratchProcesses(instance.proc, instance.root);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  killScratchProcesses(instance.proc, instance.root, "SIGKILL");
  // Remove exactly the tree this helper created (never a variable from an earlier
  // shell, never a glob). A leftover is worse than a retry, so this throws.
  rmSync(instance.root, { recursive: true, force: true, maxRetries: 4 });
}

/** Boot the scratch instance: install Flair, boot Harper, seed the operator and two agents. */
export async function startScratchFlair(): Promise<ScratchFlair & ScratchProcess> {
  const root = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  const home = join(root, "home");
  const models = join(root, "models");
  const prefix = join(root, "install");
  mkdirSync(home, { recursive: true });
  mkdirSync(models, { recursive: true });
  mkdirSync(prefix, { recursive: true });

  // Install the published Flair (it brings Harper). Isolated prefix, isolated
  // npm cache (HOME is the scratch home), public registry only.
  execFileSync(
    "npm",
    ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel", "error", `${FLAIR_PACKAGE}@${FLAIR_VERSION}`],
    { env: { PATH: process.env.PATH ?? "", HOME: home, npm_config_cache: join(home, ".npm") }, stdio: "pipe", timeout: 300_000 },
  );

  const flairDir = join(prefix, "node_modules", "@tpsdev-ai", "flair");
  const harperBin = join(prefix, "node_modules", "harper", "dist", "bin", "harper.js");
  if (!existsSync(flairDir) || !existsSync(harperBin)) {
    throw new Error(`scratch Flair install is incomplete: ${flairDir} or ${harperBin} is missing`);
  }

  const [httpPort, opsPort] = await freePorts(2);
  const env = scratchEnv(root, home, models, httpPort, opsPort);
  execFileSync(NODE_BIN, [harperBin, "install"], { cwd: flairDir, env, stdio: "pipe", timeout: 120_000 });

  const proc = spawn(NODE_BIN, [harperBin, "run", "."], { cwd: flairDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (log += d.toString()));

  const httpUrl = `http://127.0.0.1:${httpPort}`;
  const opsUrl = `http://127.0.0.1:${opsPort}`;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  // HTTP /Health answers with the Flair version; the operator API's liveness
  // probe is /health (lowercase) on its own port.
  const httpUp = await waitForOk(`${httpUrl}/Health`, deadline);
  const opsUp = httpUp && (await waitForOk(`${opsUrl}/health`, deadline));
  if (!httpUp || !opsUp) {
    await stopScratchFlair({ proc, root });
    throw new Error(`scratch Flair did not start within ${BOOT_TIMEOUT_MS}ms (http=${httpUp} ops=${opsUp}). Boot log tail:\n${log.slice(-4000)}`);
  }

  const adminB64 = Buffer.from(ADMIN_AUTH).toString("base64");
  const ops = (body: unknown) =>
    fetch(opsUrl, { method: "POST", headers: { Authorization: `Basic ${adminB64}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

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
    await stopScratchFlair({ proc, root });
    throw new Error(`scratch Flair refused the seed insert (${seeded.status}): ${text.slice(0, 500)}`);
  }

  return { baseUrl: httpUrl, opsUrl, httpPort, opsPort, admin: ADMIN_AUTH, root, agents, ops, log: () => log, proc };
}

/**
 * Resolve the Flair a real-seam test talks to, from the environment. The lane
 * exports the instance's loopback ports (path-free, so the HOME-isolation
 * launcher passes them); `TPS_TEST_FLAIR_URL`/`_OPS_URL`/`_ADMIN` (the contract
 * cli#591 established) still win when a caller sets them directly.
 */
export function flairTarget(env: NodeJS.ProcessEnv = process.env): FlairTarget {
  const httpPort = env.TPS_TEST_FLAIR_HTTP_PORT;
  const opsPort = env.TPS_TEST_FLAIR_OPS_PORT;
  return {
    baseUrl: env.TPS_TEST_FLAIR_URL ?? (httpPort ? `http://127.0.0.1:${httpPort}` : "http://127.0.0.1:9926"),
    opsUrl: env.TPS_TEST_FLAIR_OPS_URL ?? (opsPort ? `http://127.0.0.1:${opsPort}` : "http://127.0.0.1:9925"),
    admin: env.TPS_TEST_FLAIR_ADMIN ?? ADMIN_AUTH,
  };
}

/** A fresh agent id for a test that must not collide with the seed or a sibling. */
export function freshAgentId(prefix = "agent"): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Create a keypair, register its public key through the operator API, and return a
 * signed client for it. The private key is written under the test's own temp dir.
 * A refused registration throws — a test must never run against a key Flair did
 * not store.
 */
export async function provisionAgent(
  target: FlairTarget,
  id: string = freshAgentId(),
): Promise<{ id: string; keyPath: string; publicKey: string; client: FlairClient }> {
  const keyPair = generateKeyPair();
  const keyPath = join(tmpdir(), `flair-key-${id}`);
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
  return { id, keyPath, publicKey, client: new FlairClient({ agentId: id, keyPath, baseUrl: target.baseUrl }) };
}
