import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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
import { transitionObligation, writeReceipt } from "../src/obligations.js";

let capturedPlugin: any;
let capturedSubscription: any;
const mockApi: any = {
  registerChannel: ({ plugin }: { plugin: any }) => { capturedPlugin = plugin; },
  registerAgentEventSubscription: (sub: any) => { capturedSubscription = sub; },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};
pluginModule.register(mockApi);

function buildSignedBody(from: string, to: string, body: string, seed: Buffer, replyToId?: string): string {
  const now = new Date().toISOString();
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: now, rationale: `agent ${from} dispatches`, signature: null },
  ];
  const env = signEnvelope(
    { v: 1, from, to, body, messageId: `env-${Math.random().toString(36).slice(2, 10)}`, timestamp: now, delegationChain: chain, ...(replyToId ? { replyToId } : {}) },
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
  let receiptGate: (() => Promise<void>) | undefined;
  let rejectReceipt = false;
  const publicKeys: Record<string, Buffer> = {};

  beforeEach(() => {
    receiptGate = undefined;
    rejectReceipt = false;
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

  function mailFiles(spec: AccountSpec): Record<string, string> {
    const files: Record<string, string> = {};
    for (const path of readdirSync(spec.mailDir, { recursive: true, withFileTypes: true })) {
      if (!path.isFile()) continue;
      const full = join(path.parentPath, path.name);
      const relative = full.slice(spec.mailDir.length + 1);
      if (!relative.includes(".obligations/")) files[relative] = readFileSync(full, "utf8");
    }
    return files;
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
    stopAccount(fresh?: boolean, unknownSignal?: boolean): Promise<void>;
    replacementStart(reason: string): Promise<void>;
    logs: string[];
  }

  /**
   * Write the requested number of inbounds per account and hold dispatches open.
   */
  async function boot(specs: AccountSpec[], inboundsPerAccount = 1): Promise<Handle[]> {
    for (const s of specs) { publicKeys[s.agentId] = s.seed; publicKeys[s.sender] = FLINT_SEED; }
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
          if (receiptGate && name !== "flint") {
            await receiptGate();
            if (rejectReceipt) return null;
          }
          const seed = publicKeys[name];
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

      const logs: string[] = [];
      const ctx = {
        account: { accountId: spec.accountId, mailDir: spec.mailDir, enabled: true },
        cfg,
        log: { info: (s: string) => logs.push(s), warn: (s: string) => logs.push(s), error: (s: string) => logs.push(s) },
        channelRuntime,
        abortSignal: abortController.signal,
      };
      const startPromise = capturedPlugin.gateway.startAccount(ctx);

      const h: Handle = {
        spec,
        logs,
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
        async replacementStart(reason) {
          const replacement = { ...ctx, abortSignal: new AbortController().signal };
          if (reason === "runtime") replacement.channelRuntime = undefined as any;
          if (reason === "directory") replacement.account = { ...ctx.account, mailDir: join(tempRoot, "missing") };
          if (reason === "conflict") replacement.cfg = {
            ...cfg, channels: { "tps-mail": { accounts: { ...accounts, other: { mailDir: spec.mailDir } } } },
          };
          if (reason === "bindings") replacement.cfg = { ...cfg, bindings: [] };
          await capturedPlugin.gateway.startAccount(replacement);
        },
        async stopAccount(fresh = false, unknownSignal = false) {
          await capturedPlugin.gateway.stopAccount(fresh
            ? { ...ctx, ...(unknownSignal ? { abortSignal: new AbortController().signal } : {}) }
            : ctx);
        },
      };
      return h;
    });

    expect(await pollUntil(() => handles.every((h) => h.dispatchCount >= inboundsPerAccount), 5000)).toBe(true);
    return handles;
  }

  for (const site of ["ack", "settle", "fail-transition"] as const) {
    for (const failure of ["EIO", "INVALID_JSON", "ENOENT"] as const) {
      it(`${site} cleanup ${failure === "ENOENT" ? "clears confirmed-missing state" : `retains state after ${failure}`}`, async () => {
        process.env.TPS_OBLIGATION_DEADLINE_MS = "1500";
        const A = single();
        const [h] = await boot([A]);
        const inb = h.inboundIdAt(0)!;
        const obId = h.obligationIdAt(0)!;
        const path = resolve(A.mailDir, A.agentId, ".obligations", `${inb}.json`);
        capturedSubscription.handle({ runId: obId, stream: "lifecycle", data: { yielded: true } });
        expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId)).toBe(true);
        if (site === "ack") await h.deliver(0, "final answer"); else h.skip(0);
        const realRead = fs.readFileSync;
        let reads = 0;
        const read = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
          if (String(args[0]) === path && ++reads > (site === "settle" ? 0 : 1)) {
            if (failure === "INVALID_JSON") return "{";
            if (failure === "ENOENT") {
              rmSync(path, { force: true });
              return realRead(...args);
            }
            throw Object.assign(new Error("transient obligation read"), { code: failure });
          }
          return realRead(...args);
        });
        try {
          h.settle(0);
          expect(await pollUntil(() => h.logs.some((s) => failure === "ENOENT"
            ? s.includes(`refusing to ack ${inb}`) || !obligationStateForTests().contexts.some((c) => c.obligationId === obId)
            : s.includes(`obligation-read-unverified: ${inb}`)))).toBe(true);
          const st = obligationStateForTests();
          expect(st.contexts.some((c) => c.obligationId === obId)).toBe(failure !== "ENOENT");
          expect(st.deadlines.some((d) => d.obligationId === obId)).toBe(failure !== "ENOENT");
          if (failure !== "ENOENT") {
            expect(h.logs.some((s) => s.includes(`path=${path} code=${failure}`))).toBe(true);
          }
        } finally {
          read.mockRestore();
          if (failure === "ENOENT") await h.stop();
        }
        if (failure !== "ENOENT") {
          expect(await pollUntil(() => ["acked", "failed"].includes(obFile(A, inb)?.state), 5000)).toBe(true);
          expect(obFile(A, inb)?.state).toBe(site === "ack" ? "acked" : "failed");
          expect(obligationStateForTests().contexts.some((c) => c.obligationId === obId)).toBe(false);
          await h.stop();
        }
      }, 10000);
    }
  }

  for (const site of ["settlement without timer", "deadline firing"] as const) {
    it(`unreadable obligation retries after ${site} and resolves when reads recover`, async () => {
      process.env.TPS_OBLIGATION_DEADLINE_MS = "100";
      const A = single();
      const [h] = await boot([A]);
      const inb = h.inboundIdAt(0)!;
      const obId = h.obligationIdAt(0)!;
      const path = resolve(A.mailDir, A.agentId, ".obligations", `${inb}.json`);
      if (site === "deadline firing") {
        capturedSubscription.handle({ runId: obId, stream: "lifecycle", data: { yielded: true } });
      } else {
        h.skip(0);
        expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId)).toBe(false);
      }
      const priorDeadline = obFile(A, inb)?.deadlineAt;
      const realRead = fs.readFileSync;
      let failedReads = 0;
      const read = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === path) {
          failedReads++;
          throw Object.assign(new Error("transient obligation read"), { code: "EIO" });
        }
        return realRead(...args);
      });
      try {
        if (site === "settlement without timer") h.settle(0);
        expect(await pollUntil(() => h.logs.some((s) => s.includes(`obligation-read-unverified: ${inb}`)))).toBe(true);
        expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId)).toBe(true);
        expect(h.logs.some((s) => s.includes(`path=${path} code=EIO`))).toBe(true);
        expect(await pollUntil(() => failedReads >= 2)).toBe(true);
        expect(obligationStateForTests().contexts.some((c) => c.obligationId === obId)).toBe(true);
      } catch (err) {
        h.settle(0);
        await h.stop();
        throw err;
      } finally {
        read.mockRestore();
      }
      try {
        expect(obFile(A, inb)?.deadlineAt).toBe(priorDeadline);
        expect(await pollUntil(() => obFile(A, inb)?.state === "failed", 5000)).toBe(true);
        if (site === "deadline firing") expect(obFile(A, inb)?.deadlineAt).toBe(priorDeadline);
        expect(obligationStateForTests().contexts.some((c) => c.obligationId === obId)).toBe(false);
        expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId)).toBe(false);
      } finally {
        h.settle(0);
        await h.stop();
      }
    }, 10000);
  }

  for (const reason of ["runtime", "directory", "conflict", "bindings"]) {
    it(`replacement start rejected for ${reason} clears the prior incarnation`, async () => {
      process.env.TPS_OBLIGATION_DEADLINE_MS = "100";
      const A = single();
      const [h] = await boot([A]);
      const inb = h.inboundIdAt(0)!;
      const obId = h.obligationIdAt(0)!;
      capturedSubscription.handle({ runId: obId, stream: "lifecycle", data: { yielded: true } });
      const prior = obFile(A, inb);
      try {
        await h.replacementStart(reason);
        expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId)).toBe(false);
        expect(obligationStateForTests().contexts.some((c) => c.obligationId === obId)).toBe(false);
        h.settle(0);
        await sleep(250);
        expect(obFile(A, inb)).toEqual(prior);
      } finally {
        h.settle(0);
        await h.stop();
      }
    });
  }

  it("a fresh stop context with the start signal invalidates its incarnation", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const A = single();
    const [h] = await boot([A]);
    const inb = h.inboundIdAt(0)!;
    const obId = h.obligationIdAt(0)!;
    capturedSubscription.handle({ runId: obId, stream: "lifecycle", data: { yielded: true } });
    const prior = obFile(A, inb);
    await h.stopAccount(true);
    expect(obligationStateForTests().contexts.some((c) => c.obligationId === obId)).toBe(false);
    expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId)).toBe(false);
    h.settle(0);
    await sleep(100);
    expect(obFile(A, inb)).toEqual(prior);
    await h.stop();
  });

  it("a delayed fresh stop context and an unknown signal leave the replacement live", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const A = single();
    const [old] = await boot([A]);
    const obId = old.obligationIdAt(0)!;
    capturedSubscription.handle({ runId: obId, stream: "lifecycle", data: { yielded: true } });
    await old.stop();
    const [replacement] = await boot([A], 0);
    expect(await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obId))).toBe(true);
    const prior = obligationStateForTests();
    await old.stopAccount(true);
    await replacement.stopAccount(true, true);
    expect(obligationStateForTests()).toEqual(prior);
    expect(replacement.logs.some((s) => s.includes("stop-account-unverified"))).toBe(true);
    old.settle(0);
    await replacement.stop();
  });

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
    expect(st.contexts.some((c) => c.obligationId === obB), "B's context is still live").toBe(true);

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
    expect(await pollUntil(() => obFile(A, inb)?.state === "acked", 4000)).toBe(true);
    expect(obFile(A, inb)?.state).toBe("acked");

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
    expect(await pollUntil(() => obFile(A, inb)?.state === "failed", 4000)).toBe(true);
    expect(obFile(A, inb)?.state).toBe("failed");

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

    const prior = obFile(A, inb);
    const priorFiles = mailFiles(A);
    await h.stop();
    capturedSubscription.handle({ runId: obId, seq: 1, stream: "lifecycle", ts: Date.now(), data: { yielded: true }, sessionKey: "s" });
    await sleep(150);

    const st = obligationStateForTests();
    expect(st.contexts.some((c) => c.obligationId === obId), "the aborted account's context is gone").toBe(false);
    expect(st.deadlines.some((d) => d.obligationId === obId), "the late event armed nothing").toBe(false);
    expect(obFile(A, inb)).toEqual(prior);
    expect(mailFiles(A)).toEqual(priorFiles);

    // Let the held dispatch finish; its tail must not re-arm either.
    h.settle(0);
    await sleep(250);
    expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId), "the settling tail armed nothing").toBe(false);
    expect(obFile(A, inb)).toEqual(prior);
    expect(mailFiles(A)).toEqual(priorFiles);
  }, 20000);

  // ── F403-5 ─────────────────────────────────────────────────────────────────
  it("F403-5: an in-flight dispatch that settles after the abort arms nothing", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const A = single();
    const [h] = await boot([A], 1);
    const inb = h.inboundIdAt(0)!;
    const obId = h.obligationIdAt(0)!;

    const prior = obFile(A, inb);
    const priorFiles = mailFiles(A);
    await h.stop(); // abort first
    h.settle(0);    // the dispatch now settles, AFTER the abort
    await sleep(300); // let its tail run

    const st = obligationStateForTests();
    expect(st.contexts.some((c) => c.obligationId === obId), "the abort dropped the context").toBe(false);
    expect(st.deadlines.some((d) => d.obligationId === obId), "the settling dispatch armed nothing").toBe(false);
    expect(obFile(A, inb)).toEqual(prior);
    expect(mailFiles(A)).toEqual(priorFiles);
  }, 20000);

  // ── F403-6 ─────────────────────────────────────────────────────────────────
  it("F403-6: contexts do not grow across many obligations", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const A = single();
    const N = 4;
    const obIds: string[] = [];

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
  for (const state of ["delivering", "posted"] as const) {
    it(`stop clears ${state} state; restart recovers its durable obligation`, async () => {
      process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
      const A = single();
      const [h] = await boot([A]);
      const inb = h.inboundIdAt(0)!;
      const obId = h.obligationIdAt(0)!;
      transitionObligation(A.mailDir, A.agentId, inb, state);
      capturedSubscription.handle({ runId: obId, stream: "lifecycle", data: { yielded: true } });
      expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId)).toBe(true);
      const prior = obFile(A, inb);
      const priorFiles = mailFiles(A);
      if (state === "posted") await h.stopAccount(); else await h.stop();
      expect(obligationStateForTests().contexts.some((c) => c.obligationId === obId)).toBe(false);
      expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId)).toBe(false);
      h.settle(0);
      await sleep(100);
      expect(obFile(A, inb)).toEqual(prior);
      expect(mailFiles(A)).toEqual(priorFiles);
      const [restart] = await boot([A], 0);
      expect(await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obId))).toBe(true);
      expect(obFile(A, inb)?.state).toBe(state);
      expect(restart.dispatchCount).toBe(0);
      await restart.stop();
    });
  }

  for (const found of [true, false]) {
    it(`a deadline awaiting a receipt across stop cannot ${found ? "ack" : "fail and nack"}`, async () => {
      process.env.TPS_OBLIGATION_DEADLINE_MS = "100";
      const A = single();
      const [h] = await boot([A]);
      const inb = h.inboundIdAt(0)!;
      const obId = h.obligationIdAt(0)!;
      let release!: () => void;
      let scanning = false;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      receiptGate = () => { scanning = true; return gate; };
      rejectReceipt = !found;
      const replyToId = obFile(A, inb).inboundEnvelopeId;
      writeReceipt(A.mailDir, A.agentId, {
        obligationId: obId, replyId: "paused-receipt", replyToId, route: "local",
        ts: new Date().toISOString(),
        signedReply: buildSignedBody(A.agentId, A.sender, "reply", A.seed, replyToId),
      });
      capturedSubscription.handle({ runId: obId, stream: "lifecycle", data: { yielded: true } });
      expect(await pollUntil(() => scanning)).toBe(true);
      const prior = obFile(A, inb);
      const priorFiles = mailFiles(A);
      await h.stop();
      release();
      await sleep(200);
      expect(obFile(A, inb)).toEqual(prior);
      expect(mailFiles(A)).toEqual(priorFiles);
      expect(obligationStateForTests().contexts.some((c) => c.obligationId === obId)).toBe(false);
      expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obId)).toBe(false);
      receiptGate = undefined;
      h.settle(0);
    });
  }

  it("old-incarnation dispatch settles after restart without touching recovery or a live sibling", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const A = single();
    const B: AccountSpec = { accountId: "acct-b", agentId: "beta", sender: "flint", mailDir: newMailDir("acct-b"), seed: BETA_SEED };
    const [old, sibling] = await boot([A, B]);
    const inb = old.inboundIdAt(0)!;
    const obId = old.obligationIdAt(0)!;
    sibling.settle(0);
    expect(await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === sibling.obligationIdAt(0)))).toBe(true);
    await old.deliver(0, "old final");
    await old.stop();
    const [restart] = await boot([A], 0);
    expect(await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obId))).toBe(true);
    const prior = obFile(A, inb);
    const priorFiles = mailFiles(A);
    const priorSibling = obFile(B, sibling.inboundIdAt(0)!);
    const state = obligationStateForTests();
    old.settle(0);
    expect(await pollUntil(() => old.logs.some((s) => s.includes(`old-incarnation-dispatch-ignored: ${inb}`)) || obFile(A, inb)?.state !== prior.state)).toBe(true);
    expect(obFile(A, inb)).toEqual(prior);
    expect(mailFiles(A)).toEqual(priorFiles);
    expect(obFile(B, sibling.inboundIdAt(0)!)).toEqual(priorSibling);
    expect(obligationStateForTests()).toEqual(state);
    expect(old.logs.some((s) => s.includes(`old-incarnation-dispatch-ignored: ${inb}`))).toBe(true);
    await restart.stop();
    await sibling.stop();
  });

});
