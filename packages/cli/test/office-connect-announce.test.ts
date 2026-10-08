/**
 * cli#524: `office connect` announces a relayed message after the local
 * acceptance path (#532) has published its inbox record.
 *
 * Two layers, both against REAL inbox files under a mkdtemp root:
 *
 * - The command: `tps office connect` runs as its own process, from this tree's
 *   source, against a local relay built on the branch-side WebSocket/Noise
 *   listener (`listenForHostWs`). The test reads the command's stdout and
 *   counts its "Mail received" lines, so removing the command's announcement
 *   wiring fails it.
 * - The acceptance path: `connectAndKeepAlive` with its transport replaced by
 *   an in-memory channel, observed through the `onAccepted` callback: the
 *   callback runs after the inbox record is published, a resend is ACKed
 *   without it, and the refusals (a same-id conflict, an injected inbox write
 *   failure) never reach it.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectAndKeepAlive } from "../src/utils/relay.js";
import { getInbox } from "../src/utils/mail.js";
import { SANDBOX_REQUIRED_FLAG } from "../src/utils/nono.js";
import { generateKeyPair, initHostIdentity, registerBranch } from "../src/utils/identity.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER, type MailDeliverBody } from "../src/utils/wire-mail.js";
import type { TransportChannel, TransportServer, TpsMessage } from "../src/utils/transport.js";
import * as ws from "../src/utils/ws-noise-transport.js";

/** The CLI entry point, run from source so the test exercises this tree's command. */
const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
/** The line `office connect` prints for each accepted delivery. */
const ANNOUNCEMENT = "Mail received";

const ENV_KEYS = ["HOME", "TPS_ROOT", "TPS_MAIL_DIR", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON"];

/** Point every TPS path at `root`; returns the values it replaced. */
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

describe("tps office connect, run as a process against a local relay", () => {
  let root: string | undefined;
  let savedEnv: Record<string, string | undefined> = {};
  let relay: TransportServer | undefined;
  let child: ChildProcess | undefined;
  let childClosed: Promise<void> | undefined;
  let stdout = "";
  let stderr = "";
  /** The message id of every MAIL_ACK the relay received, in arrival order. */
  let acks: string[] = [];
  let seq = 0;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "tps-connect-command-"));
    savedEnv = isolateEnv(root, "connect-command-test");
    stdout = "";
    stderr = "";
    acks = [];
    seq = 0;
  });

  /**
   * Stop the command with SIGINT, which runs its own handler (stop the
   * keep-alive loop, then exit); SIGKILL if it has not closed within 5 s.
   * Resolves once the process has closed, so all of its output has been read.
   */
  async function stopCommand(): Promise<void> {
    const running = child;
    const closed = childClosed;
    child = undefined;
    childClosed = undefined;
    if (!running || !closed) return;
    if (running.exitCode === null && running.signalCode === null) running.kill("SIGINT");
    const exited = await Promise.race([closed.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!exited) {
      running.kill("SIGKILL");
      await closed;
    }
  }

  afterEach(async () => {
    // Each step runs in its own `finally`, so one that throws cannot skip the
    // steps after it.
    try {
      await stopCommand();
    } finally {
      try {
        const server = relay;
        relay = undefined;
        await server?.close();
      } finally {
        try {
          restoreEnv(savedEnv);
          savedEnv = {};
        } finally {
          const dir = root;
          root = undefined;
          if (dir) fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  /** Start the relay, then `tps office connect remote`; resolves with the relay's end of the channel. */
  async function startCommand(): Promise<TransportChannel> {
    const port = await freePort();
    const branch = registerRemote(root!, port);
    const host = await initHostIdentity();
    const server = await ws.listenForHostWs(branch, host.encryption.publicKey, port, (msg) => {
      if (msg.type === MSG_MAIL_ACK) acks.push((msg.body as { id: string }).id);
    });
    relay = server;
    let channel: TransportChannel | undefined;
    server.onConnection((connected) => { channel = connected; });

    // The argv the office supervisor's launchd unit runs (office-supervision.ts):
    // a non-interactive `office connect` is refused without the launcher's flag.
    const proc = spawn(process.execPath, [TPS_BIN, "office", "connect", "remote", SANDBOX_REQUIRED_FLAG], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    childClosed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (data: string) => { stdout += data; });
    proc.stderr!.on("data", (data: string) => { stderr += data; });

    await waitFor("office connect to reach the relay", () => channel !== undefined || proc.exitCode !== null, 20_000);
    if (!channel) throw new Error(`office connect exited before connecting:\n${stderr}`);
    return channel;
  }

  /** Send one MAIL_DELIVER and wait (bounded) for the command to ACK it. */
  async function deliver(channel: TransportChannel, delivery: MailDeliverBody): Promise<void> {
    const before = acks.filter((id) => id === delivery.id).length;
    await channel.send({ type: MSG_MAIL_DELIVER, seq: ++seq, ts: new Date().toISOString(), body: delivery });
    await waitFor(`the ACK for ${delivery.id}`, () => acks.filter((id) => id === delivery.id).length > before);
  }

  function announcements(): number {
    return stdout.split("\n").filter((line) => line.includes(ANNOUNCEMENT)).length;
  }

  test("prints \"Mail received\" once per newly recorded delivery; a resend is ACKed without another", async () => {
    const channel = await startCommand();

    const first = body("first");
    await deliver(channel, first);
    await waitFor("the first announcement", () => announcements() >= 1);
    expect(jsonFiles(getInbox("local").fresh).length).toBe(1);

    // A resend of the recorded delivery: same id, same payload.
    await deliver(channel, first);

    const second = body("second");
    await deliver(channel, second);
    await waitFor("the second announcement", () => announcements() >= 2);

    // The command prints a delivery's announcement before it sends that
    // delivery's ACK, so every line for these three deliveries was written
    // before the last ACK arrived. Once the process has closed, all of them
    // have been read: the count is exact.
    await stopCommand();
    expect(announcements(), `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(2);
    expect(jsonFiles(getInbox("local").fresh).length).toBe(2);
    expect(acks).toEqual([first.id, first.id, second.id]);
  }, 30_000);
});

describe("office connect announcement follows local acceptance", () => {
  let root: string | undefined;
  let savedEnv: Record<string, string | undefined> = {};
  let stop: (() => Promise<void>) | undefined;
  /** The spy on `WsNoiseTransport.prototype.connect`; restored after every test. */
  let connectSpy: { mockRestore(): void } | undefined;
  let handlers = new Set<(msg: TpsMessage) => void>();
  /**
   * Set when the keep-alive loop removes its message handler, which it does
   * only on its way out (the service-proxy handler it also registers is never
   * removed, so an empty `handlers` set is not the signal).
   */
  let loopDetached = false;
  let acks: TpsMessage[];
  /** The inbox record count observed each time an accepted delivery is announced. */
  let announced: number[];

  beforeEach(async () => {
    root = fs.mkdtempSync(join(tmpdir(), "tps-connect-announce-"));
    savedEnv = isolateEnv(root, "connect-announce-test");
    await initHostIdentity();
    registerRemote(root, 1);

    handlers = new Set();
    loopDetached = false;
    acks = [];
    announced = [];
    let alive = true;
    const channel: TransportChannel = {
      async send(msg) { if (msg.type === MSG_MAIL_ACK) acks.push(msg); },
      onMessage(handler) { handlers.add(handler); },
      offMessage(handler) { handlers.delete(handler); loopDetached = true; },
      async close() { alive = false; },
      isAlive() { return alive; },
      peerFingerprint() { return "remote"; },
    };
    connectSpy = spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
    stop = await connectAndKeepAlive("remote", {
      onAccepted: () => announced.push(jsonFiles(getInbox("local").fresh).length),
    });
    for (let i = 0; handlers.size === 0 && i < 200; i++) await Bun.sleep(5);
    expect(handlers.size).toBeGreaterThan(0);
  });

  afterEach(async () => {
    let detached = true;
    try {
      if (stop) await stop();
      // stop() returns before the keep-alive loop has finished: the loop checks
      // the channel once a second, then clears its timers and detaches its
      // handler. Wait (bounded) for that detach, so no loop from this test is
      // still running when the spy is restored and the next test file starts.
      // A loop that never attached (setup failed before connecting) has
      // nothing to wait for.
      if (handlers.size > 0) {
        for (let i = 0; !loopDetached && i < 200; i++) await Bun.sleep(10);
        detached = loopDetached;
      }
    } finally {
      // Each cleanup step runs in its own `finally`, so one that throws cannot
      // skip the steps after it. The spy is process-wide: left in place, every
      // later WsNoiseTransport.connect in this bun process would return this
      // file's fake channel instead of opening a socket.
      stop = undefined;
      handlers = new Set();
      loopDetached = false;
      try {
        const spy = connectSpy;
        connectSpy = undefined;
        spy?.mockRestore();
      } finally {
        try {
          restoreEnv(savedEnv);
          savedEnv = {};
        } finally {
          const dir = root;
          root = undefined;
          if (dir) fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
    expect(detached).toBe(true);
  });

  function deliver(delivery: MailDeliverBody): void {
    const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body: delivery };
    for (const handler of handlers) handler(msg);
  }

  /** Wait (bounded) for the in-flight acceptance's ACK to settle. */
  async function settled(): Promise<void> {
    for (let i = 0; i < 200 && acks.length === 0; i++) await Bun.sleep(5);
  }

  test("an accepted delivery is announced after its inbox record is published", async () => {
    deliver(body("hello"));
    await settled();
    expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
    expect(announced).toEqual([1]);
  });

  test("a resend of a recorded delivery is ACKed again and is not announced again", async () => {
    const accepted = body("recorded once");
    deliver(accepted);
    await settled();
    expect(announced).toEqual([1]);
    acks.length = 0;

    deliver(accepted);
    await settled();

    // The ACK is sent after the announcement decision, so it settles both.
    expect(acks.length).toBe(1);
    expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
    expect(announced).toEqual([1]);
  });

  test("a same-id conflict is not acknowledged and is not announced", async () => {
    const accepted = body("original payload");
    deliver(accepted);
    await settled();
    expect(announced).toEqual([1]);
    acks.length = 0;

    deliver({ ...accepted, content: "changed payload" });
    await Bun.sleep(50);

    expect(acks).toEqual([]);
    expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
    expect(announced).toEqual([1]);
  });

  test("a delivery whose inbox write fails is quarantined and is not announced", async () => {
    const inbox = getInbox("local");
    const write = fs.writeFileSync;
    let failed = false;
    const fault = spyOn(fs, "writeFileSync").mockImplementation((path, data, opts) => {
      if (!failed && String(path).startsWith(inbox.tmp)) {
        failed = true;
        throw new Error("injected transient inbox write failure");
      }
      return write(path, data, opts);
    });
    try {
      deliver(body("write fault"));
      await settled();
    } finally {
      fault.mockRestore();
    }
    expect(failed).toBe(true);
    expect(acks.length).toBe(1);
    expect(jsonFiles(inbox.fresh)).toEqual([]);
    expect(jsonFiles(inbox.dlq).length).toBe(1);
    expect(announced).toEqual([]);
  });
});
