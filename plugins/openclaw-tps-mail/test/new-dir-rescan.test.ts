import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { signEnvelope } from "@tpsdev-ai/agent";
import * as mail from "@tpsdev-ai/cli/utils/mail";
import pluginModule, { MAX_NEW_FILE_TRANSIENT_FAILURES, NEW_DIR_RESCAN_MS } from "../src/index.js";

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
  let watchSpy: ReturnType<typeof spyOn>;
  let timerSpy: ReturnType<typeof spyOn>;
  let promoteSpy: ReturnType<typeof spyOn>;
  let readSpy: ReturnType<typeof spyOn> | undefined;

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
    readSpy = undefined;
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
          if (verifyGate) await verifyGate;
          if (verifyUnavailable) throw new Error("injected verification outage");
          return name === "flint" ? { publicKey: Buffer.from(ed.getPublicKey(seed)) } : null;
        },
      }),
    }));
    // Stub OS notifications; real files still traverse promote and verification.
    watchSpy = spyOn(fs, "watch").mockImplementation(((_path: any, _options: any, listener: any) => {
      notifyWatch = (filename) => {
        if (!suppressWatch) { watchCalls++; listener("rename", filename); }
      };
      return { close() {} } as fs.FSWatcher;
    }) as typeof fs.watch);
    timerSpy = spyOn(globalThis, "setInterval").mockImplementation(((fn: any, ms: number, ...args: any[]) => {
      if (ms !== NEW_DIR_RESCAN_MS) return realSetInterval(fn, ms, ...args);
      const timer = realSetInterval(() => { ticks++; beforeTick?.(); fn(...args); }, intervalMs);
      intervals.push(timer);
      return timer;
    }) as typeof setInterval);
    promoteSpy = spyOn(mail, "promote").mockImplementation(realPromote);
  });

  afterEach(async () => {
    controller.abort();
    releaseVerify?.();
    await start;
    for (const timer of intervals) clearInterval(timer);
    readSpy?.mockRestore();
    promoteSpy.mockRestore();
    timerSpy.mockRestore();
    watchSpy.mockRestore();
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

  function plant(id: string) {
    const timestamp = new Date().toISOString();
    const body = signEnvelope({
      v: 1, from: "flint", to: "recipient", body: "rescan test", messageId: id, timestamp,
      delegationChain: [
        { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
        { agent: "flint", kind: "agent", timestamp, rationale: "dispatches", signature: null },
      ],
    }, { flint: seed });
    const path = join(newDir, `${id}.json`);
    fs.writeFileSync(path, JSON.stringify({ id, from: "flint", to: "recipient", body: JSON.stringify(body), timestamp, read: false }));
    notifyWatch?.(`${id}.json`);
    return path;
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

  it("suppresses an exhausted path until restart and logs the retry limit once", async () => {
    await boot();
    const lockDir = join(root, "recipient", ".mail-lock");
    fs.mkdirSync(lockDir);
    const path = plant("busy-exhausted");
    const diagnostic = `tps-mail: promotion retry limit reached for ${path}; suppressed until restart`;
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

  it("keeps a verification rejection suppressed after it moves to dlq", async () => {
    await boot();
    verifyUnavailable = true;
    const path = plant("verify-quarantined");
    expect(await until(() => logs.some((line) => line.includes("not promoted (verify-unavailable)")))).toBe(true);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(join(root, "recipient", "dlq", "verify-quarantined.json"))).toBe(true);
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

  it("skips dot-files in new/ while promoting a missed message", async () => {
    await boot();
    const scratch = join(newDir, ".scratch-editor.json");
    fs.writeFileSync(scratch, "{ not mail");
    const path = plant("missed-with-dotfile");
    expect(await until(() => dispatches.length === 1, intervalMs * 2)).toBe(true);
    await sleep(intervalMs);
    expect(dispatches).toEqual(["missed-with-dotfile"]);
    expect(fs.existsSync(scratch)).toBe(true);
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
    expect(fs.existsSync(scratch)).toBe(true);
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

  it("leaves an already-seen path in new/ after a processing error", async () => {
    await boot();
    suppressWatch = false;
    promoteSpy.mockImplementationOnce(async () => { throw new Error("injected promotion error"); });
    const path = plant("processing-error");
    expect(await until(() => logs.some((line) => line.includes("injected promotion error")))).toBe(true);
    const before = ticks;
    expect(await until(() => ticks > before)).toBe(true);
    expect(promoteSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path)).toBe(true);
    expect(dispatches).toEqual([]);
    expect(logs.filter((line) => line.includes("promoted by rescan"))).toEqual([]);
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
