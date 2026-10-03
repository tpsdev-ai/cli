/**
 * account-lifetime.test.ts — cli#403.
 *
 * The reply-obligation state (`yieldContexts`, `armedDeadlines`) is
 * module-level and used to outlive an account: contexts grew for the process
 * lifetime, and an armed deadline timer survived an account abort, so after an
 * account restart a stale timer could transition an obligation and nack under a
 * stopped account's context.
 *
 * This file pins the account lifetime the issue asks for:
 *   F403-1 two accounts: aborting one drops ONLY its state; a sibling account's
 *            deadline stays armed and still fires;
 *   F403-2 after an ACK the context AND its timer are gone;
 *   F403-3 after a FAIL the context AND its timer are gone;
 *   F403-4 a late lifecycle event after the abort arms nothing;
 *   F403-5 an in-flight dispatch that settles after the abort arms nothing;
 *   F403-6 contexts do not grow across many obligations.
 *
 * It drives the real gateway lifecycle: a held-open fake dispatch per account,
 * the module-level yield subscription, and (for the ownership assertions) the
 * plugin's own `obligationStateForTests()` snapshot of the in-memory state.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import { signEnvelope, type ChainEntry } from "@tpsdev-ai/agent";

import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const FLINT_SEED = Buffer.alloc(32, 0x01); // the sender
const ANVIL_SEED = Buffer.alloc(32, 0x02); // agent "alpha"
const BETA_SEED = Buffer.alloc(32, 0x03); // agent "beta"

function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

import pluginModule, { obligationStateForTests } from "../src/index.js";

let capturedPlugin: any;
let capturedSubscription: any;
const mockApi: any = {
  registerChannel: ({ plugin }: { plugin: any }) => { capturedPlugin = plugin; },
  registerAgentEventSubscription: (sub: any) => { capturedSubscription = sub; },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};
pluginModule.register(mockApi);

function buildSignedBody(from: string, to: string, body: string, seed: Buffer): string {
  const now = new Date().toISOString();
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: now, rationale: `agent ${from} dispatches`, signature: null },
  ];
  const env = signEnvelope(
    { v: 1, from, to, body, messageId: `env-${Math.random().toString(36).slice(2, 10)}`, timestamp: now, delegationChain: chain },
    { [from]: seed },
  );
  return JSON.stringify(env);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(pred: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

interface AccountSpec {
  accountId: string;
  agentId: string;
  sender: string;
  mailDir: string;
  seed: Buffer;
}

describe("openclaw-tps-mail: obligation state has an account lifetime (cli#403)", () => {
  let tempRoot: string;
  let tempHome: string;
  let keysDir: string;
  let origHome: string | undefined;
  let origKeys: string | undefined;
  let origDeadline: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-al-root-"));
    tempHome = mkdtempSync(join(tmpdir(), "tps-al-home-"));
    keysDir = mkdtempSync(join(tmpdir(), "tps-al-keys-"));
    origHome = process.env.HOME;
    process.env.HOME = tempHome;
    origKeys = process.env.TPS_TEST_KEYS_DIR;
    process.env.TPS_TEST_KEYS_DIR = keysDir;
    origDeadline = process.env.TPS_OBLIGATION_DEADLINE_MS;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origKeys === undefined) delete process.env.TPS_TEST_KEYS_DIR; else process.env.TPS_TEST_KEYS_DIR = origKeys;
    if (origDeadline === undefined) delete process.env.TPS_OBLIGATION_DEADLINE_MS; else process.env.TPS_OBLIGATION_DEADLINE_MS = origDeadline;
    for (const d of [tempRoot, tempHome, keysDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function newMailDir(accountId: string): string {
    return mkdtempSync(join(tempRoot, `${accountId}-`));
  }

  function single(): AccountSpec {
    return { accountId: "acct-403", agentId: "alpha", sender: "flint", mailDir: newMailDir("acct-403"), seed: ANVIL_SEED };
  }

  function obFile(spec: AccountSpec, inboundId: string): any | null {
    try {
      return JSON.parse(readFileSync(resolve(spec.mailDir, spec.agentId, ".obligations", `${inboundId}.json`), "utf-8"));
    } catch { return null; }
  }

  /** A new/ file for this account's agent; id is deterministic per (agent, i). */
  function writeInbound(spec: AccountSpec, i: number): { inboundId: string; envelopeId: string } {
    const signedBody = buildSignedBody(spec.sender, spec.agentId, "inbound payload", FLINT_SEED);
    const inboundId = `msg-${spec.agentId}-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const inbound = {
      id: inboundId,
      from: spec.sender,
      to: spec.agentId,
      body: signedBody,
      timestamp: new Date().toISOString(),
      headers: { "X-TPS-Trust": "agent", "X-TPS-Surface": "tps-mail" },
      deliveryAttempts: 0,
    };
    const dir = resolve(spec.mailDir, spec.agentId, "new");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `2026-05-26T00-00-0${i}-${inboundId}.json`), JSON.stringify(inbound, null, 2), "utf-8");
    return { inboundId, envelopeId: JSON.parse(signedBody).messageId as string };
  }

  interface Handle {
    spec: AccountSpec;
    dispatchCount: number;
    dispatched: any;
    dispatchAt(i: number): any;
    obligationIdAt(i: number): string | null;
    inboundIdAt(i: number): string | null;
    deliver(i: number, text: string): Promise<void>;
    skip(i: number): void;
    settle(i: number): void;
    stop(): Promise<void>;
  }

  /**
   * Boot `specs`, one inbound per account (at startup, so the startup scan
   * dispatches it), and hold every dispatch open until the test settles it.
   */
  async function boot(specs: AccountSpec[], inboundsPerAccount = 1): Promise<Handle[]> {
    const seeds: Record<string, Buffer> = {};
    for (const s of specs) { seeds[s.agentId] = s.seed; seeds[s.sender] = FLINT_SEED; }
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
          const seed = seeds[name];
          return seed ? { publicKey: pubkeyFromSeed(seed) } : null;
        },
      }),
    }));
    writeFileSync(join(keysDir, "flint.key"), FLINT_SEED);
    for (const s of specs) {
      writeFileSync(join(keysDir, `${s.agentId}.key`), s.seed);
      mkdirSync(resolve(s.mailDir, s.sender, "new"), { recursive: true });
      mkdirSync(resolve(s.mailDir, s.agentId, "new"), { recursive: true });
    }

    const accounts: Record<string, any> = {};
    const bindings: any[] = [];
    for (const s of specs) {
      accounts[s.accountId] = { mailDir: s.mailDir, enabled: true };
      bindings.push({ agentId: s.agentId, match: { channel: "tps-mail", accountId: s.accountId } });
    }
    const cfg = { channels: { "tps-mail": { accounts } }, bindings };

    // Write every inbound BEFORE startAccount, so the startup scan delivers it.
    for (const s of specs) {
      for (let i = 0; i < inboundsPerAccount; i++) writeInbound(s, i);
    }

    const handles: Handle[] = specs.map((spec) => {
      const abortController = new AbortController();
      const dispatches: { args: any; settle: () => void }[] = [];
      let dispatchCount = 0;

      const channelRuntime = {
        routing: { buildAgentSessionKey: (p: any) => `agent:${p.agentId}:tps-mail:${spec.accountId}:${p.peer.id}` },
        reply: {
          finalizeInboundContext: async (c: any) => ({ ...c, CommandAuthorized: false }),
          dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
            dispatchCount++;
            await new Promise<void>((res) => { dispatches.push({ args, settle: res }); });
            return { failedCounts: 0 };
          },
        },
      };

      const ctx = {
        account: { accountId: spec.accountId, mailDir: spec.mailDir, enabled: true },
        cfg,
        log: { info: () => {}, warn: () => {}, error: () => {} },
        channelRuntime,
        abortSignal: abortController.signal,
      };
      const startPromise = capturedPlugin.gateway.startAccount(ctx);

      const h: Handle = {
        spec,
        get dispatchCount() { return dispatchCount; },
        get dispatched() { return dispatches[0]?.args ?? null; },
        dispatchAt: (i) => dispatches[i]?.args ?? null,
        obligationIdAt: (i) => (dispatches[i]?.args?.replyOptions?.runId ?? null) as string | null,
        inboundIdAt: (i) => (dispatches[i]?.args?.ctx?.MessageSid ?? null) as string | null,
        async deliver(i, text) {
          await dispatches[i]!.args.dispatcherOptions.deliver({ text }, { kind: "final" });
        },
        skip(i) {
          dispatches[i]!.args.dispatcherOptions.onSkip?.({ text: "" }, { kind: "final", reason: "empty" });
        },
        settle(i) { dispatches[i]!.settle(); },
        async stop() { abortController.abort(); try { await startPromise; } catch { /* aborted */ } },
      };
      return h;
    });

    await pollUntil(() => handles.every((h) => h.dispatchCount >= inboundsPerAccount), 5000);
    return handles;
  }

  // ── F403-1 ─────────────────────────────────────────────────────────────────
  it("F403-1: aborting one account drops only its state; a sibling's deadline stays armed and fires", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "1500";
    const A: AccountSpec = { accountId: "acct-a", agentId: "alpha", sender: "flint", mailDir: newMailDir("acct-a"), seed: ANVIL_SEED };
    const B: AccountSpec = { accountId: "acct-b", agentId: "beta", sender: "flint", mailDir: newMailDir("acct-b"), seed: BETA_SEED };
    const [ha, hb] = await boot([A, B], 1);
    const inbA = ha.inboundIdAt(0)!;
    const inbB = hb.inboundIdAt(0)!;
    const obA = ha.obligationIdAt(0)!;
    const obB = hb.obligationIdAt(0)!;

    ha.settle(0);
    hb.settle(0);
    const bothYielded = await pollUntil(
      () => obFile(A, inbA)?.state === "yielded" && obFile(B, inbB)?.state === "yielded",
      4000,
    );
    expect(bothYielded, "both obligations yielded and armed a deadline").toBe(true);
    expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obA)).toBe(true);
    expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obB)).toBe(true);

    await ha.stop();

    const st = obligationStateForTests();
    expect(st.contexts.some((c) => c.obligationId === obA), "A's context is gone after the abort").toBe(false);
    expect(st.deadlines.some((d) => d.obligationId === obA), "A's timer is cleared after the abort").toBe(false);
    expect(st.deadlines.some((d) => d.obligationId === obB), "B's deadline is STILL armed").toBe(true);

    const bFailed = await pollUntil(() => obFile(B, inbB)?.state === "failed", 5000);
    expect(bFailed, "B's deadline still fires under its live account").toBe(true);
    expect(obFile(A, inbA)?.state, "A's aborted, cleared timer never transitioned its obligation").toBe("yielded");

    await hb.stop();
  }, 25000);

  // ── F403-2 ─────────────────────────────────────────────────────────────────
  it("F403-2: after an ACK the context and its timer are both gone", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const A = single();
    const [h] = await boot([A], 1);
    const inb = h.inboundIdAt(0)!;
    const obId = h.obligationIdAt(0)!;

    // Arm a deadline through the yield subscription, so a timer exists to clear.
    capturedSubscription.handle({ runId: obId, seq: 1, stream: "lifecycle", ts: Date.now(), data: { yielded: true }, sessionKey: "s" });
    await pollUntil(() => obFile(A, inb)?.state === "yielded", 3000);
    expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId), "a deadline is armed before the ack").toBe(true);

    await h.deliver(0, "final answer");
    h.settle(0);
    await pollUntil(() => obFile(A, inb)?.state === "acked", 4000);

    const st = obligationStateForTests();
    expect(st.contexts.some((c) => c.obligationId === obId), "context released on ack").toBe(false);
    expect(st.deadlines.some((d) => d.obligationId === obId), "timer cleared on ack").toBe(false);
    await h.stop();
  }, 20000);

  // ── F403-3 ─────────────────────────────────────────────────────────────────
  it("F403-3: after a FAIL the context and its timer are both gone", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const A = single();
    const [h] = await boot([A], 1);
    const inb = h.inboundIdAt(0)!;
    const obId = h.obligationIdAt(0)!;

    capturedSubscription.handle({ runId: obId, seq: 1, stream: "lifecycle", ts: Date.now(), data: { yielded: true }, sessionKey: "s" });
    await pollUntil(() => obFile(A, inb)?.state === "yielded", 3000);
    expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId)).toBe(true);

    // A definitive non-delivery verdict (empty final) fails it at once.
    h.skip(0);
    h.settle(0);
    await pollUntil(() => obFile(A, inb)?.state === "failed", 4000);

    const st = obligationStateForTests();
    expect(st.contexts.some((c) => c.obligationId === obId), "context released on fail").toBe(false);
    expect(st.deadlines.some((d) => d.obligationId === obId), "timer cleared on fail").toBe(false);
    await h.stop();
  }, 20000);

  // ── F403-4 ─────────────────────────────────────────────────────────────────
  it("F403-4: a late lifecycle event after the abort arms nothing", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const A = single();
    const [h] = await boot([A], 1);
    const inb = h.inboundIdAt(0)!;
    const obId = h.obligationIdAt(0)!;

    // Abort while the dispatch is still in flight; then fire a yielded event for
    // the obligation that was in flight at the abort.
    await h.stop();
    capturedSubscription.handle({ runId: obId, seq: 1, stream: "lifecycle", ts: Date.now(), data: { yielded: true }, sessionKey: "s" });
    await sleep(150);

    const st = obligationStateForTests();
    expect(st.contexts.some((c) => c.obligationId === obId), "the aborted account's context is gone").toBe(false);
    expect(st.deadlines.some((d) => d.obligationId === obId), "the late event armed nothing").toBe(false);
    expect(obFile(A, inb)?.state, "the obligation was not transitioned under the stopped account").not.toBe("failed");

    // Let the held dispatch finish; its tail must not re-arm either.
    h.settle(0);
    await sleep(250);
    expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId), "the settling tail armed nothing").toBe(false);
  }, 20000);

  // ── F403-5 ─────────────────────────────────────────────────────────────────
  it("F403-5: an in-flight dispatch that settles after the abort arms nothing", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const A = single();
    const [h] = await boot([A], 1);
    const inb = h.inboundIdAt(0)!;
    const obId = h.obligationIdAt(0)!;

    await h.stop(); // abort first
    h.settle(0);    // the dispatch now settles, AFTER the abort
    await sleep(300); // let its tail run

    const st = obligationStateForTests();
    expect(st.contexts.some((c) => c.obligationId === obId), "the abort dropped the context").toBe(false);
    expect(st.deadlines.some((d) => d.obligationId === obId), "the settling dispatch armed nothing").toBe(false);
    expect(obFile(A, inb)?.state, "no transition under the stopped account").not.toBe("failed");
  }, 20000);

  // ── F403-6 ─────────────────────────────────────────────────────────────────
  it("F403-6: contexts do not grow across many obligations", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const A = single();
    const N = 4;
    const obIds: string[] = [];

    // One inbound per start (the startup scan promotes one file at a time), so
    // each obligation is dispatched, posted and acked without a concurrency race
    // on the mailbox lock.
    for (let i = 0; i < N; i++) {
      const [h] = await boot([A], 1);
      const inb = h.inboundIdAt(0)!;
      const obId = h.obligationIdAt(0)!;
      obIds.push(obId);

      await h.deliver(0, "final answer");
      h.settle(0);
      const acked = await pollUntil(() => obFile(A, inb)?.state === "acked", 5000);
      expect(acked, `obligation ${i} acked`).toBe(true);
      expect(
        obligationStateForTests().contexts.some((c) => c.obligationId === obId),
        `context ${i} is released when its obligation closes`,
      ).toBe(false);

      await h.stop();
    }

    const st = obligationStateForTests();
    for (const obId of obIds) {
      expect(st.contexts.some((c) => c.obligationId === obId), `context released for ${obId}`).toBe(false);
    }
    expect(st.contexts.length, "acked obligations do not accumulate contexts").toBeLessThan(N);
  }, 30000);
});
