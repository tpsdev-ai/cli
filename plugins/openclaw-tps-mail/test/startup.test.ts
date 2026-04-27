/**
 * Regression test for ops-h2zy: openclaw-tps-mail must process mail files
 * that are already present in new/ at plugin startup, not silently skip them.
 *
 * The previous bug was a pre-population loop that added all files in new/ to
 * seenFiles BEFORE the startup scan ran, causing processNewFile to exit
 * immediately on every file. The fix (commit f9f489b) removed that loop.
 *
 * This test locks in the correct behavior: files sitting in new/ when the
 * gateway starts MUST be dispatched.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Import the plugin — default export gives us { register }.
// We extract the channel plugin object via a mock registration.
import pluginModule from "../src/index.js";

let capturedPlugin: any;
const mockApi: any = {
  registerChannel: ({ plugin }: { plugin: any }) => {
    capturedPlugin = plugin;
  },
  logger: {
    info: (..._: any[]) => {},
    warn: (..._: any[]) => {},
    error: (..._: any[]) => {},
  },
};
pluginModule.register(mockApi);

/** Poll with 50ms interval until conditionFn returns true or timeout elapses. */
async function pollUntil(conditionFn: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (conditionFn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return conditionFn();
}

function makeMailEnvelope(overrides: Partial<{ id: string; from: string; to: string; body: string; timestamp: string }> = {}) {
  return {
    id: overrides.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: overrides.from ?? "sender",
    to: overrides.to ?? "recipient",
    body: overrides.body ?? "test message",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    headers: { "X-TPS-Trust": "agent", "X-TPS-Surface": "tps-mail" },
    deliveryAttempts: 0,
  };
}

describe("openclaw-tps-mail: seenFiles startup behavior", () => {
  let tempMailDir: string;
  let abortController: AbortController;

  beforeEach(() => {
    tempMailDir = mkdtempSync(join(tmpdir(), "tps-mail-startup-"));
    abortController = new AbortController();
  });

  afterEach(() => {
    abortController.abort();
    try {
      rmSync(tempMailDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("processes mail file present in new/ at startup", async () => {
    const agentId = "test-agent";
    const newDir = resolve(tempMailDir, agentId, "new");
    mkdirSync(newDir, { recursive: true });

    // Write a valid mail envelope BEFORE starting the plugin
    const envelope = makeMailEnvelope({
      from: "flint",
      to: agentId,
      body: "hello from startup test",
      id: "msg-startup-001",
    });
    const filename = `2026-04-27T00-00-00-${envelope.id}.json`;
    writeFileSync(resolve(newDir, filename), JSON.stringify(envelope, null, 2), "utf-8");

    // Capture dispatch calls via a promise so the test can await them
    let dispatchResolve: (val: any) => void;
    const dispatchPromise = new Promise<any>((res) => {
      dispatchResolve = res;
    });

    const channelRuntime = {
      routing: {
        buildAgentSessionKey: (params: any) =>
          `agent:${params.agentId}:tps-mail:default:${params.peer.id}`,
      },
      reply: {
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        dispatchReplyWithBufferedBlockDispatcher: async ({ ctx, dispatcherOptions }: any) => {
          dispatchResolve({ ctx, dispatcherOptions });
        },
      },
    };

    const cfg = {
      bindings: [{ agentId, match: { channel: "tps-mail", accountId: "default" } }],
    };

    const ctx = {
      account: { accountId: "default", mailDir: tempMailDir, enabled: true },
      cfg,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      channelRuntime,
      abortSignal: abortController.signal,
    };

    // startAccount sets up watchers and the startup scan
    const startPromise = capturedPlugin.gateway.startAccount(ctx);

    // Wait for the startup scan to dispatch the pre-existing mail file
    const result = await Promise.race([
      dispatchPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for dispatch")), 5000)),
    ]);

    // Assert: dispatch was called with the right message context
    expect(result.ctx.From).toBe("flint");
    expect(result.ctx.To).toBe(agentId);
    expect(result.ctx.MessageSid).toBe("msg-startup-001");
    expect(result.ctx.Body).toBe("hello from startup test");

    // Poll for file to move from new/ to cur/ (moveToCur is sync but runs after
    // dispatch; polling avoids brittle 50ms sleeps on slow CI).
    const curDir = resolve(tempMailDir, agentId, "cur");
    const moved = await pollUntil(
      () => readdirSync(newDir).length === 0 && readdirSync(curDir).length >= 1,
      2000,
    );
    expect(moved).toBe(true);

    // Clean up: abort watcher and await the startAccount promise
    abortController.abort();
    try { await startPromise; } catch { /* expected on abort */ }
  });

  it("does not double-process a file (dedup via seenFiles)", async () => {
    const agentId = "test-agent";
    const newDir = resolve(tempMailDir, agentId, "new");
    mkdirSync(newDir, { recursive: true });

    const envelope = makeMailEnvelope({
      from: "flint",
      to: agentId,
      body: "dedup test",
      id: "msg-dedup-001",
    });
    const filename = `2026-04-27T00-00-00-${envelope.id}.json`;
    writeFileSync(resolve(newDir, filename), JSON.stringify(envelope, null, 2), "utf-8");

    let dispatchCount = 0;
    let resolveFirstDispatch: () => void;
    const firstDispatch = new Promise<void>((res) => {
      resolveFirstDispatch = res;
    });

    const channelRuntime = {
      routing: {
        buildAgentSessionKey: (params: any) =>
          `agent:${params.agentId}:tps-mail:default:${params.peer.id}`,
      },
      reply: {
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        dispatchReplyWithBufferedBlockDispatcher: async ({ ctx, dispatcherOptions }: any) => {
          dispatchCount++;
          resolveFirstDispatch();
        },
      },
    };

    const cfg = {
      bindings: [{ agentId, match: { channel: "tps-mail", accountId: "default" } }],
    };

    const ctx = {
      account: { accountId: "default", mailDir: tempMailDir, enabled: true },
      cfg,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      channelRuntime,
      abortSignal: abortController.signal,
    };

    const startPromise = capturedPlugin.gateway.startAccount(ctx);

    // Wait for the first dispatch
    await Promise.race([
      firstDispatch,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for first dispatch")), 5000)),
    ]);

    // Wait a bit to ensure no second dispatch occurs
    await new Promise((r) => setTimeout(r, 300));

    // Assert: dispatch was called exactly once (no double-processing)
    expect(dispatchCount).toBe(1);

    abortController.abort();
    try { await startPromise; } catch { /* expected on abort */ }
  });
});