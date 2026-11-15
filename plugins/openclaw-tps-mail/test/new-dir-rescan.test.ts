import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { relayAcceptanceLockRoot, signEnvelope } from "@tpsdev-ai/agent";
import * as mail from "@tpsdev-ai/cli/utils/mail";
import pluginModule, { MAX_NEW_FILE_TRANSIENT_FAILURES, NEW_DIR_RESCAN_MS, rearmBackoffTicks } from "../src/index.js";

hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());
const seed = Buffer.alloc(32, 0x01);
const realPromote = mail.promote;
const realReaddir = fsPromises.readdir;
const realSetInterval = globalThis.setInterval;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// Shorten the interval with real timers; leave the watcher debounce unchanged.
const intervalMs = 200;

async function until(predicate: () => boolean, timeout = 3000): Promise<boolean> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeout) await sleep(5);
  return predicate();
}

let plugin: any;
pluginModule.register({
  registerChannel: (registered: any) => { plugin = registered.plugin; },
  logger: { info() {}, warn() {}, error() {} },
} as any);

describe("new/ periodic rescan (cli#853)", () => {
  let root: string;
  let newDir: string;
  let controller: AbortController;
  let start: Promise<void> | undefined;
  let suppressWatch: boolean;
  let watchCalls: number;
  let notifyWatch: ((filename: string) => void) | undefined;
  let beforeTick: (() => void) | undefined;
  let ticks: number;
  let intervals: ReturnType<typeof setInterval>[];
  let logs: string[];
  let dispatches: string[];
  let verifyGate: Promise<void> | undefined;
  let releaseVerify: (() => void) | undefined;
  let verifyUnavailable: boolean;
  let verifyBadSignature: boolean;
  let consoleErrors: string[];
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let watchSpy: ReturnType<typeof spyOn>;
  let watcher: fs.FSWatcher | undefined;
  let closedWatchers: Set<object>;
  let watcherEvents: Array<{ kind: "watch" | "close"; watcher: object }>;
  let timerSpy: ReturnType<typeof spyOn>;
  let promoteSpy: ReturnType<typeof spyOn>;
  let readSpy: ReturnType<typeof spyOn> | undefined;
  let blockedRelayRoots: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "tps-new-rescan-"));
    newDir = join(root, "recipient", "new");
    fs.mkdirSync(newDir, { recursive: true });
    controller = new AbortController();
    start = undefined;
    suppressWatch = true;
    watchCalls = 0;
    notifyWatch = undefined;
    beforeTick = undefined;
    ticks = 0;
    intervals = [];
    logs = [];
    dispatches = [];
    verifyGate = undefined;
    releaseVerify = undefined;
    verifyUnavailable = false;
    verifyBadSignature = false;
    consoleErrors = [];
    consoleErrorSpy = spyOn(console, "error").mockImplementation((...args: any[]) => {
      consoleErrors.push(args.map(String).join(" "));
    });
    readSpy = undefined;
    blockedRelayRoots = [];
    watcher = undefined;
    closedWatchers = new Set();
    watcherEvents = [];
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
          if (verifyGate) await verifyGate;
          if (verifyUnavailable) throw new Error("injected verification outage");
          if (name !== "flint") return null;
          const keySeed = verifyBadSignature ? Buffer.alloc(32, 0x09) : seed;
          return { publicKey: Buffer.from(ed.getPublicKey(keySeed)) };
        },
      }),
    }));
    // Stub OS notifications; real files still traverse promote and verification.
    watchSpy = spyOn(fs, "watch").mockImplementation(((_path: any, _options: any, listener: any) => {
      notifyWatch = (filename) => {
        if (!suppressWatch) { watchCalls++; listener("rename", filename); }
      };
      return stubWatcher();
    }) as typeof fs.watch);
    timerSpy = spyOn(globalThis, "setInterval").mockImplementation(((fn: any, ms: number, ...args: any[]) => {
      if (ms !== NEW_DIR_RESCAN_MS) return realSetInterval(fn, ms, ...args);
      const timer = realSetInterval(() => { ticks++; beforeTick?.(); fn(...args); }, intervalMs);
      intervals.push(timer);
      return timer;
    }) as typeof setInterval);
    promoteSpy = spyOn(mail, "promote").mockImplementation(realPromote);
  });

  function stubWatcher(): fs.FSWatcher {
    const created = Object.assign(new EventEmitter(), {
      close() {
        closedWatchers.add(created);
        watcherEvents.push({ kind: "close", watcher: created });
      },
    }) as unknown as fs.FSWatcher;
    watcher = created;
    watcherEvents.push({ kind: "watch", watcher: created });
    return created;
  }

  afterEach(async () => {
    controller.abort();
    releaseVerify?.();
    await start;
    for (const timer of intervals) clearInterval(timer);
    readSpy?.mockRestore();
    promoteSpy.mockRestore();
    timerSpy.mockRestore();
    watchSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    for (const path of blockedRelayRoots) fs.rmSync(path, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function boot() {
    start = plugin.gateway.startAccount({
      account: { accountId: "default", mailDir: root, enabled: true },
      cfg: { bindings: [{ agentId: "recipient", match: { channel: "tps-mail", accountId: "default" } }] },
      abortSignal: controller.signal,
      log: { info: (line: string) => logs.push(line), warn: (line: string) => logs.push(line), error() {} },
      channelRuntime: {
        routing: { buildAgentSessionKey: () => "agent:recipient:tps-mail:default:flint" },
        reply: {
          finalizeInboundContext: async (ctx: any) => ctx,
          dispatchReplyWithBufferedBlockDispatcher: async ({ ctx }: any) => { dispatches.push(ctx.MessageSid); },
        },
      },
    });
    await sleep(10);
  }

  function plant(id: string, filename = `${id}.json`) {
    const timestamp = new Date().toISOString();
    const body = signEnvelope({
      v: 1, from: "flint", to: "recipient", body: "rescan test", messageId: id, timestamp,
      delegationChain: [
        { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
        { agent: "flint", kind: "agent", timestamp, rationale: "dispatches", signature: null },
      ],
    }, { flint: seed });
    const path = join(newDir, filename);
    fs.writeFileSync(path, JSON.stringify({ id, from: "flint", to: "recipient", body: JSON.stringify(body), timestamp, read: false }));
    notifyWatch?.(filename);
    return path;
  }

  function blockRelayLock(path: string, id: string): string {
    const record = JSON.parse(fs.readFileSync(path, "utf8"));
    record.relayDelivery = { branchId: "rescan-test", id };
    fs.writeFileSync(path, JSON.stringify(record));
    const lockRoot = relayAcceptanceLockRoot("rescan-test", id);
    fs.mkdirSync(dirname(lockRoot), { recursive: true });
    fs.writeFileSync(lockRoot, "blocks relay-lock directory creation");
    blockedRelayRoots.push(lockRoot);
    return lockRoot;
  }

  it("promotes mail with the watcher callback suppressed on the first rescan tick", async () => {
    await boot();
    const path = plant("missed-event");
    expect(await until(() => dispatches.length === 1, intervalMs * 2)).toBe(true);
    expect(ticks).toBe(1);
    expect(watchCalls).toBe(0);
    expect(dispatches).toEqual(["missed-event"]);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(join(root, "recipient", "cur", "missed-event.json"))).toBe(true);
    expect(logs.filter((line) => line.includes("promoted by rescan"))).toEqual([
      `tps-mail: promoted by rescan: ${path}`,
    ]);
    await sleep(intervalMs);
    expect(promoteSpy).toHaveBeenCalledTimes(1);
    expect(logs.filter((line) => line.includes("promoted by rescan"))).toHaveLength(1);
  });

  it("logs a watcher error and still promotes new mail on the rescan (cli#720)", async () => {
    await boot();
    // The error Bun on Linux reports when a file under new/ moves out while the watch is set up.
    const moved = join(newDir, "moved-out.json");
    watcher!.emit("error", Object.assign(new Error(`ENOENT: no such file or directory, watch '${moved}'`), {
      code: "ENOENT",
      syscall: "watch",
      path: moved,
    }));
    expect(logs.filter((line) => line.startsWith("tps-mail: new/ watcher for recipient stopped: ENOENT"))).toHaveLength(1);
    const path = plant("after-watch-error");
    expect(await until(() => dispatches.length === 1, intervalMs * 2)).toBe(true);
    expect(dispatches).toEqual(["after-watch-error"]);
    // cli#922 item 3: prove the delivery came through the RESCAN, not the
    // stub watcher's listener (which stays suppressed in this test).
    expect(logs).toContain(`tps-mail: promoted by rescan: ${path}`);
    expect(watchCalls).toBe(0);
  });

  it("re-arms a stopped watcher on the rescan and delivers through the new watcher", async () => {
    await boot();
    expect(watchSpy).toHaveBeenCalledTimes(1);
    const stopped = watcher!;
    stopped.emit("error", new Error("injected watcher error"));
    expect(await until(() => watchSpy.mock.calls.length === 2, intervalMs * 2)).toBe(true);
    expect(logs.filter((line) => line.includes("re-armed"))).toHaveLength(1);
    // cli#922 item 5: the re-arm closes the stopped watcher and drops it from
    // the account watcher set before the replacement is attached.
    const stoppedCloses = () =>
      watcherEvents.filter((event) => event.kind === "close" && event.watcher === stopped);
    expect(stoppedCloses()).toHaveLength(1);
    const closedAt = watcherEvents.indexOf(stoppedCloses()[0]!);
    const nextWatchAt = watcherEvents.findIndex((event) => event.kind === "watch" && event.watcher !== stopped);
    expect(nextWatchAt).toBeGreaterThan(closedAt);
    // Stop the rescan: delivery from here can only come from the new watcher.
    clearInterval(intervals[0]!);
    const ticksBefore = ticks;
    suppressWatch = false;
    plant("after-rearm");
    expect(await until(() => dispatches.length === 1, 5000)).toBe(true);
    expect(ticks).toBe(ticksBefore);
    expect(watchCalls).toBe(1);
    expect(dispatches).toEqual(["after-rearm"]);
    // A stopped watcher left in the set would be closed a second time on stop.
    controller.abort();
    await start;
    start = undefined;
    expect(stoppedCloses()).toHaveLength(1);
  });

  it("re-arms on the next tick when the first attach throws", async () => {
    watchSpy.mockImplementationOnce((() => {
      throw new Error("injected initial attach failure");
    }) as typeof fs.watch);
    await boot();
    expect(watchSpy).toHaveBeenCalledTimes(1);
    expect(logs.some((line) => line.startsWith("tps-mail: failed to watch "))).toBe(true);
    expect(await until(() => watchSpy.mock.calls.length === 2, intervalMs * 3)).toBe(true);
    expect(logs.filter((line) => line.includes("re-armed"))).toHaveLength(1);
  });

  it("caps the re-arm backoff at 32 ticks", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(rearmBackoffTicks)).toEqual([1, 2, 4, 8, 16, 32, 32, 32]);
  });

  it("resets the backoff after a successful re-arm", async () => {
    await boot();
    const attemptTicks: number[] = [];
    let attempts = 0;
    watchSpy.mockImplementation((() => {
      attemptTicks.push(ticks);
      attempts++;
      if (attempts === 1 || attempts === 2 || attempts === 4) throw new Error(`injected re-arm failure ${attempts}`);
      return stubWatcher();
    }) as typeof fs.watch);
    watcher!.emit("error", new Error("injected watcher error"));
    expect(await until(() => logs.some((line) => line.includes("re-armed")), intervalMs * 8)).toBe(true);
    // Two failed attempts at ticks 1 and 2, then the successful one at tick 4.
    expect(attemptTicks[1]! - attemptTicks[0]!).toBe(1);
    expect(attemptTicks[2]! - attemptTicks[1]!).toBe(2);
    watcher!.emit("error", new Error("injected watcher error after recovery"));
    expect(await until(() => attemptTicks.length >= 5, intervalMs * 8)).toBe(true);
    // The reset makes the next attempt follow the failure by one tick, not four.
    expect(attemptTicks[4]! - attemptTicks[3]!).toBe(1);
    expect(logs.filter((line) => line.includes("re-armed"))).toHaveLength(2);
  });

  it("backs off re-arm attempts on repeated failures", async () => {
    await boot();
    expect(watchSpy).toHaveBeenCalledTimes(1);
    watcher!.emit("error", new Error("injected watcher error"));
    watchSpy.mockImplementation((() => { throw new Error("injected re-arm failure"); }) as typeof fs.watch);
    expect(await until(() => ticks >= 8, intervalMs * 12)).toBe(true);
    // Attempts fall on ticks 1, 2, 4 and 8 (gaps of 1, 2 then 4 ticks), not one
    // per tick.
    expect(watchSpy.mock.calls.length - 1).toBe(4);
    expect(logs.filter((line) => line.includes("still failing after"))).toHaveLength(4);
    expect(logs.some((line) => line.includes("still failing after 4 re-arm attempt(s)"))).toBe(true);
  });

  it("closes a re-armed watcher on stop and runs no further tick", async () => {
    await boot();
    watcher!.emit("error", new Error("injected watcher error"));
    expect(await until(() => watchSpy.mock.calls.length === 2, intervalMs * 2)).toBe(true);
    const rearmed = watcher!;
    expect(closedWatchers.has(rearmed)).toBe(false);
    controller.abort();
    await start;
    start = undefined;
    expect(closedWatchers.has(rearmed)).toBe(true);
    const ticksAtStop = ticks;
    await sleep(intervalMs * 2);
    expect(ticks).toBe(ticksAtStop);
  });

  it("retries a busy promotion on the next rescan tick", async () => {
    await boot();
    const lockDir = join(root, "recipient", ".mail-lock");
    fs.mkdirSync(lockDir);
    const path = plant("busy-then-promoted");
    expect(await until(() => logs.some((line) => line.includes("not promoted (busy)")))).toBe(true);
    expect(ticks).toBe(1);
    expect(fs.existsSync(path)).toBe(true);
    fs.rmSync(lockDir, { recursive: true });
    expect(await until(() => dispatches.length === 1)).toBe(true);
    expect(ticks).toBe(2);
    expect(promoteSpy).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(join(root, "recipient", "cur", "busy-then-promoted.json"))).toBe(true);
  });

  it("retries a thrown relay-lock error on a later tick", async () => {
    await boot();
    const path = plant("throw-then-promoted");
    const lockRoot = blockRelayLock(path, "throw-then-promoted");
    expect(await until(() => logs.some((line) => line.includes("processNewFile error:")))).toBe(true);
    expect(ticks).toBe(1);
    expect(promoteSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path)).toBe(true);
    fs.rmSync(lockRoot);
    expect(await until(() => dispatches.length === 1)).toBe(true);
    expect(ticks).toBe(2);
    expect(promoteSpy).toHaveBeenCalledTimes(2);
    expect(dispatches).toEqual(["throw-then-promoted"]);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(join(root, "recipient", "cur", "throw-then-promoted.json"))).toBe(true);
  });

  it("caps repeated thrown relay-lock errors and logs the retry limit once", async () => {
    await boot();
    const path = plant("throw-exhausted");
    blockRelayLock(path, "throw-exhausted");
    const diagnostic = `tps-mail: promotion retry limit reached for ${path}; source suppressed`;
    expect(await until(() => logs.includes(diagnostic))).toBe(true);
    const before = ticks;
    expect(await until(() => ticks >= before + 2)).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(MAX_NEW_FILE_TRANSIENT_FAILURES);
    expect(logs.filter((line) => line.includes("processNewFile error:"))).toHaveLength(MAX_NEW_FILE_TRANSIENT_FAILURES);
    expect(logs.filter((line) => line === diagnostic)).toHaveLength(1);
    expect(fs.existsSync(path)).toBe(true);
    expect(dispatches).toEqual([]);
  });

  it("releases a busy claim when its source vanishes during promotion", async () => {
    await boot();
    verifyGate = new Promise<void>((resolve) => { releaseVerify = resolve; });
    const filename = "vanished-during-promotion.json";
    const path = plant("vanishing-original", filename);
    expect(await until(() => promoteSpy.mock.calls.length === 1)).toBe(true);
    fs.rmSync(path);
    verifyGate = undefined;
    releaseVerify!();
    expect(await until(() => logs.some((line) => line.includes("source became unreadable during promotion")))).toBe(true);
    let listedAbsent = false;
    readSpy = spyOn(fsPromises, "readdir").mockImplementation((async (...args: any[]) => {
      const filenames = await (realReaddir as any)(...args);
      if (String(args[0]) === newDir && !filenames.includes(filename)) listedAbsent = true;
      return filenames;
    }) as typeof fsPromises.readdir);
    expect(await until(() => listedAbsent)).toBe(true);
    plant("vanished-replacement", filename);
    const before = ticks;
    expect(await until(() => dispatches.length === 1)).toBe(true);
    expect(ticks).toBe(before + 1);
    expect(promoteSpy).toHaveBeenCalledTimes(2);
    expect(dispatches).toEqual(["vanished-replacement"]);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(join(root, "recipient", "cur", filename))).toBe(true);
  });

  it("suppresses an exhausted source still present and logs the retry limit once", async () => {
    await boot();
    const lockDir = join(root, "recipient", ".mail-lock");
    fs.mkdirSync(lockDir);
    const path = plant("busy-exhausted");
    const diagnostic = `tps-mail: promotion retry limit reached for ${path}; source suppressed`;
    expect(await until(() => logs.includes(diagnostic))).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(MAX_NEW_FILE_TRANSIENT_FAILURES);
    fs.rmSync(lockDir, { recursive: true });
    suppressWatch = false;
    notifyWatch?.("busy-exhausted.json");
    const before = ticks;
    expect(await until(() => ticks >= before + 2)).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(MAX_NEW_FILE_TRANSIENT_FAILURES);
    expect(logs.filter((line) => line === diagnostic)).toHaveLength(1);
    expect(fs.existsSync(path)).toBe(true);
    expect(dispatches).toEqual([]);
  });

  it("promotes a replacement at an exhausted path after a rescan observes removal", async () => {
    await boot();
    const lockDir = join(root, "recipient", ".mail-lock");
    fs.mkdirSync(lockDir);
    const filename = "exhausted-replacement.json";
    const path = plant("exhausted-original", filename);
    expect(await until(() => logs.some((line) => line.includes("retry limit reached")))).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(MAX_NEW_FILE_TRANSIENT_FAILURES);
    fs.rmSync(path);
    let listedAbsent = false;
    readSpy = spyOn(fsPromises, "readdir").mockImplementation((async (...args: any[]) => {
      const filenames = await (realReaddir as any)(...args);
      if (String(args[0]) === newDir && !filenames.includes(filename)) listedAbsent = true;
      return filenames;
    }) as typeof fsPromises.readdir);
    expect(await until(() => listedAbsent)).toBe(true);
    fs.rmSync(lockDir, { recursive: true });
    plant("replacement-message", filename);
    const before = ticks;
    expect(await until(() => dispatches.length === 1)).toBe(true);
    expect(ticks).toBe(before + 1);
    expect(promoteSpy).toHaveBeenCalledTimes(MAX_NEW_FILE_TRANSIENT_FAILURES + 1);
    expect(dispatches).toEqual(["replacement-message"]);
    expect(fs.existsSync(path)).toBe(false);
    const promoted = JSON.parse(fs.readFileSync(join(root, "recipient", "cur", filename), "utf-8"));
    expect(promoted.envelopeId).toBe("replacement-message");
  });

  it("promotes a new identity at an exhausted path without an absent rescan", async () => {
    await boot();
    const lockDir = join(root, "recipient", ".mail-lock");
    fs.mkdirSync(lockDir);
    const filename = "identity-replacement.json";
    const path = plant("identity-original", filename);
    const original = fs.statSync(path, { bigint: true });
    expect(await until(() => logs.some((line) => line.includes("retry limit reached")))).toBe(true);
    fs.rmSync(lockDir, { recursive: true });
    const exhaustedAt = ticks;
    expect(await until(() => ticks >= exhaustedAt + 2)).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(MAX_NEW_FILE_TRANSIENT_FAILURES);
    expect(fs.statSync(path, { bigint: true }).ino).toBe(original.ino);
    expect(dispatches).toEqual([]);
    const replacement = plant("identity-replacement", "../replacement-scratch.json");
    expect(fs.statSync(replacement, { bigint: true }).ino).not.toBe(original.ino);
    const before = ticks;
    let replacedAt = 0;
    beforeTick = () => {
      beforeTick = undefined;
      replacedAt = ticks;
      fs.renameSync(replacement, path);
    };
    expect(await until(() => dispatches.length === 1)).toBe(true);
    expect(replacedAt).toBe(before + 1);
    expect(ticks).toBe(replacedAt);
    expect(promoteSpy).toHaveBeenCalledTimes(MAX_NEW_FILE_TRANSIENT_FAILURES + 1);
    expect(dispatches).toEqual(["identity-replacement"]);
    expect(fs.existsSync(path)).toBe(false);
    const promoted = JSON.parse(fs.readFileSync(join(root, "recipient", "cur", filename), "utf8"));
    expect(promoted.envelopeId).toBe("identity-replacement");
  });

  it("gives an in-place rewrite at an exhausted path a new retry budget", async () => {
    await boot();
    const lockDir = join(root, "recipient", ".mail-lock");
    fs.mkdirSync(lockDir);
    const filename = "rewritten-source.json";
    const path = plant("rewrite-original", filename);
    const original = fs.statSync(path, { bigint: true });
    expect(await until(() => logs.some((line) => line.includes("retry limit reached")))).toBe(true);
    plant("rewrite-replacement", filename);
    const rewritten = fs.statSync(path, { bigint: true });
    expect(rewritten.ino).toBe(original.ino);
    expect(`${rewritten.size}:${rewritten.mtimeNs}`).not.toBe(`${original.size}:${original.mtimeNs}`);
    expect(await until(() => logs.filter((line) => line.includes("retry limit reached")).length === 2)).toBe(true);
    const before = ticks;
    expect(await until(() => ticks >= before + 2)).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(MAX_NEW_FILE_TRANSIENT_FAILURES * 2);
    expect(dispatches).toEqual([]);
  });

  it("keeps a promoted path suppressed when the watcher reports it again", async () => {
    await boot();
    const path = plant("already-cur");
    expect(await until(() => dispatches.length === 1)).toBe(true);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(join(root, "recipient", "cur", "already-cur.json"))).toBe(true);
    fs.copyFileSync(join(root, "recipient", "cur", "already-cur.json"), path);
    suppressWatch = false;
    notifyWatch?.("already-cur.json");
    const before = ticks;
    expect(await until(() => ticks >= before + 2)).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(1);
    expect(dispatches).toEqual(["already-cur"]);
  });

  it("retries verification unavailability when dead-lettering leaves the source", async () => {
    await boot();
    verifyUnavailable = true;
    const dlq = join(root, "recipient", "dlq");
    fs.writeFileSync(dlq, "blocks dead-letter directory creation");
    const path = plant("verify-retained");
    expect(await until(() => logs.some((line) => line.includes("not promoted (verify-unavailable)")))).toBe(true);
    expect(fs.existsSync(path)).toBe(true);
    fs.rmSync(dlq);
    verifyUnavailable = false;
    expect(await until(() => dispatches.length === 1)).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(2);
  });

  it("retries a rejected message whose dead-letter move fails, then suppresses it undispatched", async () => {
    await boot();
    verifyBadSignature = true;
    const dlq = join(root, "recipient", "dlq");
    fs.writeFileSync(dlq, "blocks dead-letter directory creation");
    const path = plant("rejected-retained");
    const diagnostic = `tps-mail: promotion retry limit reached for ${path}; source suppressed`;

    expect(await until(() => logs.includes(diagnostic))).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(MAX_NEW_FILE_TRANSIENT_FAILURES);
    expect(logs.filter((line) => line === diagnostic)).toHaveLength(1);
    expect(fs.existsSync(path)).toBe(true);
    expect(fs.readFileSync(path, "utf8")).toContain("rejected-retained");
    expect(dispatches).toEqual([]);
    expect(consoleErrors.filter((line) => line.includes("failed to dead-letter"))).toHaveLength(MAX_NEW_FILE_TRANSIENT_FAILURES);

    const before = ticks;
    expect(await until(() => ticks >= before + 2)).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(MAX_NEW_FILE_TRANSIENT_FAILURES);
    expect(dispatches).toEqual([]);
  });

  it("keeps a verification rejection suppressed after it moves to dlq", async () => {
    await boot();
    verifyUnavailable = true;
    const path = plant("verify-quarantined");
    expect(await until(() => logs.some((line) => line.includes("not promoted (verify-unavailable)")))).toBe(true);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(join(root, "recipient", "dlq", "verify-quarantined.json"))).toBe(true);
    fs.copyFileSync(join(root, "recipient", "dlq", "verify-quarantined.json"), path);
    verifyUnavailable = false;
    const before = ticks;
    expect(await until(() => ticks >= before + 2)).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(1);
    expect(dispatches).toEqual([]);
  });

  it("drops a vanished source's failure counter on a rescan", async () => {
    await boot();
    fs.mkdirSync(join(root, "recipient", ".mail-lock"));
    const path = plant("vanished-source");
    expect(await until(() => logs.some((line) => line.includes("not promoted (busy)")))).toBe(true);
    fs.rmSync(path);
    let listedAbsent = false;
    readSpy = spyOn(fsPromises, "readdir").mockImplementation((async (...args: any[]) => {
      const filenames = await (realReaddir as any)(...args);
      if (String(args[0]) === newDir && !filenames.includes("vanished-source.json")) listedAbsent = true;
      return filenames;
    }) as typeof fsPromises.readdir);
    expect(await until(() => listedAbsent)).toBe(true);
    plant("vanished-source");
    expect(await until(() => logs.some((line) => line.includes("retry limit reached")))).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(1 + MAX_NEW_FILE_TRANSIENT_FAILURES);
  });

  it("startup leaves a dot-file beside a promoted message (cli#870)", async () => {
    const scratch = join(newDir, ".x.json");
    fs.writeFileSync(scratch, "{ not mail");
    const path = plant("startup-with-dotfile");

    await boot();

    expect(await until(() => dispatches.length === 1)).toBe(true);
    expect(dispatches).toEqual(["startup-with-dotfile"]);
    expect(fs.readdirSync(newDir)).toEqual([".x.json"]);
    expect(fs.readFileSync(scratch, "utf8")).toBe("{ not mail");
    expect(promoteSpy.mock.calls.map((c: any[]) => String(c[1]))).toEqual([path]);
    expect(fs.existsSync(join(root, "recipient", "dlq", ".x.json"))).toBe(false);
    expect(logs.filter((line) => line.includes("promoted by rescan"))).toEqual([]);
  });

  it("skips dot-files in new/ while promoting a missed message", async () => {
    await boot();
    const scratch = join(newDir, ".scratch-editor.json");
    fs.writeFileSync(scratch, "{ not mail");
    const path = plant("missed-with-dotfile");
    expect(await until(() => dispatches.length === 1, intervalMs * 2)).toBe(true);
    await sleep(intervalMs);
    expect(dispatches).toEqual(["missed-with-dotfile"]);
    expect(fs.readFileSync(scratch, "utf8")).toBe("{ not mail");
    expect(promoteSpy.mock.calls.map((c: any[]) => String(c[1]))).toEqual([path]);
    expect(fs.existsSync(join(root, "recipient", "dlq"))
      ? fs.readdirSync(join(root, "recipient", "dlq")).filter((f) => f.includes("scratch")) : []).toEqual([]);
  });

  it("a dot-file reported by the watcher is not promoted either", async () => {
    await boot();
    suppressWatch = false;
    const scratch = join(newDir, ".scratch-watched.json");
    fs.writeFileSync(scratch, "{ not mail");
    notifyWatch?.(".scratch-watched.json");
    const path = plant("watched-after-dotfile");
    expect(await until(() => dispatches.length === 1)).toBe(true);
    await sleep(intervalMs);
    expect(fs.readFileSync(scratch, "utf8")).toBe("{ not mail");
    expect(promoteSpy.mock.calls.map((c: any[]) => String(c[1]))).toEqual([path]);
  });

  it("rescans an inbox when watcher registration throws", async () => {
    watchSpy.mockImplementationOnce(() => { throw new Error("injected watch failure"); });
    await boot();
    const path = plant("watch-unavailable");
    expect(await until(() => dispatches.length === 1, intervalMs * 2)).toBe(true);
    expect(logs).toContain(`tps-mail: promoted by rescan: ${path}`);
  });

  it("keeps watched promotion single while rescans see its path in new/", async () => {
    await boot();
    suppressWatch = false;
    verifyGate = new Promise<void>((resolve) => { releaseVerify = resolve; });
    const path = plant("watched-event");
    expect(await until(() => promoteSpy.mock.calls.length > 0)).toBe(true);
    expect(watchCalls).toBeGreaterThan(0);
    expect(fs.existsSync(path)).toBe(true);
    expect(await until(() => ticks >= 2)).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(1);
    expect(logs.filter((line) => line.includes("promoted by rescan"))).toEqual([]);
    releaseVerify!();
    expect(await until(() => dispatches.length === 1)).toBe(true);
    expect(dispatches).toEqual(["watched-event"]);
  });

  it("does not claim a file queued by the watcher before its debounce expires", async () => {
    await boot();
    suppressWatch = false;
    beforeTick = () => {
      beforeTick = undefined;
      plant("watch-debounce");
    };
    expect(await until(() => dispatches.length === 1)).toBe(true);
    expect(watchCalls).toBe(1);
    expect(ticks).toBeGreaterThanOrEqual(1);
    expect(promoteSpy).toHaveBeenCalledTimes(1);
    expect(logs.filter((line) => line.includes("promoted by rescan"))).toEqual([]);
  });

  it("retries a watcher processing error on the next rescan", async () => {
    await boot();
    suppressWatch = false;
    promoteSpy.mockImplementationOnce(async () => { throw new Error("injected promotion error"); });
    const path = plant("processing-error");
    expect(await until(() => logs.some((line) => line.includes("injected promotion error")))).toBe(true);
    const before = ticks;
    expect(await until(() => dispatches.length === 1)).toBe(true);
    expect(ticks).toBe(before + 1);
    expect(promoteSpy).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path)).toBe(false);
    expect(dispatches).toEqual(["processing-error"]);
    expect(logs.filter((line) => line.includes("promoted by rescan"))).toEqual([
      `tps-mail: promoted by rescan: ${path}`,
    ]);
  });

  it("clears the rescan timer on abort before another callback fires", async () => {
    await boot();
    expect(intervals).toHaveLength(1);
    expect(await until(() => ticks >= 1)).toBe(true);
    controller.abort();
    await start;
    const before = ticks;
    plant("after-abort");
    await sleep(intervalMs * 2);
    expect(ticks).toBe(before);
    expect(promoteSpy).toHaveBeenCalledTimes(0);
  });

  it("skips ticks while an inbox listing is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let listings = 0;
    readSpy = spyOn(fsPromises, "readdir").mockImplementation((async (...args: any[]) => {
      if (String(args[0]) === newDir) { listings++; await gate; }
      return (realReaddir as any)(...args);
    }) as typeof fsPromises.readdir);
    try {
      await boot();
      expect(await until(() => ticks >= 3)).toBe(true);
      expect(listings).toBe(1);
    } finally {
      release();
    }
    expect(await until(() => listings >= 2)).toBe(true);
  });
});
