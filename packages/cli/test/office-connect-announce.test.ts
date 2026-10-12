import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
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
 *   callback runs after the inbox record is published; a resend whose matching,
 *   unexpired marker syncs its file and directory is ACKed without it. The
 *   refusals (a same-id conflict, an injected inbox write failure) never reach
 *   it. cli#602: callback errors and marker write or sync failures withhold the
 *   ACK. Cleanup attempts removal; a retained marker that later counts permits
 *   the ACK without another callback. Otherwise a resend that recovers the
 *   matching record outside the dead-letter queue and successfully writes or
 *   syncs its receipt attempts the callback again; it records an announcement
 *   only if the callback completes and the marker write and sync succeed.
 *   A marker left by an earlier payload does not count for a new payload.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectAndKeepAlive, relayAcceptanceReceiptPath } from "../src/utils/relay.js";
import { getInbox } from "../src/utils/mail.js";
import { SANDBOX_REQUIRED_FLAG } from "../src/utils/nono.js";
import { generateKeyPair, initHostIdentity, registerBranch } from "../src/utils/identity.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER, type MailDeliverBody } from "../src/utils/wire-mail.js";
import type { TransportChannel, TransportServer, TpsMessage } from "../src/utils/transport.js";
import * as ws from "../src/utils/ws-noise-transport.js";

afterEach(() => {
  mock.restore();
});

/** The CLI entry point, run from source so the test exercises this tree's command. */
const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
/** The line `office connect` prints to announce a delivery. */
const ANNOUNCEMENT = "Mail received";

const ENV_KEYS = ["HOME", "TPS_ROOT", "TPS_MAIL_DIR", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON", "TPS_RELAY_ACCEPT_RECEIPT_TTL_MS"];

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

    // The logging call precedes the ACK. After the process closes, count its output.
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
  const connectSpyState = { value: undefined as { mockRestore(): void } | undefined };
  let handlers = new Set<(msg: TpsMessage) => void>();
  /**
   * Set when the keep-alive loop removes its message handler, which it does
   * only on its way out (the service-proxy handler it also registers is never
   * removed, so an empty `handlers` set is not the signal).
   */
  let loopDetached = false;
  let acks: TpsMessage[];
  /** The inbox record count observed at each announcement. */
  let announced: number[];
  let onAcceptedError: Error | undefined;
  let onAcceptedHook: (() => void) | undefined;

  beforeEach(async () => {
    root = fs.mkdtempSync(join(tmpdir(), "tps-connect-announce-"));
    savedEnv = isolateEnv(root, "connect-announce-test");
    await initHostIdentity();
    registerRemote(root, 1);

    handlers = new Set();
    loopDetached = false;
    acks = [];
    announced = [];
    onAcceptedError = undefined;
    onAcceptedHook = undefined;
    let alive = true;
    const channel: TransportChannel = {
      async send(msg) { if (msg.type === MSG_MAIL_ACK) acks.push(msg); },
      onMessage(handler) { handlers.add(handler); },
      offMessage(handler) { handlers.delete(handler); loopDetached = true; },
      async close() { alive = false; },
      isAlive() { return alive; },
      peerFingerprint() { return "remote"; },
    };
    patchShared(connectSpyState, "value", spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel));
    stop = await connectAndKeepAlive("remote", {
      onAccepted: () => {
        announced.push(jsonFiles(getInbox("local").fresh).length);
        if (onAcceptedError) throw onAcceptedError;
        return onAcceptedHook?.();
      },
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
        const spy = connectSpyState.value;
        patchShared(connectSpyState, "value", undefined);
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

  /** The announcement marker of a delivery from branch `remote` (cli#602). */
  function announcementMarker(id: string): string {
    return join(process.env.TPS_MAIL_DIR!, ".relay-announced", "by-branch", "remote", id);
  }

  /** The line the keep-alive loop logs when an acceptance is refused after publication. */
  function refusal(delivery: MailDeliverBody, reason: string): string {
    return `[relay] acceptance failed for message ${delivery.id} to ${delivery.to}: ${reason}`;
  }

  test("a new delivery is announced after its inbox record is published", async () => {
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

  test("an onAccepted exception withholds the ACK and records no announcement", async () => {
    const accepted = body("private message content");
    onAcceptedError = new Error(`announcement failed: ${accepted.content}`);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      deliver(accepted);
      await waitFor("the refusal to be logged", () => errors.mock.calls.length > 0, 2000);
      await Bun.sleep(20);
      expect(acks).toEqual([]);
      const inbox = getInbox("local").fresh;
      const records = jsonFiles(inbox);
      expect(records.length).toBe(1);
      expect(JSON.parse(fs.readFileSync(join(inbox, records[0]!), "utf8")).body).toBe(accepted.content);
      expect(announced).toEqual([1]);
      expect(fs.existsSync(announcementMarker(accepted.id))).toBe(false);
      expect(errors.mock.calls).toEqual([[refusal(accepted, `relay announcement failed for message ${accepted.id}; retry delivery`)]]);
      expect(errors.mock.calls.flat().join("\n")).not.toContain(accepted.content);
    } finally {
      errors.mockRestore();
    }
  });

  test("a resend after a failed announcement is ACKed when the callback and marker write succeed", async () => {
    const accepted = body("announced on the resend");
    onAcceptedError = new Error("announcement failed");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      deliver(accepted);
      await waitFor("the refusal to be logged", () => errors.mock.calls.length > 0, 2000);
      expect(acks).toEqual([]);
      const inbox = getInbox("local").fresh;
      const records = jsonFiles(inbox);
      expect(records.length).toBe(1);

      // The sender resends the unacknowledged delivery; the announcement now succeeds.
      onAcceptedError = undefined;
      deliver(accepted);
      await settled();
      expect(acks).toEqual([{
        type: MSG_MAIL_ACK, seq: 1, ts: expect.any(String), body: { id: accepted.id, accepted: true },
      }]);
      expect(jsonFiles(inbox)).toEqual(records);
      expect(announced).toEqual([1, 1]);
      expect(fs.existsSync(announcementMarker(accepted.id))).toBe(true);

      // Its announcement is recorded: a further resend is ACKed without another.
      acks.length = 0;
      deliver(accepted);
      await settled();
      expect(acks.length).toBe(1);
      expect(announced).toEqual([1, 1]);
      expect(errors.mock.calls.length).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });

  for (const kind of ["async", "thenable"] as const) {
    test(`an onAccepted returning a pending ${kind === "async" ? "promise" : "thenable"} holds the ACK until it resolves, then records the announcement`, async () => {
      const accepted = body("announced asynchronously");
      let resolve: () => void = () => {};
      const pending = new Promise<void>((done) => { resolve = done; });
      onAcceptedHook = kind === "async"
        ? async () => { await pending; }
        : () => ({ then: pending.then.bind(pending) });
      deliver(accepted);
      await waitFor("the announcement to start", () => announced.length === 1, 2000);
      await Bun.sleep(50);
      expect(acks).toEqual([]);
      expect(fs.existsSync(announcementMarker(accepted.id))).toBe(false);

      resolve();
      await settled();
      expect(acks).toEqual([{
        type: MSG_MAIL_ACK, seq: 1, ts: expect.any(String), body: { id: accepted.id, accepted: true },
      }]);
      expect(fs.existsSync(announcementMarker(accepted.id))).toBe(true);

      acks.length = 0;
      deliver(accepted);
      await settled();
      expect(acks.length).toBe(1);
      expect(announced).toEqual([1]);
    });

    test(`an onAccepted whose ${kind === "async" ? "promise" : "thenable"} rejects withholds the ACK without an unhandled rejection; a resend with a successful callback announces it`, async () => {
      const accepted = body("private async message content");
      let reject: (reason: Error) => void = () => {};
      const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
      onAcceptedHook = kind === "async"
        ? async () => { await pending; }
        : () => ({ then: pending.then.bind(pending) });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        deliver(accepted);
        await waitFor("the announcement to start", () => announced.length === 1, 2000);
        await Bun.sleep(50);
        expect(acks).toEqual([]);
        expect(errors.mock.calls).toEqual([]);
        const inbox = getInbox("local").fresh;
        const records = jsonFiles(inbox);
        expect(records.length).toBe(1);
        expect(JSON.parse(fs.readFileSync(join(inbox, records[0]!), "utf8")).body).toBe(accepted.content);

        reject(new Error(`announcement failed: ${accepted.content}`));
        await waitFor("the refusal to be logged", () => errors.mock.calls.length > 0, 2000);
        await Bun.sleep(20);
        expect(acks).toEqual([]);
        expect(unhandled).toEqual([]);
        expect(fs.existsSync(announcementMarker(accepted.id))).toBe(false);
        expect(errors.mock.calls).toEqual([[refusal(accepted, `relay announcement failed for message ${accepted.id}; retry delivery`)]]);
        expect(errors.mock.calls.flat().join("\n")).not.toContain(accepted.content);

        onAcceptedHook = undefined;
        deliver(accepted);
        await settled();
        expect(acks.length).toBe(1);
        expect(jsonFiles(inbox)).toEqual(records);
        expect(announced).toEqual([1, 1]);
        expect(errors.mock.calls.length).toBe(1);
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
        errors.mockRestore();
      }
    });
  }

  test.skipIf(process.getuid?.() === 0)("a read-only marker directory withholds the ACK; restoring write access permits the resend's announcement", async () => {
    const accepted = body("marker directory read-only");
    // A real permission fault: the marker directory exists and cannot be written.
    const markers = join(process.env.TPS_MAIL_DIR!, ".relay-announced", "by-branch", "remote");
    fs.mkdirSync(markers, { recursive: true });
    fs.chmodSync(markers, 0o500);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      deliver(accepted);
      await waitFor("the refusal to be logged", () => errors.mock.calls.length > 0, 2000);
      await Bun.sleep(20);
      expect(acks).toEqual([]);
      expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
      expect(announced).toEqual([1]);
      expect(fs.readdirSync(markers)).toEqual([]);
      expect(errors.mock.calls).toEqual([[refusal(accepted, `relay announcement marker write failed for message ${accepted.id}; retry delivery`)]]);

      // The announcement was output but not recorded, so the resend announces it again.
      fs.chmodSync(markers, 0o700);
      deliver(accepted);
      await settled();
      expect(acks.length).toBe(1);
      expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
      expect(announced).toEqual([1, 1]);
      expect(fs.existsSync(announcementMarker(accepted.id))).toBe(true);
    } finally {
      fs.chmodSync(markers, 0o700);
      errors.mockRestore();
    }
  });

  test("a one-shot marker temp-file fsync failure withholds the ACK; the resend announces again", async () => {
    const accepted = body("marker fsync fault");
    const markers = join(process.env.TPS_MAIL_DIR!, ".relay-announced", "by-branch", "remote");
    const open = fs.openSync;
    const sync = fs.fsyncSync;
    const markerFds = new Set<number>();
    let failed = false;
    const opens = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      const fd = open(path, flags, mode);
      if (String(path).startsWith(`${markers}/`) && String(path).endsWith(".tmp")) markerFds.add(fd);
      return fd;
    });
    const syncs = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (!failed && markerFds.has(fd)) {
        failed = true;
        throw Object.assign(new Error("injected marker fsync failure"), { code: "EIO" });
      }
      return sync(fd);
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      deliver(accepted);
      await waitFor("the refusal to be logged", () => errors.mock.calls.length > 0, 2000);
      await Bun.sleep(20);
      expect(failed).toBe(true);
      expect(acks).toEqual([]);
      expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
      expect(announced).toEqual([1]);
      expect(fs.readdirSync(markers)).toEqual([]);
      expect(errors.mock.calls).toEqual([[refusal(accepted, `relay announcement marker write failed for message ${accepted.id}; retry delivery`)]]);

      deliver(accepted);
      await settled();
      expect(acks.length).toBe(1);
      expect(announced).toEqual([1, 1]);
      expect(fs.existsSync(announcementMarker(accepted.id))).toBe(true);
    } finally {
      opens.mockRestore();
      syncs.mockRestore();
      errors.mockRestore();
    }
  });

  /**
   * Fail fsync on the announcement-marker DIRECTORY (fds opened on that path)
   * while `faults.dirSync` holds, and unlink of `faults.unlinkPath` while set.
   */
  function markerDirectoryFaults(markers: string) {
    const open = fs.openSync;
    const sync = fs.fsyncSync;
    const unlink = fs.unlinkSync;
    // Every open is recorded, so a descriptor number reused for another file is not mistaken for the directory.
    const opened = new Map<number, string>();
    const faults = { dirSync: "once" as "once" | "always" | "off", fired: 0, unlinkPath: undefined as string | undefined };
    const opens = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      const fd = open(path, flags, mode);
      opened.set(fd, String(path));
      return fd;
    });
    const syncs = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (faults.dirSync !== "off" && opened.get(fd) === markers) {
        faults.fired++;
        if (faults.dirSync === "once") faults.dirSync = "off";
        throw Object.assign(new Error("injected marker directory fsync failure"), { code: "EIO" });
      }
      return sync(fd);
    });
    const unlinks = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (faults.unlinkPath !== undefined && String(path) === faults.unlinkPath) {
        throw Object.assign(new Error("injected marker unlink failure"), { code: "EACCES" });
      }
      return unlink(path);
    });
    const restore = () => { opens.mockRestore(); syncs.mockRestore(); unlinks.mockRestore(); };
    return { faults, restore };
  }

  test("a one-shot marker directory sync failure with successful removal withholds the ACK; the resend announces again", async () => {
    const accepted = body("marker directory fsync fault");
    const markers = join(process.env.TPS_MAIL_DIR!, ".relay-announced", "by-branch", "remote");
    const { faults, restore } = markerDirectoryFaults(markers);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      deliver(accepted);
      await waitFor("the refusal to be logged", () => errors.mock.calls.length > 0, 2000);
      await Bun.sleep(20);
      expect(faults.fired).toBe(1);
      expect(acks).toEqual([]);
      expect(announced).toEqual([1]);
      expect(fs.readdirSync(markers)).toEqual([]);
      expect(errors.mock.calls).toEqual([[refusal(accepted, `relay announcement marker write failed for message ${accepted.id}; retry delivery`)]]);

      // No marker stands for the failed write: the resend announces, then is ACKed.
      deliver(accepted);
      await settled();
      expect(acks.length).toBe(1);
      expect(announced).toEqual([1, 1]);
      expect(fs.existsSync(announcementMarker(accepted.id))).toBe(true);
    } finally {
      restore();
      errors.mockRestore();
    }
  });

  test("a retained marker cannot authorize an ACK while its directory sync fails; once it syncs, the resend is ACKed without another announcement", async () => {
    const accepted = body("unconfirmed marker");
    const markers = join(process.env.TPS_MAIL_DIR!, ".relay-announced", "by-branch", "remote");
    const marker = announcementMarker(accepted.id);
    const { faults, restore } = markerDirectoryFaults(markers);
    // The directory sync keeps failing, and the renamed marker cannot be removed.
    faults.dirSync = "always";
    faults.unlinkPath = marker;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      deliver(accepted);
      await waitFor("the first refusal to be logged", () => errors.mock.calls.length > 0, 2000);
      await Bun.sleep(20);
      expect(acks).toEqual([]);
      expect(announced).toEqual([1]);
      expect(fs.existsSync(marker)).toBe(true);

      // The resend finds the unconfirmed marker, cannot sync its directory, and
      // announces again rather than ACKing on it.
      deliver(accepted);
      await waitFor("the resend to be refused or ACKed", () => errors.mock.calls.length > 1 || acks.length > 0, 2000);
      await Bun.sleep(20);
      expect(acks).toEqual([]);
      expect(announced).toEqual([1, 1]);
      const refused = refusal(accepted, `relay announcement marker write failed for message ${accepted.id}; retry delivery`);
      expect(errors.mock.calls).toEqual([[refused], [refused]]);

      // Once the marker and its directory sync, it stands for the announcement.
      faults.dirSync = "off";
      faults.unlinkPath = undefined;
      deliver(accepted);
      await settled();
      expect(acks.length).toBe(1);
      expect(announced).toEqual([1, 1]);
    } finally {
      restore();
      errors.mockRestore();
    }
  });

  test("a marker left by an earlier payload under the same id does not silence a new payload once the receipt has expired", async () => {
    const ttlMs = 60_000;
    process.env.TPS_RELAY_ACCEPT_RECEIPT_TTL_MS = String(ttlMs);
    const earlier = body("earlier payload");
    deliver(earlier);
    await settled();
    expect(announced).toEqual([1]);
    const marker = announcementMarker(earlier.id);
    expect(fs.existsSync(marker)).toBe(true);

    // The earlier record has left the mailbox and its receipt has expired; its
    // announcement marker has not.
    const inbox = getInbox("local").fresh;
    for (const record of jsonFiles(inbox)) fs.unlinkSync(join(inbox, record));
    const receipt = relayAcceptanceReceiptPath("remote", earlier.id);
    const expired = new Date(Date.now() - 2 * ttlMs);
    fs.utimesSync(receipt, expired, expired);
    expect(Date.now() - fs.statSync(marker).mtimeMs).toBeLessThan(ttlMs);

    // Same branch and id, different content: published, and announced.
    acks.length = 0;
    const later = { ...earlier, content: "later payload" };
    deliver(later);
    await settled();
    expect(acks.length).toBe(1);
    const records = jsonFiles(inbox);
    expect(records.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(join(inbox, records[0]!), "utf8")).body).toBe(later.content);
    expect(announced).toEqual([1, 1]);

    // The marker now records the later payload: its resend is not announced again.
    acks.length = 0;
    deliver(later);
    await settled();
    expect(acks.length).toBe(1);
    expect(announced).toEqual([1, 1]);
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

  test("an inbox write failure is unacked and unannounced", async () => {
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
    expect(acks.length).toBe(0);
    expect(jsonFiles(inbox.fresh)).toEqual([]);
    expect(jsonFiles(inbox.dlq)).toEqual([]);
    expect(announced).toEqual([]);
  });
});
