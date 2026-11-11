/**
 * cli#922 items 5 and 3 — pin the watcher error listener and the re-arm on the
 * REAL fs.watch.
 *
 * The other watcher tests replace fs.watch with an EventEmitter stub, so they
 * would pass even if the plugin never attached an error listener to a watcher
 * the OS actually creates, or if the replacement it creates were not the one
 * watching. This Linux-lane test spies on fs.watch only to keep the watcher it
 * returns: the callback and the watcher are the real ones.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { signEnvelope } from "@tpsdev-ai/agent";
import pluginModule, { NEW_DIR_RESCAN_MS } from "../src/index.js";

hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());
const seed = Buffer.alloc(32, 0x01);

// Static guard: every spy is restored by this teardown.
afterEach(() => {
  mock.restore();
});

let plugin: any;
pluginModule.register({
  registerChannel: ({ plugin: registered }: { plugin: any }) => { plugin = registered; },
  logger: { info() {}, warn() {}, error() {} },
} as any);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const linuxIt = it.skipIf(process.platform !== "linux");

/** Every condition wait in this file carries a named deadline. */
async function deadline(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > ms) {
      throw new Error(`timed out after ${ms} ms waiting for ${label}`);
    }
    await sleep(10);
  }
}

describe("real fs.watch watcher (cli#922 item 5)", () => {
  linuxIt("re-arms the real watcher and delivers through it exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "tps-real-watch-"));
    const newDir = resolve(root, "recipient", "new");
    mkdirSync(newDir, { recursive: true });
    const controller = new AbortController();
    const created: fs.FSWatcher[] = [];
    const realWatch = fs.watch;
    const realSetInterval = globalThis.setInterval;
    const logs: string[] = [];
    const dispatches: string[] = [];
    const intervals: ReturnType<typeof setInterval>[] = [];
    let ticks = 0;

    // Verification is not the component under test here; fs.watch is. Mock the
    // verifier only so promote() accepts the planted envelope.
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
          return name === "sender" ? { publicKey: Buffer.from(ed.getPublicKey(seed)) } : null;
        },
      }),
    }));

    // Shorten ONLY the rescan interval, as new-dir-rescan does.
    const timerSpy = spyOn(globalThis, "setInterval").mockImplementation(((fn: any, ms: number, ...args: any[]) => {
      if (ms !== NEW_DIR_RESCAN_MS) return realSetInterval(fn, ms, ...args);
      const timer = realSetInterval(() => { ticks++; fn(...args); }, 200);
      intervals.push(timer);
      return timer;
    }) as typeof setInterval);

    const watchSpy = spyOn(fs, "watch").mockImplementation(((
      path: fs.PathLike,
      options: any,
      listener: any,
    ) => {
      const watcher = (realWatch as any)(path, options, listener);
      created.push(watcher);
      return watcher;
    }) as typeof fs.watch);

    const plant = (id: string) => {
      const timestamp = new Date().toISOString();
      const body = signEnvelope({
        v: 1, from: "sender", to: "recipient", body: "real watch test", messageId: id, timestamp,
        delegationChain: [
          { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
          { agent: "sender", kind: "agent", timestamp, rationale: "dispatches", signature: null },
        ],
      }, { sender: seed });
      const path = join(newDir, `${id}.json`);
      fs.writeFileSync(path, JSON.stringify({
        id, from: "sender", to: "recipient", body: JSON.stringify(body), timestamp, read: false,
      }));
      return path;
    };

    let startPromise: Promise<void> | undefined;
    try {
      startPromise = plugin.gateway.startAccount({
        account: { accountId: "default", mailDir: root, enabled: true },
        cfg: { bindings: [{ agentId: "recipient", match: { channel: "tps-mail", accountId: "default" } }] },
        abortSignal: controller.signal,
        log: {
          info: (line: string) => logs.push(line),
          warn: (line: string) => logs.push(line),
          error() {},
        },
        channelRuntime: {
          routing: { buildAgentSessionKey: () => "agent:recipient:tps-mail:default:sender" },
          reply: {
            finalizeInboundContext: async (ctx: any) => ctx,
            dispatchReplyWithBufferedBlockDispatcher: async ({ ctx }: any) => { dispatches.push(ctx.MessageSid); },
          },
        },
      });

      await deadline(() => created.length === 1, 5000, "the first real watcher");
      expect(created[0]!.listenerCount("error")).toBe(1);

      created[0]!.emit("error", new Error("injected watcher error"));
      await deadline(() => created.length === 2, 5000, "the re-armed real watcher");
      const rearmed = created[1]!;
      expect(rearmed).not.toBe(created[0]!);
      expect(rearmed.listenerCount("error")).toBe(1);

      // Delivery from here can only come through the re-armed watcher.
      clearInterval(intervals[0]!);
      intervals.length = 0;
      const ticksBefore = ticks;
      const path = plant("through-rearmed-watcher");
      const delivered = () => logs.filter((line) => line.startsWith("tps-mail: delivering "));
      await deadline(() => delivered().length > 0, 5000, "the re-armed watcher to deliver the planted mail");
      // Settle any duplicate event the real watcher may still emit.
      await sleep(300);

      expect(ticks).toBe(ticksBefore);
      expect(delivered()).toHaveLength(1);
      expect(dispatches).toEqual(["through-rearmed-watcher"]);
      expect(logs.some((line) => line.includes("promoted by rescan"))).toBe(false);
      expect(fs.existsSync(path)).toBe(false);
      expect(fs.existsSync(join(root, "recipient", "cur", "through-rearmed-watcher.json"))).toBe(true);
    } finally {
      controller.abort();
      await startPromise?.catch(() => {});
      for (const timer of intervals) clearInterval(timer);
      timerSpy.mockRestore();
      watchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
