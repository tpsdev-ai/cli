/**
 * dispatcher-reply.test.ts — cli#338: the dispatcher reply path must deliver
 * ONE explicit, signed, idempotent reply per inbound — never a dead-drop
 * outbox full of unsigned intermediate blocks.
 *
 * Three must-fail tests (each RED before the fix):
 *   1. local unbound sender → 2 text blocks, no explicit send → exactly ONE
 *      file in ~/.tps/mail/<sender>/new/, signed, with messageId; zero in
 *      ~/.tps/outbox/new/.
 *   2. same, but the agent runs `tps mail send <sender>` mid-turn → zero
 *      dispatcher files (the explicit send is the only delivery).
 *   3. recipient with neither maildir nor binding → one warning, zero files.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
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
const ANVIL_SEED = Buffer.alloc(32, 0x02);

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

function makeMailEnvelope(body: string, overrides: Partial<{ id: string; from: string; to: string; timestamp: string }> = {}) {
  return {
    id: overrides.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: overrides.from ?? "flint",
    to: overrides.to ?? "anvil",
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

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

describe("openclaw-tps-mail: dispatcher single-reply (cli#338)", () => {
  let tempMailDir: string;
  let tempKeysDir: string;
  let tempHome: string;
  let abortController: AbortController;
  let origHome: string | undefined;
  let origKeysDir: string | undefined;

  beforeEach(() => {
    tempMailDir = mkdtempSync(join(tmpdir(), "tps-dispatch-mail-"));
    tempKeysDir = mkdtempSync(join(tmpdir(), "tps-dispatch-keys-"));
    tempHome = mkdtempSync(join(tmpdir(), "tps-dispatch-home-"));
    abortController = new AbortController();

    // Point the agent's signing key at a hermetic temp dir.
    writeFileSync(join(tempKeysDir, "anvil.key"), ANVIL_SEED);
    origKeysDir = process.env.TPS_TEST_KEYS_DIR;
    process.env.TPS_TEST_KEYS_DIR = tempKeysDir;

    // Point ~/.tps/outbox at a hermetic temp dir so we can assert "zero files".
    origHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    abortController.abort();
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origKeysDir === undefined) delete process.env.TPS_TEST_KEYS_DIR; else process.env.TPS_TEST_KEYS_DIR = origKeysDir;
    try { rmSync(tempMailDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(tempKeysDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  /**
   * Start the plugin for a single inbound from `sender` to `agentId`, capture
   * the dispatcher's `deliver` callback, and return everything the test needs
   * to drive the reply path and assert on the filesystem.
   */
  async function startDispatcher(
    agentId: string,
    sender: string,
    opts: { senderHasMaildir?: boolean; warnCalls?: string[] } = {},
  ) {
    mock.module("../src/verify-adapter.js", () => ({
      createVerifyClient: async () => ({
        async getAgent(name: string) {
          if (name === sender) return { publicKey: pubkeyFromSeed(FLINT_SEED) };
          return null;
        },
      }),
    }));

    // Local maildir for the sender (unbound) — the "local recipient" case.
    if (opts.senderHasMaildir) {
      mkdirSync(resolve(tempMailDir, sender, "new"), { recursive: true });
    }

    const newDir = resolve(tempMailDir, agentId, "new");
    mkdirSync(newDir, { recursive: true });

    const signedBody = buildSignedBody(sender, agentId, "inbound payload");
    const envelope = makeMailEnvelope(signedBody, { from: sender, to: agentId, id: `msg-${Date.now()}` });
    const filename = `2026-05-26T00-00-00-${envelope.id}.json`;
    writeFileSync(resolve(newDir, filename), JSON.stringify(envelope, null, 2), "utf-8");

    let dispatchResolve: (val: any) => void;
    const dispatchPromise = new Promise<any>((res) => { dispatchResolve = res; });

    const warnCalls = opts.warnCalls ?? [];
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
      log: {
        info: () => {},
        warn: (...args: any[]) => { warnCalls.push(args.map(String).join(" ")); },
        error: () => {},
      },
      channelRuntime,
      abortSignal: abortController.signal,
    };

    const startPromise = capturedPlugin.gateway.startAccount(ctx);

    const result = await Promise.race([
      dispatchPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for dispatch")), 5000)),
    ]);

    return { result, startPromise, warnCalls };
  }

  it("delivers exactly ONE signed reply to a local unbound sender, zero to outbox", async () => {
    const { result, startPromise, warnCalls } = await startDispatcher("anvil", "flint", { senderHasMaildir: true });

    const { dispatcherOptions } = result;

    // Two text blocks, no explicit send.
    await dispatcherOptions.deliver({ text: "intermediate narration" }, { kind: "block" });
    await dispatcherOptions.deliver({ text: "final verdict" }, { kind: "final" });

    // Assert: exactly ONE file in flint's local maildir.
    const flintNew = resolve(tempMailDir, "flint", "new");
    const files = readdirSafe(flintNew).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    // Assert: the single file is a signed envelope with a messageId.
    const raw = readFileSync(resolve(flintNew, files[0]!), "utf-8");
    const mail = JSON.parse(raw);
    expect(mail.from).toBe("anvil");
    expect(mail.to).toBe("flint");
    const env: Envelope = JSON.parse(mail.body);
    expect(env.v).toBe(1);
    expect(typeof env.signature).toBe("string");
    expect(typeof env.messageId).toBe("string");
    expect(env.from).toBe("anvil");
    expect(env.to).toBe("flint");
    expect(env.body).toBe("final verdict");

    // Assert: zero files in outbox.
    const outboxNew = resolve(tempHome, ".tps", "outbox", "new");
    expect(readdirSafe(outboxNew).filter((f) => f.endsWith(".json")).length).toBe(0);

    abortController.abort();
    try { await startPromise; } catch { /* expected on abort */ }
  });

  it("writes zero dispatcher files when the agent already sent explicitly", async () => {
    const { result, startPromise } = await startDispatcher("anvil", "flint", { senderHasMaildir: true });

    const { dispatcherOptions } = result;

    // Simulate the agent running `tps mail send flint "..."` mid-turn: a signed
    // envelope from anvil → flint lands in flint's maildir with a timestamp
    // >= the inbound's timestamp.
    const explicitBody = buildSignedBody("anvil", "flint", "explicit send");
    const explicitMail = {
      id: `msg-explicit-${Date.now()}`,
      from: "anvil",
      to: "flint",
      body: explicitBody,
      timestamp: new Date().toISOString(),
      headers: { "X-TPS-Trust": "agent" },
      deliveryAttempts: 0,
    };
    const flintNew = resolve(tempMailDir, "flint", "new");
    mkdirSync(flintNew, { recursive: true });
    writeFileSync(
      resolve(flintNew, `2026-05-26T00-00-01-${explicitMail.id}.json`),
      JSON.stringify(explicitMail, null, 2),
      "utf-8",
    );

    // Dispatcher emits a final block — but must write NOTHING (idempotent).
    await dispatcherOptions.deliver({ text: "final verdict" }, { kind: "final" });

    // Assert: the ONLY file in flint's maildir is the explicit send (1 file),
    // not a second dispatcher file.
    const files = readdirSafe(flintNew).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    expect(files[0]).toContain(explicitMail.id);

    // Assert: zero files in outbox.
    const outboxNew = resolve(tempHome, ".tps", "outbox", "new");
    expect(readdirSafe(outboxNew).filter((f) => f.endsWith(".json")).length).toBe(0);

    abortController.abort();
    try { await startPromise; } catch { /* expected on abort */ }
  });

  it("warns and writes zero files for a recipient with neither maildir nor binding", async () => {
    const warnCalls: string[] = [];
    const { result, startPromise } = await startDispatcher("anvil", "flint", { senderHasMaildir: false, warnCalls });

    const { dispatcherOptions } = result;

    await dispatcherOptions.deliver({ text: "final verdict" }, { kind: "final" });

    // Assert: one warning naming the recipient.
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(warnCalls.join("\n")).toContain("flint");

    // Assert: zero files in flint's maildir (doesn't even exist) and zero in outbox.
    const flintNew = resolve(tempMailDir, "flint", "new");
    expect(existsSync(flintNew)).toBe(false);
    const outboxNew = resolve(tempHome, ".tps", "outbox", "new");
    expect(readdirSafe(outboxNew).filter((f) => f.endsWith(".json")).length).toBe(0);

    abortController.abort();
    try { await startPromise; } catch { /* expected on abort */ }
  });
});
