/**
 * cli#922 item 5 — pin the watcher error listener on the REAL fs.watch.
 *
 * The other watcher tests replace fs.watch with an EventEmitter stub, so they
 * would pass even if the plugin never attached an error listener to a watcher
 * the OS actually creates. This Linux-lane test spies on fs.watch only to keep
 * the watcher it returns: the callback and the watcher are the real ones.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pluginModule from "../src/index.js";

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

describe("real fs.watch watcher (cli#922 item 5)", () => {
  linuxIt("attaches exactly one error listener to the real directory watcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "tps-real-watch-"));
    const newDir = resolve(root, "recipient", "new");
    mkdirSync(newDir, { recursive: true });
    const controller = new AbortController();
    const created: fs.FSWatcher[] = [];
    const realWatch = fs.watch;
    const watchSpy = spyOn(fs, "watch").mockImplementation(((
      path: fs.PathLike,
      options: any,
      listener: any,
    ) => {
      const watcher = (realWatch as any)(path, options, listener);
      created.push(watcher);
      return watcher;
    }) as typeof fs.watch);
    let startPromise: Promise<void> | undefined;
    try {
      startPromise = plugin.gateway.startAccount({
        account: { accountId: "default", mailDir: root, enabled: true },
        cfg: { bindings: [{ agentId: "recipient", match: { channel: "tps-mail", accountId: "default" } }] },
        abortSignal: controller.signal,
        log: { info() {}, warn() {}, error() {} },
        channelRuntime: {
          routing: { buildAgentSessionKey: () => "agent:recipient:tps-mail:default:sender" },
          reply: {
            finalizeInboundContext: async (ctx: any) => ctx,
            dispatchReplyWithBufferedBlockDispatcher: async () => {},
          },
        },
      });
      await sleep(100);
      expect(watchSpy).toHaveBeenCalled();
      expect(created).toHaveLength(1);
      expect(created[0]!.listenerCount("error")).toBe(1);
    } finally {
      controller.abort();
      await startPromise?.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
