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
 *
 * Updated (ops-ibw8): body must be a valid signed envelope (strict day-1).
 * Tests use hermetic mock verify client via module mocking.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import {
  signEnvelope,
  type Envelope,
  type ChainEntry,
} from "@tpsdev-ai/agent";

// Wire sha512 for sync sign operations.
import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => {
  return new Uint8Array(createHash("sha512").update(message).digest());
};

const FLINT_SEED = Buffer.alloc(32, 0x01);

function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

// Import the plugin — default export gives us { register }.
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

function makeMailEnvelope(body: string, overrides: Partial<{ id: string; from: string; to: string; timestamp: string }> = {}) {
  return {
    id: overrides.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: overrides.from ?? "sender",
    to: overrides.to ?? "recipient",
    body,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    headers: { "X-TPS-Trust": "agent", "X-TPS-Surface": "tps-mail" },
    deliveryAttempts: 0,
  };
}

function buildSignedBody(from: string, to: string, body: string): string {
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: new Date().toISOString(), rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: new Date().toISOString(), rationale: `agent ${from} dispatches`, signature: null },
  ];
  const env = signEnvelope(
    { v: 1, from, to, body, messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString(), delegationChain: chain },
    { [from]: FLINT_SEED },
  );
  return JSON.stringify(env);
}

/** The signed envelope OBJECT (not its JSON) — for building a promoted cur/ record. */
function buildEnvelopeObj(from: string, to: string, body: string, messageId: string): Envelope {
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: new Date().toISOString(), rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: new Date().toISOString(), rationale: `agent ${from} dispatches`, signature: null },
  ];
  return signEnvelope(
    { v: 1, from, to, body, messageId, timestamp: new Date().toISOString(), delegationChain: chain },
    { [from]: FLINT_SEED },
  );
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
    // Mock the verify-adapter to return a hermetic Flair mock
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
          if (name === "flint") return { publicKey: pubkeyFromSeed(FLINT_SEED) };
          return null;
        },
      }),
    }));

    const agentId = "test-agent";
    const newDir = resolve(tempMailDir, agentId, "new");
    mkdirSync(newDir, { recursive: true });

    // Write a valid mail envelope with signed body BEFORE starting the plugin
    const signedBody = buildSignedBody("flint", agentId, "hello from startup test");
    const envelope = makeMailEnvelope(signedBody, {
      from: "flint",
      to: agentId,
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
    // Body was replaced with inner envelope body after verification
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
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
          if (name === "flint") return { publicKey: pubkeyFromSeed(FLINT_SEED) };
          return null;
        },
      }),
    }));

    const agentId = "test-agent";
    const newDir = resolve(tempMailDir, agentId, "new");
    mkdirSync(newDir, { recursive: true });

    const signedBody = buildSignedBody("flint", agentId, "dedup test");
    const envelope = makeMailEnvelope(signedBody, {
      from: "flint",
      to: agentId,
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

  // ── crash between promote() and ack must not lose the message ─────────────
  it("re-dispatches a genuine unacked cur/ record left by a crash (and re-verifies it)", async () => {
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
          if (name === "flint") return { publicKey: pubkeyFromSeed(FLINT_SEED) };
          return null;
        },
      }),
    }));

    const agentId = "test-agent";
    const curDir = resolve(tempMailDir, agentId, "cur");
    mkdirSync(curDir, { recursive: true });

    // A signing key for the AGENT: under S2 an ack requires a committed, signed
    // receipt, and a missing key is a NAMED failure (never an ack).
    const keysDir = mkdtempSync(join(tmpdir(), "tps-startup-keys-"));
    writeFileSync(join(keysDir, `${agentId}.key`), FLINT_SEED);
    const origKeysDir = process.env.TPS_TEST_KEYS_DIR;
    process.env.TPS_TEST_KEYS_DIR = keysDir;

    // A GENUINE promoted cur/ record: it carries the envelopeId and the signed
    // envelope that promote() stamps, was never acked, and its inner body.
    const env = buildEnvelopeObj("flint", agentId, "recovered after crash", "msg-crash-001");
    const record = {
      id: "msg-crash-001",
      from: "flint",
      to: agentId,
      body: env.body,
      timestamp: env.timestamp,
      read: false,
      envelopeId: env.messageId,
      envelope: env,
      deliveryAttempts: 1,
    };
    const filename = `2026-04-27T00-00-00-${record.id}.json`;
    writeFileSync(resolve(curDir, filename), JSON.stringify(record, null, 2), "utf-8");

    let capturedArgs: any = null;
    let settleFn: () => void = () => {};

    const channelRuntime = {
      routing: {
        buildAgentSessionKey: (params: any) =>
          `agent:${params.agentId}:tps-mail:default:${params.peer.id}`,
      },
      reply: {
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        // Post-before-ack ordering (S2): the dispatch does NOT settle until the
        // test drives the final `deliver` and then calls settleFn(), so the
        // receipt exists before the ack transition runs.
        dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
          capturedArgs = args;
          await new Promise<void>((res) => { settleFn = res; });
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

    await pollUntil(() => capturedArgs !== null, 5000);
    expect(capturedArgs.ctx.MessageSid).toBe("msg-crash-001");
    expect(capturedArgs.ctx.Body).toBe("recovered after crash");

    // The test posts the FINAL reply, then settles. The ack is gated on the
    // receipt that post creates, so it lands only after the file exists.
    await capturedArgs.dispatcherOptions.deliver({ text: "final verdict" }, { kind: "final" });
    settleFn();

    const acked = await pollUntil(() => {
      try {
        return !!JSON.parse(readFileSync(resolve(curDir, filename), "utf-8")).ackedAt;
      } catch {
        return false;
      }
    }, 2000);
    expect(acked).toBe(true);

    if (origKeysDir === undefined) delete process.env.TPS_TEST_KEYS_DIR;
    else process.env.TPS_TEST_KEYS_DIR = origKeysDir;
    rmSync(keysDir, { recursive: true, force: true });

    abortController.abort();
    try { await startPromise; } catch { /* expected on abort */ }
  });

  it("does not re-dispatch a cur/ record that is already acked", async () => {
    const agentId = "test-agent";
    const curDir = resolve(tempMailDir, agentId, "cur");
    mkdirSync(curDir, { recursive: true });

    const record = {
      id: "msg-acked-001",
      from: "flint",
      to: agentId,
      body: "already done",
      timestamp: new Date().toISOString(),
      read: true,
      ackedAt: new Date().toISOString(),
    };
    const filename = `2026-04-27T00-00-00-${record.id}.json`;
    writeFileSync(resolve(curDir, filename), JSON.stringify(record, null, 2), "utf-8");

    let dispatchCount = 0;
    const channelRuntime = {
      routing: {
        buildAgentSessionKey: (params: any) =>
          `agent:${params.agentId}:tps-mail:default:${params.peer.id}`,
      },
      reply: {
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        dispatchReplyWithBufferedBlockDispatcher: async () => {
          dispatchCount++;
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

    await new Promise((r) => setTimeout(r, 300));
    expect(dispatchCount).toBe(0);

    abortController.abort();
    try { await startPromise; } catch { /* expected on abort */ }
  });

  it("quarantines a forged cur/ record with no envelopeId — never delivered", async () => {
    const agentId = "test-agent";
    const curDir = resolve(tempMailDir, agentId, "cur");
    mkdirSync(curDir, { recursive: true });

    // A same-host writer drops unverified content straight into cur/ — no
    // envelopeId, so it did not come through promote(). The sweep must refuse
    // and quarantine it, not present it to the agent.
    const record = {
      id: "msg-forged-001",
      from: "flint",
      to: agentId,
      body: "forged instruction",
      timestamp: new Date().toISOString(),
      read: false,
    };
    const filename = `2026-04-27T00-00-00-${record.id}.json`;
    writeFileSync(resolve(curDir, filename), JSON.stringify(record, null, 2), "utf-8");

    let dispatchCount = 0;
    const channelRuntime = {
      routing: {
        buildAgentSessionKey: (params: any) =>
          `agent:${params.agentId}:tps-mail:default:${params.peer.id}`,
      },
      reply: {
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        dispatchReplyWithBufferedBlockDispatcher: async () => { dispatchCount++; },
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

    await pollUntil(() => readdirSync(curDir).filter((f) => f.endsWith(".json")).length === 0, 2000);
    expect(dispatchCount).toBe(0);
    expect(readdirSync(curDir).filter((f) => f.endsWith(".json")).length).toBe(0);
    const dlqDir = resolve(tempMailDir, agentId, "dlq");
    expect(readdirSync(dlqDir).filter((f) => f.endsWith(".json")).length).toBe(1);
    const reason = readFileSync(resolve(dlqDir, `${filename}.reason`), "utf-8");
    expect(reason).toContain("class: unverified");

    abortController.abort();
    try { await startPromise; } catch { /* expected on abort */ }
  });
});
