/**
 * obligation-null-deadline.test.ts — cli#1063.
 *
 * Fixtures cover creation deadlines, restart preservation and deadline sweeps.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { createHash, randomUUID } from "node:crypto";
import { signEnvelope, type Envelope, type ChainEntry } from "@tpsdev-ai/agent";

import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const SENDER_SEED = Buffer.alloc(32, 0x11);
const AGENT_SEED = Buffer.alloc(32, 0x22);

function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

import { mailboxReplayStore } from "@tpsdev-ai/agent";
import pluginModule, { awaitStartupCurSweepForTests, setObligationDeadlineSweepForTests, setObligationNowForTests, setObligationRetryDelaysForTests } from "../src/index.js";
import { createObligation, readObligation, setBeforeTransitionForTests } from "../src/obligations.js";

let capturedPlugin: any;
const mockApi: any = {
  registerChannel: ({ plugin }: { plugin: any }) => { capturedPlugin = plugin; },
  registerAgentEventSubscription: () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};
pluginModule.register(mockApi);

const AGENT = "agent-a";
const SENDER = "sender-a";

function signedEnvelopeBody(from: string, to: string, body: string, seed: Buffer, replyToId?: string): string {
  const now = new Date().toISOString();
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: now, rationale: `agent ${from} dispatches`, signature: null },
  ];
  const env = signEnvelope(
    {
      v: 1,
      from,
      to,
      body,
      messageId: `env-${randomUUID()}`,
      timestamp: now,
      delegationChain: chain,
      ...(replyToId ? { replyToId } : {}),
    },
    { [from]: seed },
  );
  return JSON.stringify(env);
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

async function pollUntil(pred: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

describe("cli#1063 — obligation creation and deadline sweeps", () => {
  let mailDir: string;
  let keysDir: string;
  let controller: AbortController;
  let origKeys: string | undefined;
  let origDeadline: string | undefined;
  let origSweep: number | undefined;

  beforeEach(() => {
    mailDir = mkdtempSync(join(tmpdir(), "tps-null-deadline-mail-"));
    keysDir = mkdtempSync(join(tmpdir(), "tps-null-deadline-keys-"));
    controller = new AbortController();
    writeFileSync(join(keysDir, `${AGENT}.key`), AGENT_SEED);
    writeFileSync(join(keysDir, `${SENDER}.key`), SENDER_SEED);
    origKeys = process.env.TPS_TEST_KEYS_DIR;
    process.env.TPS_TEST_KEYS_DIR = keysDir;
    origDeadline = process.env.TPS_OBLIGATION_DEADLINE_MS;
    process.env.TPS_OBLIGATION_DEADLINE_MS = "200";
    origSweep = setObligationDeadlineSweepForTests(50);

    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
          if (name === SENDER) return { publicKey: pubkeyFromSeed(SENDER_SEED) };
          if (name === AGENT) return { publicKey: pubkeyFromSeed(AGENT_SEED) };
          return null;
        },
      }),
    }));
  });

  afterEach(() => {
    try { controller.abort(); } catch { /* */ }
    if (origKeys === undefined) delete process.env.TPS_TEST_KEYS_DIR; else process.env.TPS_TEST_KEYS_DIR = origKeys;
    if (origDeadline === undefined) delete process.env.TPS_OBLIGATION_DEADLINE_MS; else process.env.TPS_OBLIGATION_DEADLINE_MS = origDeadline;
    setObligationDeadlineSweepForTests(origSweep);
    for (const d of [mailDir, keysDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function obligation(inboundId: string): any | null {
    return readObligation(mailDir, AGENT, inboundId);
  }

  function seedNullDeadline(inboundId: string) {
    const envelopeJson = signedEnvelopeBody(SENDER, AGENT, "inbound payload", SENDER_SEED);
    const envelope: Envelope = JSON.parse(envelopeJson);
    mkdirSync(resolve(mailDir, AGENT, "cur"), { recursive: true });
    mkdirSync(resolve(mailDir, AGENT, ".obligations"), { recursive: true });
    writeFileSync(
      resolve(mailDir, AGENT, "cur", `2026-05-26T00-00-00-${inboundId}.json`),
      JSON.stringify({
        id: inboundId,
        from: SENDER,
        to: AGENT,
        body: envelope.body,
        timestamp: envelope.timestamp,
        read: false,
        envelopeId: envelope.messageId,
        envelope,
      }, null, 2),
      "utf-8",
    );
    mailboxReplayStore(resolve(mailDir, AGENT)).recordConsumed(envelope.messageId);
    return createObligation(mailDir, AGENT, () => ({
      obligationId: randomUUID(),
      inboundId,
      inboundEnvelopeId: envelope.messageId,
      inboundTimestamp: envelope.timestamp,
      from: SENDER,
      to: AGENT,
      accountId: "default",
      state: "pending",
      deadlineAt: null,
      attempts: 1,
    }));
  }

  function curFile(inboundId: string): any | null {
    for (const name of readdirSafe(resolve(mailDir, AGENT, "cur"))) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(resolve(mailDir, AGENT, "cur", name), "utf-8"));
        if (rec?.id === inboundId) return rec;
      } catch { /* skip */ }
    }
    return null;
  }

  function startWith(dispatch: "hold" | "settle-without-final", opts: { inbound?: boolean } = {}, ctl?: AbortController) {
    const signal = ctl ?? controller;
    const newDir = resolve(mailDir, AGENT, "new");
    mkdirSync(newDir, { recursive: true });
    mkdirSync(resolve(mailDir, SENDER, "new"), { recursive: true });

    const inboundId = `msg-${randomUUID()}`;
    const envelopeJson = signedEnvelopeBody(SENDER, AGENT, "inbound payload", SENDER_SEED);
    if (opts.inbound !== false) {
      writeFileSync(
        resolve(newDir, `2026-05-26T00-00-00-${inboundId}.json`),
        JSON.stringify({
          id: inboundId,
          from: SENDER,
          to: AGENT,
          body: envelopeJson,
          timestamp: new Date().toISOString(),
          headers: { "X-TPS-Trust": "agent", "X-TPS-Surface": "tps-mail" },
          deliveryAttempts: 0,
        }, null, 2),
        "utf-8",
      );
    }

    let dispatched: any = null;
    let settleFn: (() => void) | null = null;
    const logs: string[] = [];
    const channelRuntime = {
      routing: { buildAgentSessionKey: (p: any) => `agent:${p.agentId}:tps-mail:default:${p.peer.id}` },
      reply: {
        finalizeInboundContext: async (c: any) => c,
        dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
          dispatched = args;
          await new Promise<void>((res) => { settleFn = res; });
          return { failedCounts: 0 };
        },
      },
    };
    const cfg = {
      channels: { "tps-mail": { accounts: { default: { mailDir, enabled: true } } } },
      bindings: [{ agentId: AGENT, match: { channel: "tps-mail", accountId: "default" } }],
    };
    const ctx = {
      account: { accountId: "default", mailDir, enabled: true },
      cfg,
      log: {
        info: (...a: any[]) => logs.push(`INFO ${a.map(String).join(" ")}`),
        warn: (...a: any[]) => logs.push(`WARN ${a.map(String).join(" ")}`),
        error: (...a: any[]) => logs.push(`ERROR ${a.map(String).join(" ")}`),
      },
      channelRuntime,
      abortSignal: signal.signal,
    };
    const startPromise = capturedPlugin.gateway.startAccount(ctx);
    return {
      inboundId,
      logs,
      startPromise,
      get dispatched() { return dispatched; },
      settle: () => settleFn?.(),
      stop: async () => { signal.abort(); try { await startPromise; } catch { /* aborted */ } },
    };
  }

  // ── (a) ────────────────────────────────────────────────────────────────────
  it("(a) an obligation settles after its deadline when the turn end is not observed", async () => {
    const h = startWith("hold");
    const got = await pollUntil(() => h.dispatched !== null, 4000);
    expect(got).toBe(true);
    expect(obligation(h.inboundId)?.state).toBe("pending");

    // The dispatch promise never resolves and no lifecycle event arrives.
    const terminal = await pollUntil(() => {
      const state = obligation(h.inboundId)?.state;
      return state === "acked" || state === "failed" || state === "unconfirmed";
    }, 3000);
    expect(terminal, "the obligation leaves pending without a turn-end event").toBe(true);
    const cur = curFile(h.inboundId);
    expect(cur?.ackedAt ?? cur?.nackedAt, "the inbound mail is settled").toBeDefined();
    await h.stop();
  }, 15000);

  // ── (b) ────────────────────────────────────────────────────────────────────
  it("(b) a null deadline seeded after startup is armed by the periodic sweep and settles", async () => {
    const h = startWith("hold", { inbound: false });
    const inboundId = `msg-${randomUUID()}`;
    const startupDone = await awaitStartupCurSweepForTests("default", inboundId, 10000);
    expect(startupDone, "startup recovery completes before the record is seeded").toBe(true);

    seedNullDeadline(inboundId);

    const armed = await pollUntil(() => !!obligation(inboundId)?.deadlineAt, 2000);
    expect(armed, "the periodic sweep arms the null deadline").toBe(true);
    const terminal = await pollUntil(() => {
      const state = obligation(inboundId)?.state;
      return state === "acked" || state === "failed" || state === "unconfirmed";
    }, 3000);
    expect(terminal, "the armed record settles").toBe(true);
    await h.stop();
  }, 15000);

  // ── (c) ────────────────────────────────────────────────────────────────────
  it("(c) a created obligation persists its deadline, and a restart leaves it unchanged", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "60000";
    const sweepPrev = setObligationDeadlineSweepForTests(60_000);
    try {
      const h = startWith("hold");
      const got = await pollUntil(() => h.dispatched !== null, 4000);
      expect(got).toBe(true);

      // Read as soon as the turn starts: no sweep has run at this interval.
      const firstDeadline = obligation(h.inboundId)?.deadlineAt;
      expect(typeof firstDeadline).toBe("string");
      expect(Date.parse(firstDeadline) - Date.now()).toBeGreaterThan(30_000);
      await h.stop();

      const ctl = new AbortController();
      const h2 = startWith("hold", { inbound: false }, ctl);
      const startupDone = await awaitStartupCurSweepForTests("default", h.inboundId, 10000);
      expect(startupDone, "startup recovery completes after the restart").toBe(true);
      expect(obligation(h.inboundId)?.deadlineAt).toBe(firstDeadline);
      await h2.stop();
    } finally {
      setObligationDeadlineSweepForTests(sweepPrev);
    }
  }, 20000);

  it("(d) the sweep skips a deadline owned by an armed timer", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "60000";
    const h = startWith("hold", { inbound: false });
    const inboundId = `msg-${randomUUID()}`;
    try {
      expect(await awaitStartupCurSweepForTests("default", inboundId, 10000)).toBe(true);
      seedNullDeadline(inboundId);
      expect(await pollUntil(() => typeof obligation(inboundId)?.deadlineAt === "string", 2000)).toBe(true);
      expect(obligation(inboundId)?.state).toBe("yielded");
      setObligationNowForTests(() => Date.now() + 120_000);
      await new Promise((r) => setTimeout(r, 250));
      expect(obligation(inboundId)?.state).toBe("yielded");
    } finally {
      setObligationNowForTests(undefined);
      await h.stop();
    }
  }, 15000);

  it("(e) the sweep warns with the path of an invalid obligation file", async () => {
    const h = startWith("hold", { inbound: false });
    try {
      expect(await awaitStartupCurSweepForTests("default", h.inboundId, 10000)).toBe(true);
      const dir = resolve(mailDir, AGENT, ".obligations");
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, `bad-${randomUUID()}.json`);
      writeFileSync(path, "{");
      expect(await pollUntil(() => h.logs.some((line) =>
        line.startsWith("WARN tps-mail: obligation-deadline-sweep-unreadable:") && line.includes(path),
      ), 1000)).toBe(true);
    } finally {
      await h.stop();
    }
  }, 15000);

  it("(f) a sweep arm write failure exhausts its retry and stays skipped", async () => {
    const h = startWith("hold", { inbound: false });
    const inboundId = `msg-${randomUUID()}`;
    const retryPrev = setObligationRetryDelaysForTests([10, 20, 30]);
    let armWrites = 0;
    try {
      expect(await awaitStartupCurSweepForTests("default", inboundId, 10000)).toBe(true);
      setBeforeTransitionForTests((id, next) => {
        if (id === inboundId && next === "yielded") {
          armWrites++;
          throw new Error("injected sweep arm write failure");
        }
      });
      const { record } = seedNullDeadline(inboundId);
      const warnings = () => h.logs.filter((line) =>
        line.startsWith("WARN tps-mail: obligation-retry-exhausted:") && line.includes(record.obligationId),
      );
      expect(await pollUntil(() => warnings().length > 0, 1000)).toBe(true);
      expect(warnings()).toHaveLength(1);
      expect(armWrites).toBeGreaterThan(1);
      const exhaustedWrites = armWrites;
      await new Promise((r) => setTimeout(r, 250));
      expect(armWrites).toBe(exhaustedWrites);
      expect(warnings()).toHaveLength(1);
      expect(obligation(inboundId)?.state).toBe("pending");
      expect(obligation(inboundId)?.deadlineAt).toBeNull();
    } finally {
      setBeforeTransitionForTests(undefined);
      setObligationRetryDelaysForTests(retryPrev);
      await h.stop();
    }
  }, 15000);
});
