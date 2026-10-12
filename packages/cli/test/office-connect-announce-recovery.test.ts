/**
 * cli#602: `office connect` announces an accepted delivery when the attempt
 * that published its inbox record was killed before announcing it.
 *
 * The command runs as its own process against a REAL local relay built on the
 * branch-side WebSocket/Noise listener (`listenForHostWs`). A `bun --preload`
 * hook (test/helpers/office-kill-hook.mjs) blocks the command at one of two
 * step boundaries, both after the inbox record is published and before the
 * announcement is printed: `accept-marker`, the write of the acceptance
 * receipt's temp file, and `announce`, the `console.log` of the "Mail received"
 * line. The test SIGKILLs it there; a second command then reconnects and the
 * sender resends the same delivery. The test counts the "Mail received" lines
 * the two commands printed: at either boundary the delivery is announced
 * exactly once across both commands, and the inbox holds one record. A kill
 * after the line is printed and before its announcement marker is written is
 * not tested here; the delivery can then be announced again.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getInbox } from "../src/utils/mail.js";
import { SANDBOX_REQUIRED_FLAG } from "../src/utils/nono.js";
import { generateKeyPair, initHostIdentity, registerBranch } from "../src/utils/identity.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER, type MailDeliverBody } from "../src/utils/wire-mail.js";
import type { TransportChannel, TransportServer } from "../src/utils/transport.js";
import * as ws from "../src/utils/ws-noise-transport.js";

/** The CLI entry point, run from source so the test exercises this tree's command. */
const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
/** The preload that blocks the command at a named acceptance step boundary. */
const KILL_HOOK = fileURLToPath(new URL("./helpers/office-kill-hook.mjs", import.meta.url));
/** The text of the line `office connect` prints to announce a delivery. */
const ANNOUNCEMENT = "Mail received";
/** The hook's step boundaries, both after the inbox record is published and before the announcement is printed. */
const BOUNDARIES = ["accept-marker", "announce"] as const;

const ENV_KEYS = ["HOME", "TPS_ROOT", "TPS_MAIL_DIR", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON"];

/** Set HOME and TPS_ROOT to `root`, and TPS_MAIL_DIR, TPS_IDENTITY_DIR, TPS_REGISTRY_DIR below it. */
function isolateEnv(root: string, vaultKey: string): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.HOME = root;
  process.env.TPS_ROOT = root;
  process.env.TPS_BRANCH_NO_DAEMON = "1";
  process.env.TPS_MAIL_DIR = join(root, "mail");
  process.env.TPS_IDENTITY_DIR = join(root, "identity");
  process.env.TPS_REGISTRY_DIR = join(root, "registry");
  process.env.TPS_VAULT_KEY = vaultKey;
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function jsonFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}

function body(content: string): MailDeliverBody {
  return { id: randomUUID(), from: "remote", to: "local", content, timestamp: new Date().toISOString() };
}

/** Register branch `remote` (whose keys the relay holds) and point its remote.json at `port`. */
function registerRemote(root: string, port: number) {
  const kp = generateKeyPair();
  registerBranch("remote", kp.signing.publicKey, undefined, kp.encryption.publicKey);
  const branchDir = join(root, ".tps", "branch-office", "remote");
  fs.mkdirSync(branchDir, { recursive: true });
  fs.writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "127.0.0.1", port, transport: "ws" }));
  return kp;
}

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

/** Poll (bounded) until `ready()` holds; the failure names what was awaited. */
async function waitFor(what: string, ready: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A running `tps office connect`, with its output collected as it is read. */
interface Command {
  child: ChildProcess;
  closed: Promise<void>;
  output(): string;
  errors(): string;
  stop(): Promise<void>;
}

describe("tps office connect announces a delivery whose first attempt was killed before announcing it", () => {
  let root: string | undefined;
  let savedEnv: Record<string, string | undefined> = {};
  let relay: TransportServer | undefined;
  let connections: TransportChannel[] = [];
  let acks: string[] = [];
  let seq = 0;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "tps-connect-recovery-"));
    savedEnv = isolateEnv(root, "connect-recovery-test");
    connections = [];
    acks = [];
    seq = 0;
  });

  afterEach(async () => {
    try {
      const server = relay;
      relay = undefined;
      await server?.close();
    } finally {
      restoreEnv(savedEnv);
      savedEnv = {};
      const dir = root;
      root = undefined;
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Start `tps office connect remote --sandbox-required`. With `kill`, the
   * command runs under the preload that blocks at `kill.at` and writes
   * `kill.marker` just before blocking. Output is collected as it is read, so
   * it is complete once `closed` resolves.
   */
  function launch(kill?: { at: string; marker: string }): Command {
    let out = "";
    let err = "";
    const args = kill
      ? ["--preload", KILL_HOOK, TPS_BIN, "office", "connect", "remote", SANDBOX_REQUIRED_FLAG]
      : [TPS_BIN, "office", "connect", "remote", SANDBOX_REQUIRED_FLAG];
    const child = spawn(process.execPath, args, {
      env: kill ? { ...process.env, TPS_KILL_AT: kill.at, TPS_KILL_MARKER: kill.marker } : { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (data: string) => { out += data; });
    child.stderr!.on("data", (data: string) => { err += data; });
    const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
    return {
      child,
      closed,
      output: () => out,
      errors: () => err,
      async stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
        const exited = await Promise.race([closed.then(() => true), Bun.sleep(5000).then(() => false)]);
        if (!exited) {
          child.kill("SIGKILL");
          await closed;
        }
      },
    };
  }

  /** Count the "Mail received" lines in a command's output. */
  function announcements(command: Command): number {
    return command.output().split("\n").filter((line) => line.includes(ANNOUNCEMENT)).length;
  }

  /** Start the relay and register the branch it serves; collect its connections and ACKs. */
  async function startRelay(): Promise<void> {
    const port = await freePort();
    const branch = registerRemote(root!, port);
    const host = await initHostIdentity();
    const server = await ws.listenForHostWs(branch, host.encryption.publicKey, port, (msg) => {
      if (msg.type === MSG_MAIL_ACK) acks.push((msg.body as { id: string }).id);
    });
    relay = server;
    server.onConnection((channel) => { connections.push(channel); });
  }

  /** Send one MAIL_DELIVER and wait (bounded) for the command to ACK it. */
  async function deliver(channel: TransportChannel, delivery: MailDeliverBody): Promise<void> {
    const before = acks.filter((id) => id === delivery.id).length;
    await channel.send({ type: MSG_MAIL_DELIVER, seq: ++seq, ts: new Date().toISOString(), body: delivery });
    await waitFor(`the ACK for ${delivery.id}`, () => acks.filter((id) => id === delivery.id).length > before);
  }

  /**
   * Kill the first command at `boundary` with the delivery published but not
   * announced, then reconnect and resend the same delivery. Returns the
   * "Mail received" count across both commands.
   */
  async function countAfterInterruption(boundary: string): Promise<number> {
    await startRelay();
    const delivery = body("interrupted");
    const marker = join(root!, `paused.${boundary}`);

    const killed = launch({ at: boundary, marker });
    await waitFor("the first command to reach the relay", () => connections.length >= 1 || killed.child.exitCode !== null, 20_000);
    await connections[0]!.send({ type: MSG_MAIL_DELIVER, seq: ++seq, ts: new Date().toISOString(), body: delivery });
    await waitFor(`the first command to pause at ${boundary}`, () => fs.existsSync(marker), 20_000);
    killed.child.kill("SIGKILL");
    await killed.closed;

    const resumed = launch();
    await waitFor("the second command to reach the relay", () => connections.length >= 2 || resumed.child.exitCode !== null, 20_000);
    await deliver(connections[1]!, delivery);
    await resumed.stop();

    expect(jsonFiles(getInbox("local").fresh).length, `first stderr:\n${killed.errors()}\nsecond stderr:\n${resumed.errors()}`).toBe(1);
    return announcements(killed) + announcements(resumed);
  }

  for (const boundary of BOUNDARIES) {
    test(`the delivery killed at ${boundary} is announced once after reconnect`, async () => {
      expect(await countAfterInterruption(boundary)).toBe(1);
    }, 60_000);
  }
});
