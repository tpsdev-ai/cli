import { MailClient, mailboxReplayStore, acquireMailLockSync } from "@tpsdev-ai/agent";
/**
 * reply-obligation.test.ts — slice S2 of the reply-OBLIGATION work (the
 * follow-up to cli#392's S0/S1).
 *
 * I1: a success ack requires a committed final-reply RECEIPT for THIS inbound;
 * yield is pending; failure is durably named; exactly one obligation-discharging
 * post per inbound.
 *
 * Harness: the same order-enforcing fake channelRuntime as #392 — the dispatch
 * does NOT settle until the test drives `deliver` and calls `settle()`, so
 * post-before-ack ordering is observable. On top of that, this file drives the
 * agent-event subscription (yield detection) and reads the durable obligation
 * records directly from `<mailDir>/<agent>/.obligations/<inboundId>.json`.
 *
 * Fixtures: F-S2a happy path + order; F-S2b empty final; F-S2c missing key;
 * F-S2e crash after post before ack; F-S2f crash-yield → re-arm; F-S2g yielded
 * run → named failure at the deadline; F-S2h two accounts, one mailDir; F-S2i
 * the yielded-run regression (fails on the pre-S2 tree); F-S2j remote receipt +
 * cross-account rejection; plus the replayed-inbound no-second-obligation case.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync, chmodSync, symlinkSync, renameSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { createHash, randomUUID } from "node:crypto";
import { signEnvelope, verifyEnvelope, type Envelope, type ChainEntry } from "@tpsdev-ai/agent";

import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const FLINT_SEED = Buffer.alloc(32, 0x01); // the sender
const ANVIL_SEED = Buffer.alloc(32, 0x02); // the agent (signs the reply)

function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

// Import the plugin — default export gives us { register }.
import pluginModule, { awaitStartupCurSweepForTests, obligationStateForTests, setArmDeadlineFaultForTests, setObligationCurLookupFaultForTests, setObligationRetryDelaysForTests, setObligationRetryFaultForTests, setBeforeArmReadForTests, setBeforeSettleReadForTests, setBeforeRetryCapReadForTests, setBeforeSettleEntryForTests, setBeforeReceiptScanForTests, setQuarantineOutcomeForTests, setObligationTimerCapForTests, setObligationNowForTests, releaseObligationRetryForTests } from "../src/index.js";
import { createObligation, transitionObligation, setBeforeTransitionForTests, sweepTerminalObligations, writeReceipt, readObligation, readObligationResult, writeObligation, listObligations } from "../src/obligations.js";

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

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * Every nack mail under `dir` whose `X-TPS-Nack` reason is `reason` (cli#389
 * round 9, item 2: the verb sends exactly one per transition to `failed`).
 */
function nackMailsIn(dir: string, reason?: string): any[] {
  return readdirSafe(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try { return JSON.parse(readFileSync(resolve(dir, f), "utf-8")); } catch { return null; }
    })
    .filter((r) => typeof r?.headers?.["X-TPS-Nack"] === "string" && (reason === undefined || r.headers["X-TPS-Nack"] === reason));
}

async function pollUntil(pred: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

describe("openclaw-tps-mail: reply OBLIGATION (slice S2)", () => {
  let tempMailDir: string;
  let tempKeysDir: string;
  let tempHome: string;
  let abortController: AbortController;
  let origHome: string | undefined;
  let origKeysDir: string | undefined;
  let origDeadline: string | undefined;

  beforeEach(() => {
    tempMailDir = mkdtempSync(join(tmpdir(), "tps-oblig-mail-"));
    tempKeysDir = mkdtempSync(join(tmpdir(), "tps-oblig-keys-"));
    tempHome = mkdtempSync(join(tmpdir(), "tps-oblig-home-"));
    abortController = new AbortController();

    writeFileSync(join(tempKeysDir, "anvil.key"), ANVIL_SEED);
    writeFileSync(join(tempKeysDir, "flint.key"), FLINT_SEED);
    origKeysDir = process.env.TPS_TEST_KEYS_DIR;
    process.env.TPS_TEST_KEYS_DIR = tempKeysDir;

    origHome = process.env.HOME;
    process.env.HOME = tempHome;

    origDeadline = process.env.TPS_OBLIGATION_DEADLINE_MS;
  });

  afterEach(() => {
    abortController.abort();
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origKeysDir === undefined) delete process.env.TPS_TEST_KEYS_DIR; else process.env.TPS_TEST_KEYS_DIR = origKeysDir;
    if (origDeadline === undefined) delete process.env.TPS_OBLIGATION_DEADLINE_MS; else process.env.TPS_OBLIGATION_DEADLINE_MS = origDeadline;
    for (const d of [tempMailDir, tempKeysDir, tempHome]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function curFiles(agent: string): string[] {
    return readdirSafe(resolve(tempMailDir, agent, "cur")).filter((f) => f.endsWith(".json"));
  }
  function newFiles(agent: string): string[] {
    return readdirSafe(resolve(tempMailDir, agent, "new")).filter((f) => f.endsWith(".json"));
  }
  function obligationFile(agent: string, inboundId: string): any | null {
    try {
      return JSON.parse(readFileSync(resolve(tempMailDir, agent, ".obligations", `${inboundId}.json`), "utf-8"));
    } catch { return null; }
  }
  function obligationCount(agent: string): number {
    return readdirSafe(resolve(tempMailDir, agent, ".obligations")).filter((f) => f.endsWith(".json")).length;
  }
  function curRecord(agent: string): any | null {
    const files = curFiles(agent);
    if (files.length === 0) return null;
    try { return JSON.parse(readFileSync(resolve(tempMailDir, agent, "cur", files[0]!), "utf-8")); } catch { return null; }
  }
  function curRecordById(agent: string, inboundId: string): any | null {
    for (const f of curFiles(agent)) {
      try {
        const rec = JSON.parse(readFileSync(resolve(tempMailDir, agent, "cur", f), "utf-8"));
        if (rec?.id === inboundId) return rec;
      } catch { /* skip */ }
    }
    return null;
  }
  function outboxFiles(kind: "new" | "sent"): string[] {
    return readdirSafe(resolve(tempHome, ".tps", "outbox", kind)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  }

  /**
   * Start the plugin for one inbound. The dispatch is held open until the test
   * calls `settle()`, so ordering is controllable. `deliver` drives the final.
   */
  async function start(
    agentId: string,
    sender: string,
    opts: {
      beforeVerify?: (name: string) => Promise<void>;
      localSender?: boolean;
      branchHost?: boolean;
      bodyFrom?: string;
      bodySeed?: Buffer;
      signAgentKey?: boolean;
      noInbound?: boolean;
      /** With noInbound: a cur/ file left in its raw form (not rewritten to the promoted shape). */
      keepRawCur?: string;
      accounts?: Record<string, { mailDir: string }>;
      /** Account this start runs for (default: "default"). */
      accountId?: string;
      /** Maildir this account watches (default: the test's tempMailDir). */
      mailDir?: string;
      /** Bindings for this account (default: one for `agentId` on `accountId`). */
      bindings?: any[];
      dispatchFailedCounts?: any;
      warnCalls?: string[];
      infoCalls?: string[];
      /** Make the runtime's inbound-context finalizer throw, so a startup intake
       *  rejects after promotion. */
      finalizeContextThrows?: boolean;
    } = {},
  ) {
    if (abortController.signal.aborted) abortController = new AbortController();
    const accountAbort = abortController;
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
          await opts.beforeVerify?.(name);
          if (name === sender) return { publicKey: pubkeyFromSeed(FLINT_SEED) };
          if (name === agentId) return { publicKey: pubkeyFromSeed(ANVIL_SEED) };
          return null;
        },
      }),
    }));

    if (opts.signAgentKey === false) {
      try { rmSync(join(tempKeysDir, `${agentId}.key`), { force: true }); } catch { /* */ }
    }

    const accountId = opts.accountId ?? "default";
    const mailDir = opts.mailDir ?? tempMailDir;
    if (opts.localSender) mkdirSync(resolve(mailDir, sender, "new"), { recursive: true });
    // cli#389: host TYPE decides locality (a branch relays non-bound recipients).
    if (opts.branchHost) {
      mkdirSync(resolve(tempHome, ".tps", "identity"), { recursive: true });
      writeFileSync(resolve(tempHome, ".tps", "identity", "host.json"), "{}\n", "utf-8");
    }
    const newDir = resolve(mailDir, agentId, "new");
    mkdirSync(newDir, { recursive: true });

    const bodyFrom = opts.bodyFrom ?? sender;
    const seed = opts.bodySeed ?? FLINT_SEED;
    const signedBody = buildSignedBody(bodyFrom, agentId, "inbound payload", seed);
    const inboundId = `msg-${Math.random().toString(36).slice(2, 10)}`;
    const inbound = {
      id: inboundId,
      from: sender,
      to: agentId,
      body: signedBody,
      timestamp: new Date().toISOString(),
      headers: { "X-TPS-Trust": "agent", "X-TPS-Surface": "tps-mail" },
      deliveryAttempts: 0,
    };
    if (!opts.noInbound) {
      writeFileSync(resolve(newDir, `2026-05-26T00-00-00-${inboundId}.json`), JSON.stringify(inbound, null, 2), "utf-8");
    }

    let dispatchedArgs: any = null;
    let settleFn: (() => void) | null = null;
    let dispatchCount = 0;

    const channelRuntime = {
      routing: { buildAgentSessionKey: (params: any) => `agent:${params.agentId}:tps-mail:default:${params.peer.id}` },
      reply: {
        finalizeInboundContext: async (ctx: any) => {
          if (opts.finalizeContextThrows) throw new Error("context finalizer refused the inbound");
          return { ...ctx, CommandAuthorized: false };
        },
        dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
          dispatchCount++;
          dispatchedArgs = args;
          await new Promise<void>((res) => { settleFn = res; });
          return { failedCounts: opts.dispatchFailedCounts ?? 0 };
        },
      },
    };

    const cfg = {
      channels: { "tps-mail": { accounts: opts.accounts ?? { [accountId]: { mailDir, enabled: true } } } },
      bindings: opts.bindings ?? [{ agentId, match: { channel: "tps-mail", accountId } }],
    };
    const warnCalls = opts.warnCalls ?? [];
    const infoCalls = opts.infoCalls ?? [];
    const ctx = {
      account: { accountId, mailDir, enabled: true },
      cfg,
      log: { info: (...a: any[]) => infoCalls.push(a.map(String).join(" ")), warn: (...a: any[]) => warnCalls.push(a.map(String).join(" ")), error: () => {} },
      channelRuntime,
      abortSignal: accountAbort.signal,
    };

    if (opts.noInbound) {
      for (const file of readdirSafe(resolve(mailDir, agentId, "cur"))) {
        if (file === opts.keepRawCur) continue;
        const path = resolve(mailDir, agentId, "cur", file);
        const record = JSON.parse(readFileSync(path, "utf8"));
        if (record.envelope) {
          mailboxReplayStore(resolve(mailDir, agentId)).recordConsumed(record.envelope.messageId);
          continue;
        }
        const envelope = JSON.parse(record.body);
        writeFileSync(path, JSON.stringify({ ...record, body: envelope.body, timestamp: envelope.timestamp,
          envelopeId: envelope.messageId, envelope, replyToId: envelope.replyToId }));
        mailboxReplayStore(resolve(mailDir, agentId)).recordConsumed(envelope.messageId);
      }
    }
    const startPromise = capturedPlugin.gateway.startAccount(ctx);
    await pollUntil(() => dispatchedArgs !== null || readdirSafe(resolve(mailDir, agentId, "cur")).length > 0 || existsSync(resolve(mailDir, agentId, "dlq")), 4000);

    return {
      inboundId,
      /** cli#429: the inbound's SIGNED envelope messageId — the thread a reply/nack signs. */
      inboundEnvelopeId: JSON.parse(signedBody).messageId as string,
      warned: warnCalls,
      startPromise,
      get dispatched() { return dispatchedArgs; },
      get dispatchCount() { return dispatchCount; },
      obligationId: (): string | null => dispatchedArgs?.replyOptions?.runId ?? obligationFile(agentId, inboundId)?.obligationId ?? null,
      deliver: (text: string, kind = "final") => dispatchedArgs!.dispatcherOptions.deliver({ text }, { kind }),
      // cli#400: the runtime suppresses an empty/silent final BEFORE `deliver`
      // (onSkip); this drives that path.
      skip: (reason = "empty") => dispatchedArgs!.dispatcherOptions.onSkip?.({ text: "" }, { kind: "final", reason }),
      settle: () => settleFn?.(),
      stop: async () => { accountAbort.abort(); try { await startPromise; } catch { /* aborted */ } },
    };
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ── F-S2a ──────────────────────────────────────────────────────────────────
  it("F-S2a: happy path — one reply with the marker; ackedAt is stamped AFTER the file exists", async () => {
    const h = await start("anvil", "flint", { localSender: true });
    expect(h.dispatched).not.toBeNull();

    // The ack cannot precede the receipt: before the final is posted, no ack.
    expect(curRecord("anvil")?.ackedAt).toBeUndefined();

    await h.deliver("the final answer", "final");
    const flintNew = resolve(tempMailDir, "flint", "new");
    const replies = () => readdirSafe(flintNew).filter((f) => f.endsWith(".json"));
    // cli#400: `deliver` only REMEMBERS the final; nothing is posted yet.
    expect(replies().length).toBe(0);

    // Still unacked until the dispatch settles, posts, and the scan runs.
    expect(curRecord("anvil")?.ackedAt).toBeUndefined();

    h.settle();
    const posted = await pollUntil(() => replies().length === 1, 2000);
    expect(posted).toBe(true); // exactly one post
    const acked = await pollUntil(() => !!curRecord("anvil")?.ackedAt, 2000);
    expect(acked).toBe(true);

    const reply = JSON.parse(readFileSync(resolve(flintNew, replies()[0]!), "utf-8"));
    expect(reply.headers["X-TPS-Obligation"]).toBe(h.obligationId());
    expect(reply.accountId).toBe("default");
    const ob = obligationFile("anvil", h.inboundId);
    expect(ob?.state).toBe("acked");

    // Ordering, explicitly: the receipt file existed before ackedAt was written.
    const ackedAtMs = Date.parse(curRecord("anvil").ackedAt);
    const replyMtime = statSync(resolve(flintNew, replies()[0]!)).mtimeMs;
    expect(ackedAtMs).toBeGreaterThanOrEqual(replyMtime - 2000); // same-window ordering, not a future stamp
    expect(replies().length).toBe(1);

    await h.stop();
  }, 15000);

  // ── F-S2b ──────────────────────────────────────────────────────────────────
  it("F-S2b: an empty final text is FAILED by name, nacked, never acked", async () => {
    const h = await start("anvil", "flint", { localSender: true });
    // cli#400: OpenClaw suppresses an empty final BEFORE `deliver` (onSkip), so
    // the plugin observes the skip, not an empty deliver payload.
    h.skip("empty");
    h.settle();

    await pollUntil(() => !!curRecord("anvil")?.nackedAt, 2000);
    const cur = curRecord("anvil");
    expect(cur?.ackedAt).toBeUndefined();
    expect(cur?.nackedAt).toBeDefined();
    expect(cur?.nackReason).toContain("empty-final-text");
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("failed");
    // cli#389 round 9, item 2: the VERB owns the nack mail, so a pre-call failure
    // (nothing was sent) announces the sender from the same place every other
    // failed transition does — exactly ONE mail, naming this reason.
    const flintNew = resolve(tempMailDir, "flint", "new");
    const nacked = await pollUntil(
      () => nackMailsIn(flintNew, "empty-final-text").length === 1,
      2000,
    );
    expect(nacked, "exactly one nack mail from the verb").toBe(true);
    expect(readdirSafe(flintNew).filter((f) => f.endsWith(".json")).length, "and nothing else was written").toBe(1);

    // cli#429: the nack is SIGNED and threads on the inbound's SIGNED envelope
    // id, inside the signature; the inbound's record id is bookkeeping only.
    const nack = nackMailsIn(flintNew, "empty-final-text")[0];
    expect(nack.replyToId).toBe(h.inboundEnvelopeId);
    expect(nack.headers["X-TPS-InReplyTo"]).toBe(h.inboundId);
    const env: Envelope = JSON.parse(nack.body);
    expect(env.replyToId).toBe(h.inboundEnvelopeId);
    const anvilKeys = { async getAgent(n: string) { return n === "anvil" ? { publicKey: pubkeyFromSeed(ANVIL_SEED) } : null; } };
    expect(await verifyEnvelope(env, anvilKeys)).toEqual({ ok: true });
    expect((await verifyEnvelope({ ...env, replyToId: "changed-thread" }, anvilKeys)).ok).toBe(false);

    await h.stop();
  }, 15000);

  // ── F-S2c ──────────────────────────────────────────────────────────────────
  it("F-S2c: a missing signing key is FAILED by name, never acked — and NOTHING unsigned is sent, not even the nack", async () => {
    const h = await start("anvil", "flint", { localSender: true, signAgentKey: false });
    await h.deliver("final answer", "final");
    h.settle();

    await pollUntil(() => !!curRecord("anvil")?.nackedAt, 2000);
    const cur = curRecord("anvil");
    expect(cur?.ackedAt).toBeUndefined();
    expect(cur?.nackReason).toContain("missing-signing-key");
    const ob = obligationFile("anvil", h.inboundId);
    expect(ob?.state).toBe("failed");
    // cli#429: the nack path NEVER falls back to an unsigned raw body. The nack
    // cannot be signed either, so it is NOT sent: the refusal is logged by name
    // and the record keeps the debt (nackPending) for a later start to retry.
    await pollUntil(() => h.warned.some((w) => w.includes("nack-unsigned-refused")), 2000);
    expect(h.warned.some((w) => w.includes("nack-unsigned-refused")), "the refusal is logged by name").toBe(true);
    const flintNew = resolve(tempMailDir, "flint", "new");
    expect(readdirSafe(flintNew).filter((f) => f.endsWith(".json")).length, "no reply and no nack was written").toBe(0);
    expect(obligationFile("anvil", h.inboundId)?.nackPending, "the nack is still owed").toBe(true);

    await h.stop();
  }, 15000);

  // ── F-S2c2 (cli#429) ───────────────────────────────────────────────────────
  it("F-S2c2: a MALFORMED signing key is FAILED by name (never a throw, never an unsigned mail), naming the key path", async () => {
    const keyPath = join(tempKeysDir, "anvil.key");
    const h = await start("anvil", "flint", { localSender: true });
    // Corrupt the key AFTER inbound promotion: the reply signer must refuse by
    // name rather than throw out of the dispatch or fall back to a raw body.
    writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nnot base64 at all\n-----END PRIVATE KEY-----\n");
    await h.deliver("final answer", "final");
    h.settle();

    await pollUntil(() => !!curRecord("anvil")?.nackedAt, 2000);
    expect(curRecord("anvil")?.ackedAt).toBeUndefined();
    expect(curRecord("anvil")?.nackReason).toContain("unusable-signing-key");
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("failed");
    await pollUntil(() => h.warned.some((w) => w.includes("nack-unsigned-refused")), 2000);
    expect(h.warned.some((w) => w.includes(keyPath)), "the log names the key path").toBe(true);
    expect(readdirSafe(resolve(tempMailDir, "flint", "new")).filter((f) => f.endsWith(".json")).length).toBe(0);

    await h.stop();
  }, 15000);

  // ── F-S2e ──────────────────────────────────────────────────────────────────
  it("F-S2e: crash after post before ack — recovery stamps ackedAt, no second post", async () => {
    // cli#400: the post now happens AFTER the dispatch resolves, so the
    // crash window is "posted, then the ack did not run". Drive a normal
    // post+ack, then reconstruct that exact durable state (drop ackedAt, move
    // the obligation back to "posted") and prove recovery re-acks without a
    // second post.
    const h = await start("anvil", "flint", { localSender: true });
    await h.deliver("final answer", "final");
    h.settle();
    await pollUntil(() => !!curRecord("anvil")?.ackedAt, 3000);
    await h.stop();

    const flintNew = resolve(tempMailDir, "flint", "new");
    expect(readdirSafe(flintNew).filter((f) => f.endsWith(".json")).length).toBe(1);

    const curFilePath = resolve(tempMailDir, "anvil", "cur", curFiles("anvil")[0]!);
    const cur = JSON.parse(readFileSync(curFilePath, "utf-8"));
    delete cur.ackedAt;
    writeFileSync(curFilePath, JSON.stringify(cur, null, 2), "utf-8");
    const ob = obligationFile("anvil", h.inboundId);
    writeFileSync(
      resolve(tempMailDir, "anvil", ".obligations", `${h.inboundId}.json`),
      JSON.stringify({ ...ob, state: "posted" }, null, 2),
      "utf-8",
    );
    expect(curRecord("anvil")?.ackedAt).toBeUndefined();

    // RESTART: a fresh account recovers from the maildir/outbox.
    const h2 = await start("anvil", "flint", { localSender: true, noInbound: true });
    const acked = await pollUntil(() => !!curRecord("anvil")?.ackedAt, 3000);
    expect(acked).toBe(true);
    expect(readdirSafe(flintNew).filter((f) => f.endsWith(".json")).length).toBe(1); // NO second post
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("acked");
    await h2.stop();
  }, 20000);

  // ── cli#617 slice (b) ──────────────────────────────────────────────────────
  it("cli#617: a raw cur/ record with a synthetic in_progress intent is not settled on restart", async () => {
    const h = await start("anvil", "flint", { localSender: true });
    await h.deliver("final answer", "final");
    h.settle();
    await pollUntil(() => !!curRecord("anvil")?.ackedAt, 3000);
    await h.stop();

    const file = curFiles("anvil")[0]!;
    const curFilePath = resolve(tempMailDir, "anvil", "cur", file);
    const cur = JSON.parse(readFileSync(curFilePath, "utf-8"));
    writeFileSync(curFilePath, JSON.stringify({
      id: cur.id, from: cur.from, to: cur.to, body: JSON.stringify(cur.envelope), timestamp: cur.timestamp, read: false,
    }, null, 2), "utf-8");
    const mailboxRoot = resolve(tempMailDir, "anvil");
    mailboxReplayStore(mailboxRoot).beginPlacement(cur.envelope.messageId, file, curFilePath);
    const intentPath = join(mailboxRoot, `.placement-${createHash("sha256").update(file).digest("hex")}.json`);
    writeFileSync(intentPath, JSON.stringify({
      ...JSON.parse(readFileSync(intentPath, "utf-8")), version: 1, phase: "in_progress", presentations: 1,
      firstPresentedAt: new Date().toISOString(), claim: { token: randomUUID(), pid: process.pid, start: null, moduleNonce: randomUUID() },
    }));
    const ob = obligationFile("anvil", h.inboundId);
    writeFileSync(
      resolve(tempMailDir, "anvil", ".obligations", `${h.inboundId}.json`),
      JSON.stringify({ ...ob, state: "posted" }, null, 2),
      "utf-8",
    );
    const before = readFileSync(curFilePath, "utf-8");

    const h2 = await start("anvil", "flint", { localSender: true, noInbound: true, keepRawCur: file });
    await sleep(1500);
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("posted"); // not settled
    expect(readFileSync(curFilePath, "utf-8")).toBe(before); // not stamped
    await h2.stop();
  }, 20000);

  it("cli#617: plugin startup and reconciliation leave a real active MailClient delivery untouched", async () => {
    const agent = "anvil";
    const inboundId = "real-delivery";
    const body = buildSignedBody("flint", agent, "active delivery", FLINT_SEED);
    const envelope = JSON.parse(body);
    const root = resolve(tempMailDir, agent);
    const filename = `${inboundId}.json`;
    mkdirSync(join(root, "new"), { recursive: true });
    writeFileSync(join(root, "new", filename), JSON.stringify({
      id: inboundId, from: "flint", to: agent, body, timestamp: envelope.timestamp, read: false,
    }));
    const client = new MailClient(tempMailDir, undefined, agent, {
      async getAgent(name: string) {
        return name === "flint" ? { publicKey: pubkeyFromSeed(FLINT_SEED) } : null;
      },
    });
    const result = await client.deliverNext();
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error(JSON.stringify(result));
    const curPath = join(root, "cur", filename);
    const before = readFileSync(curPath, "utf8");
    expect(JSON.parse(before).envelope).toBeUndefined();
    expect(mailboxReplayStore(root).placementPhase(filename)).toBe("in_progress");
    createObligation(tempMailDir, agent, () => ({
      obligationId: randomUUID(), inboundId, inboundEnvelopeId: envelope.messageId,
      inboundTimestamp: envelope.timestamp, from: "flint", to: agent, accountId: "default",
      state: "posted", deadlineAt: null, attempts: 1,
    }));
    const obligationBefore = obligationFile(agent, inboundId);
    const warnings: string[] = [];
    let verifications = 0;
    const h = await start(agent, "flint", {
      noInbound: true, keepRawCur: filename, warnCalls: warnings,
      beforeVerify: async () => { verifications++; },
    });
    try {
      expect(await pollUntil(() => warnings.some((w) => w.includes(`cur/ recovery refused ${inboundId} (busy)`)))).toBe(true);
      await sleep(100);
      expect(h.dispatchCount).toBe(0);
      expect(verifications).toBe(0);
      expect(readFileSync(curPath, "utf8")).toBe(before);
      expect(obligationFile(agent, inboundId)).toEqual(obligationBefore);
      expect(readdirSafe(join(root, "dlq"))).toEqual([]);
      expect(await client.deliverNext()).toMatchObject({ status: "deferred", reason: "active" });
    } finally {
      await h.stop();
      expect(client.releaseDelivery(result.delivery)).toEqual({ status: "released" });
    }
  });

  for (const intentTiming of ["before verification", "during verification", "absent"] as const) {
    it(`cli#617: raw reconciliation with a synthetic intent ${intentTiming}`, async () => {
      const agent = "anvil";
      const inboundId = "raw-guard";
      const filename = `${inboundId}.json`;
      const root = resolve(tempMailDir, agent);
      const curPath = join(root, "cur", filename);
      const body = buildSignedBody("flint", agent, "raw guard", FLINT_SEED);
      const envelope = JSON.parse(body);
      mkdirSync(join(root, "cur"), { recursive: true });
      writeFileSync(curPath, JSON.stringify({
        id: inboundId, from: "flint", to: agent, body, timestamp: envelope.timestamp,
        read: true, ackedAt: envelope.timestamp,
      }));
      createObligation(tempMailDir, agent, () => ({
        obligationId: randomUUID(), inboundId, inboundEnvelopeId: envelope.messageId,
        inboundTimestamp: envelope.timestamp, from: "flint", to: agent, accountId: "default",
        state: "posted", deadlineAt: null, attempts: 1,
      }));
      const before = readFileSync(curPath, "utf8");
      const obligationBefore = obligationFile(agent, inboundId);
      const place = () => mailboxReplayStore(root).beginPlacement(envelope.messageId, filename, curPath);
      if (intentTiming === "before verification") place();
      let verifications = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const h = await start(agent, "flint", {
        noInbound: true, keepRawCur: filename,
        beforeVerify: async () => { verifications++; await gate; },
      });
      try {
        if (intentTiming !== "before verification") {
          expect(await pollUntil(() => verifications > 0)).toBe(true);
          if (intentTiming === "during verification") place();
        }
        release();
        if (intentTiming === "absent") {
          expect(await pollUntil(() => obligationFile(agent, inboundId)?.deadlineAt !== null)).toBe(true);
        } else {
          await sleep(100);
          expect(obligationFile(agent, inboundId)).toEqual(obligationBefore);
        }
        if (intentTiming === "before verification") expect(verifications).toBe(0);
        expect(h.dispatchCount).toBe(0);
        expect(readFileSync(curPath, "utf8")).toBe(before);
        expect(readdirSafe(join(root, "dlq"))).toEqual([]);
      } finally {
        release();
        await h.stop();
      }
    });
  }

  // ── F-S2f ──────────────────────────────────────────────────────────────────
  it("F-S2f: crash with an armed deadline before the post — re-armed from deadlineAt (not a fresh window)", async () => {
    // A long default window, so a FRESH arm would never fire in this test.
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const agentId = "anvil";
    const inboundId = "msg-crash-f";
    // The durable state a crash leaves: the run yielded, the deadline was armed,
    // and no final was posted. The cur/ record exists, unacked.
    mkdirSync(resolve(tempMailDir, agentId, "cur"), { recursive: true });
    mkdirSync(resolve(tempMailDir, agentId, ".obligations"), { recursive: true });
    writeFileSync(
      resolve(tempMailDir, agentId, "cur", `2026-05-26T00-00-00-${inboundId}.json`),
      JSON.stringify({ id: inboundId, from: "flint", to: agentId, body: buildSignedBody("flint", agentId, "x", FLINT_SEED), timestamp: new Date().toISOString(), read: false }, null, 2),
      "utf-8",
    );
    const deadlineAt = new Date(Date.now() + 300).toISOString(); // short — only a RE-ARM from it fires soon
    writeFileSync(
      resolve(tempMailDir, agentId, ".obligations", `${inboundId}.json`),
      JSON.stringify({ obligationId: "ob-f", inboundId, inboundTimestamp: new Date().toISOString(), from: "flint", to: agentId, accountId: "default", state: "yielded", deadlineAt, attempts: 1 }, null, 2),
      "utf-8",
    );

    const h = await start(agentId, "flint", { localSender: true, noInbound: true });
    // The recovery re-arms from deadlineAt (300 ms), NOT now+600000 ms.
    const failed = await pollUntil(() => obligationFile(agentId, inboundId)?.state === "failed", 4000);
    expect(failed).toBe(true);
    expect(obligationFile(agentId, inboundId)?.failure).toBe("yielded-without-resumption");
    expect(readFileSync(resolve(tempMailDir, agentId, ".obligations", `${inboundId}.json`), "utf-8")).toContain(deadlineAt); // deadlineAt unchanged
    await h.stop();
  }, 20000);

  // ── F-S2g ──────────────────────────────────────────────────────────────────
  it("F-S2g: a yielded run stays unacked, then FAILS by name at the deadline with a nack mail", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "400";
    const h = await start("anvil", "flint", { localSender: true });
    const obId = h.obligationId();
    expect(obId).not.toBeNull();

    // The run's lifecycle end event carries yielded: true (subscription path).
    capturedSubscription.handle({ runId: obId, seq: 1, stream: "lifecycle", ts: Date.now(), data: { yielded: true }, sessionKey: "s" });
    h.settle(); // the dispatch settles with no posted final

    await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "yielded", 2000);
    expect(curRecord("anvil")?.ackedAt).toBeUndefined();
    expect(curRecord("anvil")?.nackedAt).toBeUndefined();
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("yielded");
    expect(obligationFile("anvil", h.inboundId)?.deadlineAt).toBeTruthy();

    // A session transcript exists for the nack to name.
    const sessions = resolve(tempHome, ".openclaw", "agents", "anvil", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(resolve(sessions, "turn.jsonl"), "{}", "utf-8");

    const failed = await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "failed", 4000);
    expect(failed).toBe(true);
    expect(obligationFile("anvil", h.inboundId)?.failure).toBe("yielded-without-resumption");
    expect(curRecord("anvil")?.nackedAt).toBeDefined();
    expect(curRecord("anvil")?.ackedAt).toBeUndefined();

    // The nack mail reaches the sender, naming the reason and the transcript.
    const flintNew = resolve(tempMailDir, "flint", "new");
    const nacked = await pollUntil(
      () => readdirSafe(flintNew).some((f) => {
        if (!f.endsWith(".json")) return false;
        try { return JSON.parse(readFileSync(resolve(flintNew, f), "utf-8")).headers?.["X-TPS-Nack"] === "yielded-without-resumption"; } catch { return false; }
      }),
      3000,
    );
    expect(nacked).toBe(true);
    const nack = JSON.parse(readFileSync(resolve(flintNew, readdirSafe(flintNew).find((f) => f.endsWith(".json"))!), "utf-8"));
    expect(nack.body).toContain("yielded-without-resumption");
    expect(nack.body).toContain("turn.jsonl");

    await h.stop();
  }, 20000);

  // ── F-S2h ──────────────────────────────────────────────────────────────────
  it("F-S2h: two accounts resolving to one mailDir — startAccount refuses by name", async () => {
    const warned: string[] = [];
    const h = await start("anvil", "flint", {
      localSender: true,
      noInbound: true,
      warnCalls: warned,
      accounts: { default: { mailDir: tempMailDir }, dup: { mailDir: tempMailDir } },
    });
    expect(h.dispatched).toBeNull();
    expect(h.dispatchCount).toBe(0);
    expect(warned.join("\n")).toContain("same mail directory");
    expect(warned.join("\n")).toContain("refusing account default");
    await h.stop();
  }, 15000);

  // ── F-S2i ──────────────────────────────────────────────────────────────────
  it("F-S2i: a yielded run is NOT acked at settlement (the pre-S2 regression)", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const h = await start("anvil", "flint", { localSender: true });
    // No final delivered (the turn yielded); then the dispatch settles.
    h.settle();
    await sleep(150);

    // The whole point: settlement is NOT success.
    expect(curRecord("anvil")?.ackedAt).toBeUndefined();
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("yielded");
    await h.stop();
  }, 15000);

  // ── F-S2j ──────────────────────────────────────────────────────────────────
  it("F-S2j: a remote recipient's marker is found in the outbox; a cross-account match is rejected", async () => {
    // (a) remote happy path: the reply lands in the outbox and the ack proceeds.
    const h = await start("anvil", "flint", { localSender: false, branchHost: true });
    await h.deliver("final to a remote peer", "final");
    h.settle();
    const posted = await pollUntil(() => outboxFiles("new").length === 1, 2000);
    expect(posted).toBe(true);
    const acked = await pollUntil(() => !!curRecord("anvil")?.ackedAt, 3000);
    expect(acked).toBe(true);
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("acked");
    await h.stop();

    // (b) cross-account: the ONLY marker-matching file carries a different
    //     accountId, so the scan must NOT ack.
    const h2 = await start("anvil", "flint", { localSender: false, branchHost: true });
    await pollUntil(() => h2.obligationId() !== null, 3000); // wait for THIS inbound's dispatch
    const obId = h2.obligationId();
    expect(obId).not.toBeNull();
    const outboxNew = resolve(tempHome, ".tps", "outbox", "new");
    mkdirSync(outboxNew, { recursive: true });
    writeFileSync(
      resolve(outboxNew, `2026-05-26T00-00-09-cross.json`),
      JSON.stringify({
        id: "cross",
        to: "flint",
        from: "anvil",
        accountId: "some-other-account",
        body: buildSignedBody("anvil", "flint", "wrong account", ANVIL_SEED),
        timestamp: new Date().toISOString(),
        headers: { "X-TPS-Obligation": obId },
      }, null, 2),
      "utf-8",
    );
    h2.settle(); // no deliver: the only marker file is the wrong-account one
    await sleep(150);
    expect(curRecordById("anvil", h2.inboundId)?.ackedAt).toBeUndefined();
    expect(obligationFile("anvil", h2.inboundId)?.state).not.toBe("acked");
    await h2.stop();
  }, 20000);

  // ── replayed inbound ───────────────────────────────────────────────────────
  it("a replayed inbound opens NO second obligation and posts NO second final", async () => {
    const h = await start("anvil", "flint", { localSender: true });
    await h.deliver("final answer", "final");
    h.settle();
    await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "acked", 2000);
    await h.stop();
    expect(obligationCount("anvil")).toBe(1);

    // Re-drive the SAME inbound id through a fresh account: the cur/ recovery
    // sweep reaches deliverPromoted, which must find the existing obligation
    // (terminal → reconciled, no re-dispatch) rather than open a second.
    const h2 = await start("anvil", "flint", { localSender: true, noInbound: true });
    await sleep(200);
    expect(obligationCount("anvil")).toBe(1);
    expect(h2.dispatchCount).toBe(0);
    expect(readdirSafe(resolve(tempMailDir, "flint", "new")).filter((f) => f.endsWith(".json")).length).toBe(1);
    await h2.stop();
  }, 20000);

  // ── round 8: the commit is a PERSISTED state of the obligation record ──────

/**
 * cli#389 round 8. `committed` used to live in the TURN's context — memory only
 * — so a restart, the deadline path and the outer catch each saw a different
 * truth: in one process the deadline still mailed a nack for a reply that had
 * been delivered, and after a restart the same obligation failed and nacked.
 * The commit is now a PERSISTED state of the obligation record — `delivering`
 * before the delivery call, `posted` when it returns — and every disposition
 * reads the RECORD.
 *
 * Each test below seeds the durable state a crash leaves (a record mid-delivery,
 * a record whose delivery returned) and then RESTARTS the account: recovery
 * re-arms the deadline from the record, and the deadline resolves the obligation
 * to the terminal `unconfirmed` — no failed state, no nack stamp, no nack mail
 * (non-delivery cannot be proven, so the sender is never told it failed). An
 * implementation that reads an in-memory flag instead of the record cannot pass
 * these: after a restart there is no flag to read.
 */
describe("cli#389 round 8 — the commit is a persisted state of the obligation record", () => {
  const R8_OBLIGATION = "ob-round8";

  /** The durable state a crash leaves, plus the unacked cur/ record beside it. */
  function seedCommitted(
    agentId: string,
    inboundId: string,
    state: "delivering" | "posted",
    replyId: string | null,
    deadlineInMs: number,
  ): void {
    mkdirSync(resolve(tempMailDir, agentId, "cur"), { recursive: true });
    mkdirSync(resolve(tempMailDir, agentId, ".obligations"), { recursive: true });
    writeFileSync(
      resolve(tempMailDir, agentId, "cur", `2026-05-26T00-00-00-${inboundId}.json`),
      JSON.stringify(
        { id: inboundId, from: "flint", to: agentId, body: buildSignedBody("flint", agentId, "x", FLINT_SEED), timestamp: new Date().toISOString(), read: false },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      resolve(tempMailDir, agentId, ".obligations", `${inboundId}.json`),
      JSON.stringify(
        {
          obligationId: R8_OBLIGATION,
          inboundId,
          inboundTimestamp: new Date().toISOString(),
          from: "flint",
          to: agentId,
          accountId: "default",
          state,
          deadlineAt: new Date(Date.now() + deadlineInMs).toISOString(),
          attempts: 1,
          ...(replyId ? { replyId } : {}),
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  /** Every nack mail the sender has received. */
  function nackMails(sender: string): any[] {
    const dir = resolve(tempMailDir, sender, "new");
    return readdirSafe(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(resolve(dir, f), "utf-8"));
        } catch {
          return null;
        }
      })
      .filter((r) => typeof r?.headers?.["X-TPS-Nack"] === "string");
  }

  it("R8-a: a restart with the record in `delivering` (the call in flight) → the deadline resolves it `unconfirmed`, no nack stamp, no nack mail", async () => {
    const agentId = "anvil";
    const inboundId = "msg-r8-delivering";
    seedCommitted(agentId, inboundId, "delivering", null, 250);
    const h = await start(agentId, "flint", { localSender: true, noInbound: true });

    const unconfirmed = await pollUntil(() => obligationFile(agentId, inboundId)?.state === "unconfirmed", 4000);
    expect(unconfirmed, "the deadline resolved it").toBe(true);
    expect(obligationFile(agentId, inboundId)?.failure).toBe("yielded-without-resumption");
    expect(curRecordById(agentId, inboundId)?.nackedAt, "no nack stamp").toBeUndefined();
    expect(curRecordById(agentId, inboundId)?.ackedAt, "and it was never acked either").toBeUndefined();
    expect(nackMails("flint").length, "no nack mail for a committed reply").toBe(0);
    await h.stop();
  }, 20000);

  it("R8-b: the same for `posted` (the delivery returned before the crash)", async () => {
    const agentId = "anvil";
    const inboundId = "msg-r8-posted";
    seedCommitted(agentId, inboundId, "posted", "reply-r8-b", 250);
    const h = await start(agentId, "flint", { localSender: true, noInbound: true });

    const unconfirmed = await pollUntil(() => obligationFile(agentId, inboundId)?.state === "unconfirmed", 4000);
    expect(unconfirmed, "the deadline resolved it").toBe(true);
    expect(curRecordById(agentId, inboundId)?.nackedAt, "no nack stamp").toBeUndefined();
    expect(nackMails("flint").length, "no nack mail for a committed reply").toBe(0);
    await h.stop();
  }, 20000);

  it("R8-c: an IN-PROCESS deadline on a committed obligation sends NO nack mail — it resolves `unconfirmed`", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "350";
    const h = await start("anvil", "flint", { localSender: true });
    const flintNew = resolve(tempMailDir, "flint", "new");
    // The reply lands (creating a file only needs write+execute on the dir) but
    // the receipt cannot be LISTED, so the delivery commits and the evidence
    // stays unreadable. cli#429 round 7: a local reply also persists a metadata
    // receipt, so that one is made unwritable too — `receipts` is a FILE — or
    // this obligation would have evidence after all.
    mkdirSync(resolve(tempMailDir, "anvil", ".obligations"), { recursive: true });
    writeFileSync(resolve(tempMailDir, "anvil", ".obligations", "receipts"), "not a directory", "utf-8");
    chmodSync(flintNew, 0o333);
    try {
      await h.deliver("the final answer", "final");
      h.settle();
      const posted = await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "posted", 2000);
      expect(posted, "the delivery committed, and the record says so").toBe(true);

      const unconfirmed = await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "unconfirmed", 4000);
      expect(unconfirmed, "committed + no evidence at the deadline → unconfirmed").toBe(true);
      expect(curRecord("anvil")?.nackedAt, "no nack stamp").toBeUndefined();
      expect(curRecord("anvil")?.ackedAt).toBeUndefined();
    } finally {
      chmodSync(flintNew, 0o755);
    }
    // The reply landed, and NOTHING followed it: no nack mail was sent.
    const files = readdirSafe(flintNew).filter((f) => f.endsWith(".json"));
    expect(files.length, "the reply, and no nack mail").toBe(1);
    expect(nackMails("flint").length, "no nack mail").toBe(0);
    await h.stop();
  }, 20000);
  });

// ── round 9: an old stamp is not a verdict, and a late final is refused ──────

/**
 * cli#389 round 9. Two more places where the outcome was wrong.
 *
 * item 3 — RECOVERY DECIDES FROM EVIDENCE, NOT FROM AN OLD STAMP. Recovery turned
 * any existing `nackedAt` into a definitive verdict, so a stamp left by earlier
 * behaviour could fail a record whose own persisted state says the delivery
 * COMMITTED. For `delivering`/`posted`, recovery now decides by evidence and
 * deadline like every other path; the stamp is kept and never re-announced.
 *
 * item 4 — A TERMINAL OBLIGATION REFUSES `delivering`. `transitionObligation`
 * returns null for a refusal (rather than the old record), so `markDelivering`
 * can tell a landed write-ahead from a refused one: a final arriving after the
 * obligation CLOSED is logged `late-final-refused` and NOT delivered. Closure is
 * the reason (cli#389 round 10, item 3): an obligation can also close as
 * `unconfirmed`, which tells the sender nothing at all.
 */
describe("cli#389 round 9 — an old stamp is not a verdict, and a late final is refused", () => {
  const R9_OBLIGATION = "ob-round9";

  /** The durable state a restart finds: an unacked cur/ record + its obligation. */
  function seedRestart(
    agentId: string,
    inboundId: string,
    state: "posted" | "delivering" | "yielded",
    opts: { stamp?: string; deadlineInMs?: number } = {},
  ): void {
    mkdirSync(resolve(tempMailDir, agentId, "cur"), { recursive: true });
    mkdirSync(resolve(tempMailDir, agentId, ".obligations"), { recursive: true });
    writeFileSync(
      resolve(tempMailDir, agentId, "cur", `2026-05-26T00-00-00-${inboundId}.json`),
      JSON.stringify(
        {
          id: inboundId,
          from: "flint",
          to: agentId,
          body: buildSignedBody("flint", agentId, "x", FLINT_SEED),
          timestamp: new Date().toISOString(),
          read: false,
          ...(opts.stamp ? { nackedAt: opts.stamp, nackReason: "an old stamp" } : {}),
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      resolve(tempMailDir, agentId, ".obligations", `${inboundId}.json`),
      JSON.stringify(
        {
          obligationId: R9_OBLIGATION,
          inboundId,
          inboundTimestamp: new Date().toISOString(),
          from: "flint",
          to: agentId,
          accountId: "default",
          state,
          deadlineAt: new Date(Date.now() + (opts.deadlineInMs ?? 250)).toISOString(),
          attempts: 1,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  it("R9-a: recovery KEEPS an old nack stamp but does NOT treat it as a verdict — a `posted` record resolves by the deadline rule (`unconfirmed`), never re-announced", async () => {
    const agentId = "anvil";
    const inboundId = "msg-r9-oldstamp";
    const oldStamp = "2026-01-01T00:00:00.000Z";
    seedRestart(agentId, inboundId, "posted", { stamp: oldStamp, deadlineInMs: 250 });
    const h = await start(agentId, "flint", { localSender: true, noInbound: true });

    // The record COMMITTED (`posted`), so the old stamp is not a verdict: the
    // deadline rule decides, exactly as for a record with no stamp at all.
    const unconfirmed = await pollUntil(() => obligationFile(agentId, inboundId)?.state === "unconfirmed", 4000);
    expect(unconfirmed, "the deadline rule decided it, not the stamp").toBe(true);
    expect(obligationFile(agentId, inboundId)?.failure).toBe("yielded-without-resumption");
    // The stamp is KEPT on the cur/ record…
    expect(curRecordById(agentId, inboundId)?.nackedAt, "the stamp is kept").toBe(oldStamp);
    expect(curRecordById(agentId, inboundId)?.ackedAt, "and it is never acked").toBeUndefined();
    // …and NOTHING was re-announced to the sender.
    expect(nackMailsIn(resolve(tempMailDir, "flint", "new")).length, "never re-announced").toBe(0);
    await h.stop();
  }, 20000);

  it("R9-b: a final arriving AFTER the deadline settled the obligation is REFUSED (`late-final-refused`) and NOT delivered", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "300";
    const warned: string[] = [];
    const h = await start("anvil", "flint", { localSender: true, warnCalls: warned });
    const obId = h.obligationId();
    expect(obId).not.toBeNull();
    // The run yields while the dispatch is STILL in flight, so the deadline fires
    // and settles the obligation first — and the sender is told it failed.
    capturedSubscription.handle({ runId: obId, seq: 1, stream: "lifecycle", ts: Date.now(), data: { yielded: true }, sessionKey: "s" });
    const failed = await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "failed", 4000);
    expect(failed, "the deadline settled it first").toBe(true);
    const flintNew = resolve(tempMailDir, "flint", "new");
    const announced = await pollUntil(() => nackMailsIn(flintNew, "yielded-without-resumption").length === 1, 2000);
    expect(announced, "the sender was told it failed").toBe(true);

    // NOW the turn produces its final.
    await h.deliver("too late", "final");
    h.settle();
    await sleep(250);

    // The write-ahead REFUSED it: the obligation stays terminal, is never acked,
    // and the late final is NOT delivered.
    expect(obligationFile("anvil", h.inboundId)?.state, "still the terminal failure").toBe("failed");
    expect(curRecord("anvil")?.ackedAt, "never acked").toBeUndefined();
    const delivered = readdirSafe(flintNew)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try { return JSON.parse(readFileSync(resolve(flintNew, f), "utf-8")); } catch { return null; }
      })
      .filter((r) => r?.headers?.["X-TPS-Obligation"] === obId);
    expect(delivered.length, "the late final is NOT delivered").toBe(0);
    // …and only the ONE nack mail went out (the verb mails once per failed
    // transition — the refusal is not a second transition).
    expect(nackMailsIn(flintNew).length, "exactly one nack mail").toBe(1);
    // The refusal is logged BY NAME (cli#389 round 9, item 4).
    expect(warned.join("\n"), "logged by name").toContain("late-final-refused");
    await h.stop();
  }, 20000);
  });

// ── round 10: the nack mail is durable and at-least-once ────────────────────

/**
 * cli#389 round 10, item 1. The verb wrote `failed`, stamped the inbound and
 * then started an UNAWAITED send — so a crash between settling and sending, or a
 * send that could not be delivered, left the sender never told, and restart
 * recovery skipped terminal records entirely. The nack is now carried ON THE
 * RECORD (`nackPending`, cleared together with `nackSentAt`) and re-sent by the
 * next start whenever it is still owed. AT-LEAST-ONCE, not exactly-once.
 *
 * The two cases below are the two durable shapes that leaves:
 *   (a) the settle LANDED and the send never happened (a crash in between);
 *   (b) the settle landed and the send could not be delivered (no route).
 * Both are read back from the RECORD, never from the cur/ stamp — the stamp is
 * written before the send, so it can never prove the sender was told.
 */
describe("cli#389 round 10 — a settled failure's nack mail survives a crash", () => {
  const R10_OBLIGATION = "ob-round10";

  /** The durable state a crash between settling the failure and sending its nack
   *  leaves: a `failed` record still owing the mail, and the unacked cur/ record
   *  beside it (stamped, exactly as the settle wrote it before the send). */
  function seedNackOwed(agentId: string, inboundId: string, reason: string): void {
    mkdirSync(resolve(tempMailDir, agentId, "cur"), { recursive: true });
    mkdirSync(resolve(tempMailDir, agentId, ".obligations"), { recursive: true });
    writeFileSync(
      resolve(tempMailDir, agentId, "cur", `2026-05-26T00-00-00-${inboundId}.json`),
      JSON.stringify(
        {
          id: inboundId,
          from: "flint",
          to: agentId,
          body: buildSignedBody("flint", agentId, "x", FLINT_SEED),
          timestamp: new Date().toISOString(),
          read: false,
          nackedAt: new Date().toISOString(),
          nackReason: reason,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      resolve(tempMailDir, agentId, ".obligations", `${inboundId}.json`),
      JSON.stringify(
        {
          obligationId: R10_OBLIGATION,
          inboundId,
          inboundTimestamp: new Date().toISOString(),
          from: "flint",
          to: agentId,
          accountId: "default",
          state: "failed",
          deadlineAt: null,
          attempts: 1,
          failure: reason,
          nackPending: true,
          lastTransitionAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  it("R10-a: a crash between settling the failure and sending its nack → the next start SENDS it once, and the record says so", async () => {
    const agentId = "anvil";
    const inboundId = "msg-r10-crash";
    seedNackOwed(agentId, inboundId, "receipt-malformed");

    const h = await start(agentId, "flint", { localSender: true, noInbound: true });
    const flintNew = resolve(tempMailDir, "flint", "new");
    const arrived = await pollUntil(() => nackMailsIn(flintNew, "receipt-malformed").length === 1, 3000);
    expect(arrived, "the next start tells the sender").toBe(true);

    const rec = obligationFile(agentId, inboundId);
    expect(rec?.state, "the record keeps the terminal failure").toBe("failed");
    expect(rec?.failure).toBe("receipt-malformed");
    expect(rec?.nackPending, "the owed flag is cleared once the mail is handed over").toBeFalsy();
    expect(typeof rec?.nackSentAt, "and the send is recorded on the record").toBe("string");
    expect(nackMailsIn(flintNew).length, "exactly one nack mail").toBe(1);
    await h.stop();

    // A LATER start owes nothing: it must not send the mail a second time.
    abortController = new AbortController();
    const h2 = await start(agentId, "flint", { localSender: true, noInbound: true });
    await sleep(300);
    expect(nackMailsIn(flintNew).length, "and a later start re-sends NOTHING").toBe(1);
    await h2.stop();
  }, 20000);

  it("R10-b: a nack that could not be delivered leaves `nackPending`, and the next start re-sends it", async () => {
    const warned: string[] = [];
    // No route to the sender at all: the nack cannot be handed over, so the
    // failure settles with the mail still owed.
    const h = await start("anvil", "flint", { warnCalls: warned });
    h.skip("empty");
    h.settle();
    await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "failed", 3000);

    const rec = obligationFile("anvil", h.inboundId);
    expect(rec?.failure).toBe("empty-final-text");
    expect(rec?.nackPending, "the mail is still owed — nothing was handed over").toBe(true);
    expect(rec?.nackSentAt, "and nothing is recorded as sent").toBeUndefined();
    const owedLogged = await pollUntil(() => warned.join("\n").includes("nack-pending"), 2000);
    expect(owedLogged, "the attempt is logged by name").toBe(true);
    await h.stop();

    // The route now exists (the sender has a maildir): the next start re-sends.
    abortController = new AbortController();
    const h2 = await start("anvil", "flint", { localSender: true, noInbound: true });
    const flintNew = resolve(tempMailDir, "flint", "new");
    const arrived = await pollUntil(() => nackMailsIn(flintNew, "empty-final-text").length === 1, 3000);
    expect(arrived, "the next start hands the owed nack over").toBe(true);

    const after = obligationFile("anvil", h.inboundId);
    expect(after?.state, "the record is still the same terminal failure").toBe("failed");
    expect(after?.nackPending, "the flag is cleared").toBeFalsy();
    expect(typeof after?.nackSentAt, "and the send is recorded").toBe("string");
    expect(nackMailsIn(flintNew).length, "exactly one nack mail, sent by the restart").toBe(1);
    await h2.stop();
  }, 20000);
});

// ── round 11: an owed nack is never swept ───────────────────────────────────

/**
 * cli#389 round 11, item 1. Startup ran the retention sweep BEFORE owed-nack
 * recovery, and the sweep deleted an aged `failed` record without ever asking
 * whether its nack mail was still owed — so a record that owed the sender a
 * mail was swept the moment it aged past the window, and recovery then had
 * nothing left to retry. Two changes: the sweep never removes a record whose
 * nack is owed (`nackPending` with no `nackSentAt`) while it is inside the hold
 * window; and startup retries owed nacks before it sweeps.
 *
 * cli#389 round 12, item 2 bounds that hold by AGE — a configurable multiple of
 * `retentionDays` — so the fixture below sits past the 7-day retention window
 * but WELL INSIDE the hold (the default multiple is 4, i.e. 28 days).
 *
 * The record's cur/ record is stamped — so the older unresolved-cur/ hold does
 * not apply and the DEBT is the only thing that can hold it back. The sweep is
 * therefore driven DIRECTLY first (that is the hold under test), and then a
 * start proves the owed mail is actually retried.
 */
describe("cli#389 round 11 — an owed nack is never swept", () => {
  const R11_OBLIGATION = "ob-round11";

  /** The durable shape an owed nack leaves, aged past the retention window. */
  function seedAgedNackOwed(agentId: string, inboundId: string, reason: string, ageDays: number): void {
    const aged = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
    mkdirSync(resolve(tempMailDir, agentId, "cur"), { recursive: true });
    mkdirSync(resolve(tempMailDir, agentId, ".obligations"), { recursive: true });
    writeFileSync(
      resolve(tempMailDir, agentId, "cur", `2026-05-26T00-00-00-${inboundId}.json`),
      JSON.stringify(
        {
          id: inboundId,
          from: "flint",
          to: agentId,
          body: buildSignedBody("flint", agentId, "x", FLINT_SEED),
          timestamp: aged,
          read: false,
          nackedAt: aged,
          nackReason: reason,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      resolve(tempMailDir, agentId, ".obligations", `${inboundId}.json`),
      JSON.stringify(
        {
          obligationId: R11_OBLIGATION,
          inboundId,
          inboundTimestamp: aged,
          from: "flint",
          to: agentId,
          accountId: "default",
          state: "failed",
          deadlineAt: null,
          attempts: 1,
          failure: reason,
          nackPending: true,
          lastTransitionAt: aged,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  it("R11-a: an aged failed record whose nack is owed survives the sweep and is re-sent", async () => {
    const agentId = "anvil";
    const inboundId = "msg-r11-aged-nack";
    const reason = "receipt-malformed";
    seedAgedNackOwed(agentId, inboundId, reason, 10); // 10 days: past the 7-day window, inside the 28-day hold

    // The SWEEP on its own: age is what it acts on, and the owed mail is the only
    // thing that can hold the record back.
    const swept = sweepTerminalObligations(tempMailDir, agentId, 7, { info: () => {}, warn: () => {} });
    expect(swept.removed, "the aged record is NOT deleted while its nack is owed").toBe(0);
    expect(swept.heldForNack, "and it is counted as held for the mail it owes").toBe(1);
    expect(obligationFile(agentId, inboundId), "so the durable record survives the sweep").toBeTruthy();

    // A start then retries delivery of the mail the record still owes. The
    // retry runs OFF the startup path, and the sweep HOLDS a within-bound owed
    // record, so the debt is discharged and the record becomes ordinary without
    // depending on which of the two ran first.
    const h = await start(agentId, "flint", { localSender: true, noInbound: true });
    const flintNew = resolve(tempMailDir, "flint", "new");
    const arrived = await pollUntil(() => nackMailsIn(flintNew, reason).length === 1, 3000);
    expect(arrived, "the start re-sends the nack the aged record still owes").toBe(true);
    expect(nackMailsIn(flintNew).length, "exactly one nack mail").toBe(1);
    await h.stop();

    // Nothing is left owing: a later start re-sends nothing (the discharged,
    // aged record is ordinary, so the sweep takes it then, or already did).
    abortController = new AbortController();
    const h2 = await start(agentId, "flint", { localSender: true, noInbound: true });
    await sleep(300);
    expect(nackMailsIn(flintNew).length, "a later start re-sends nothing").toBe(1);
    await h2.stop();
  }, 20000);

  it("R11-b: a nackSentAt write that FAILS is logged by name — the mail is not silently 'recorded'", async () => {
    const agentId = "anvil";
    const inboundId = "msg-r11-unwritable-record";
    const reason = "receipt-malformed";
    seedAgedNackOwed(agentId, inboundId, reason, 0); // owed, and NOT aged

    // The record store still READS (the debt is visible) but cannot be WRITTEN,
    // so the mail hands over and the write that would discharge the debt fails.
    const warned: string[] = [];
    const obligationsDir = resolve(tempMailDir, agentId, ".obligations");
    chmodSync(obligationsDir, 0o500);
    try {
      const h = await start(agentId, "flint", { localSender: true, noInbound: true, warnCalls: warned });
      const flintNew = resolve(tempMailDir, "flint", "new");
      const arrived = await pollUntil(() => nackMailsIn(flintNew, reason).length === 1, 3000);
      expect(arrived, "the owed mail is handed over").toBe(true);

      const logged = await pollUntil(
        () => warned.join("\n").includes(`could not record nackSentAt for ${inboundId}`),
        2000,
      );
      expect(logged, "and the failed record write is logged BY NAME").toBe(true);
      expect(warned.join("\n"), "the line names the consequence for the sender").toContain("later start");
      await h.stop();
    } finally {
      chmodSync(obligationsDir, 0o700); // let the harness remove the tree
    }
  }, 20000);
});
  for (const state of ["failed", "posted"] as const) {
    it(`external inbound gates ${state} obligation recovery, replies and ack`, async () => {
      const agentId = "anvil";
      const inboundId = `external-${state}`;
      const signed = JSON.parse(buildSignedBody("flint", agentId, "external", FLINT_SEED));
      delete signed.signature;
      signed.trust = "external";
      const envelope = signEnvelope(signed, { flint: FLINT_SEED });
      const cur = resolve(tempMailDir, agentId, "cur");
      const obligations = resolve(tempMailDir, agentId, ".obligations");
      mkdirSync(cur, { recursive: true }); mkdirSync(obligations, { recursive: true });
      writeFileSync(resolve(cur, `${inboundId}.json`), JSON.stringify({ id: inboundId, from: "flint", to: agentId,
        body: envelope.body, timestamp: envelope.timestamp, envelopeId: envelope.messageId, envelope, read: false }));
      writeFileSync(resolve(obligations, `${inboundId}.json`), JSON.stringify({ obligationId: `ob-${inboundId}`,
        inboundId, inboundEnvelopeId: envelope.messageId, inboundTimestamp: envelope.timestamp, from: "flint", to: agentId,
        accountId: "default", state, deadlineAt: new Date(Date.now() + 50).toISOString(), attempts: 1,
        nackPending: state === "failed", failure: "external-old-debt" }));
      const h = await start(agentId, "flint", { localSender: true, noInbound: true });
      await new Promise((r) => setTimeout(r, 300));
      expect(h.dispatchCount).toBe(0);
      expect(readdirSafe(resolve(tempMailDir, "flint", "new"))).toEqual([]);
      expect(curRecordById(agentId, inboundId)?.ackedAt).toBeUndefined();
      expect(obligationFile(agentId, inboundId)?.state).toBe(state);
      await h.stop();
    });
  }

// ── cli#1006: an open obligation whose cur/ record is gone ──────────────────

describe("cli#1006 — recovery settles or re-arms an obligation with no cur/ record", () => {
  const AGENT = "agent-a";
  const SENDER = "sender-a";
  const REASON = "cur-record-missing";

  function seedOrphan(
    inboundId: string,
    opts: {
      obligationId?: string;
      state?: "pending" | "yielded" | "delivering" | "posted";
      deadlineInMs?: number;
      envelopeId?: string;
      missingCurReason?: string;
      /** Seed the record in the shape a completed arm leaves: revision 1 and a
       *  lastTransitionAt, so a later arm of the same state and deadline is a
       *  no-op (cli#1059 round 5). */
      armed?: boolean;
    } = {},
  ): { obligationId: string; envelopeId: string } {
    const envelopeId = opts.envelopeId ?? `env-${inboundId}`;
    const obligationId = opts.obligationId ?? `ob-${inboundId}`;
    const dir = resolve(tempMailDir, AGENT, ".obligations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, `${inboundId}.json`),
      JSON.stringify(
        {
          obligationId,
          inboundId,
          inboundEnvelopeId: envelopeId,
          inboundTimestamp: new Date().toISOString(),
          from: SENDER,
          to: AGENT,
          accountId: "default",
          state: opts.state ?? "yielded",
          deadlineAt: new Date(Date.now() + (opts.deadlineInMs ?? -1000)).toISOString(),
          attempts: 1,
          ...(opts.armed ? { revision: 1, lastTransitionAt: new Date().toISOString() } : {}),
          ...(opts.missingCurReason ? { missingCurReason: opts.missingCurReason } : {}),
        },
        null,
        2,
      ),
      "utf-8",
    );
    return { obligationId, envelopeId };
  }

  function seedSigningKeys(): void {
    writeFileSync(join(tempKeysDir, `${AGENT}.key`), ANVIL_SEED);
    writeFileSync(join(tempKeysDir, `${SENDER}.key`), FLINT_SEED);
  }

  /**
   * cli#1006 r10: push cur/ past the 4096-name scan limit with unrelated,
   * well-formed entries. Each carries a terminal stamp, so startup's cur/
   * sweep leaves it in place.
   */
  function exceedCurScanLimit(): void {
    const dir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(dir, { recursive: true });
    const ackedAt = new Date(0).toISOString();
    for (let i = 0; i < 4100; i++) {
      writeFileSync(
        resolve(dir, `zz-other-${i}.json`),
        JSON.stringify({ id: `other-${i}`, envelope: { messageId: `env-other-${i}` }, ackedAt }),
      );
    }
  }

  /**
   * cli#1006 r11: fill cur/ past the 4096-name scan limit with unrelated,
   * terminal-stamped entries, then place `record` in a file that readdir lists
   * at index >= 4096. The position is MEASURED: names are probed in batches and
   * the first one past the boundary carries the record. Returns that file's name.
   */
  function placeCurPastScanBoundary(record: object): string {
    const dir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(dir, { recursive: true });
    const ackedAt = new Date(0).toISOString();
    for (let i = 0; i < 4100; i++) {
      writeFileSync(
        resolve(dir, `zz-other-${i}.json`),
        JSON.stringify({ id: `other-${i}`, envelope: { messageId: `env-other-${i}` }, ackedAt }),
      );
    }
    for (let batch = 0; batch < 10; batch++) {
      const probes: string[] = [];
      for (let i = 0; i < 200; i++) {
        const name = `zzz-probe-${batch}-${i}.json`;
        writeFileSync(
          resolve(dir, name),
          JSON.stringify({ id: `probe-${batch}-${i}`, envelope: { messageId: `env-probe-${batch}-${i}` }, ackedAt }),
        );
        probes.push(name);
      }
      const order = readdirSync(dir);
      const placed = probes.find((name) => order.indexOf(name) >= 4096);
      if (placed) {
        writeFileSync(resolve(dir, placed), JSON.stringify(record), "utf-8");
        expect(order.indexOf(placed), "the record's file is past the first 4096 names in readdir order").toBeGreaterThanOrEqual(4096);
        return placed;
      }
    }
    throw new Error("could not place the record past the first 4096 names in readdirSync order on this filesystem");
  }

  it("with the deadline passed, settles from the record: terminal, named reason, one nack, no dispatch", async () => {
    seedSigningKeys();
    const inboundId = "msg-orphan-past";
    const { obligationId } = seedOrphan(inboundId, { deadlineInMs: -1000 });
    const warned: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warned });

    const failed = await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 3000);
    expect(failed, "the obligation reaches a terminal state").toBe(true);
    const rec = obligationFile(AGENT, inboundId);
    expect(rec?.failure).toBe("yielded-without-resumption");
    expect(rec?.missingCurReason, "the missing cur/ entry is a named reason on the record").toBe(REASON);
    expect(rec?.nackPending, "the nack is handed over, not left owing").toBeFalsy();
    expect(typeof rec?.nackSentAt).toBe("string");

    const senderNew = resolve(tempMailDir, SENDER, "new");
    expect(nackMailsIn(senderNew, "yielded-without-resumption").length, "exactly one nack to the recorded sender").toBe(1);
    expect(nackMailsIn(senderNew).length).toBe(1);
    expect(h.dispatchCount, "settling from the record dispatches nothing").toBe(0);
    expect(warned.join("\n"), "one line names the obligation and the reason").toContain(obligationId);
    expect(warned.join("\n")).toContain(REASON);
    expect(
      warned.filter((line) => line.includes("ack-stamp-failed") || line.includes("nack-stamp-failed")),
      "a missing cur/ entry is not stamped",
    ).toHaveLength(0);
    await h.stop();
  }, 20000);

  it("r8 a verified cur/ entry removed before the deadline: the deadline itself writes the reason", async () => {
    seedSigningKeys();
    const inboundId = "msg-deadline-first-writer";
    const obligationId = `ob-${inboundId}`;
    const deadlineAt = new Date(Date.now() + 5000).toISOString();
    const signedBody = buildSignedBody(SENDER, AGENT, "inbound payload", FLINT_SEED);
    const envelopeId = (JSON.parse(signedBody) as { messageId: string }).messageId;
    const dir = resolve(tempMailDir, AGENT, ".obligations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, `${inboundId}.json`),
      JSON.stringify(
        {
          obligationId,
          inboundId,
          inboundEnvelopeId: envelopeId,
          inboundTimestamp: new Date().toISOString(),
          from: SENDER,
          to: AGENT,
          accountId: "default",
          state: "yielded",
          deadlineAt,
          attempts: 1,
        },
        null,
        2,
      ),
      "utf-8",
    );
    // A VERIFIED cur/ entry at start: the launcher's noInbound rewrite promotes
    // it, and recovery verifies it before arming the deadline.
    const curDir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(curDir, { recursive: true });
    const curPath = resolve(curDir, `2026-05-26T00-00-00-${inboundId}.json`);
    writeFileSync(
      curPath,
      JSON.stringify(
        {
          id: inboundId,
          from: SENDER,
          to: AGENT,
          body: signedBody,
          timestamp: new Date().toISOString(),
          read: false,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "recovery verified the cur/ entry and armed the deadline",
      ).toBe(true);
      expect(
        obligationFile(AGENT, inboundId)?.missingCurReason,
        "recovery with cur/ present writes no reason",
      ).toBeUndefined();

      // Remove the cur/ entry BEFORE the deadline fires: from here the deadline
      // path is the first and only writer of the reason.
      rmSync(curPath);

      const failed = await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 12000);
      expect(failed, "the in-process deadline settles it").toBe(true);
      const rec = obligationFile(AGENT, inboundId);
      expect(rec?.failure).toBe("yielded-without-resumption");
      expect(rec?.missingCurReason, "the deadline path records the reason").toBe(REASON);
      expect(rec?.nackPending, "the nack is handed over, not left owing").toBeFalsy();
      expect(typeof rec?.nackSentAt).toBe("string");

      const senderNew = resolve(tempMailDir, SENDER, "new");
      expect(nackMailsIn(senderNew, "yielded-without-resumption").length, "exactly one nack to the recorded sender").toBe(1);
      expect(nackMailsIn(senderNew).length).toBe(1);
      expect(h.dispatchCount, "the deadline dispatches nothing").toBe(0);
      expect(
        warnings.filter((line) => line.includes("ack-stamp-failed") || line.includes("nack-stamp-failed")),
        "a missing cur/ entry is not stamped",
      ).toHaveLength(0);
    } finally { await h.stop(); }
  }, 30000);

  it("with the deadline still ahead, re-arms and does not settle early", async () => {
    seedSigningKeys();
    const inboundId = "msg-orphan-future";
    const { obligationId } = seedOrphan(inboundId, { deadlineInMs: 6000 });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });

    const rec = obligationFile(AGENT, inboundId);
    expect(rec?.state, "the obligation stays open").toBe("yielded");
    expect(rec?.missingCurReason, "and the named reason is on the record").toBe(REASON);
    const armed = obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId);
    expect(armed, "the deadline is re-armed").toBe(true);
    expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")).length, "nothing was sent early").toBe(0);
    expect(h.dispatchCount).toBe(0);

    // The re-armed deadline must itself settle from the record when it fires.
    const settled = await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 5000);
    expect(settled, "the re-armed deadline settles it").toBe(true);
    const senderNew = resolve(tempMailDir, SENDER, "new");
    expect(nackMailsIn(senderNew, "yielded-without-resumption").length, "one nack at the deadline").toBe(1);
    expect(h.dispatchCount).toBe(0);
    await h.stop();
  }, 20000);

  it("re-sends a nack still owed by a settled record whose cur/ entry is gone", async () => {
    seedSigningKeys();
    const inboundId = "msg-orphan-owed-nack";
    seedOrphan(inboundId, { deadlineInMs: -1000 });
    const recordPath = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const settled = JSON.parse(readFileSync(recordPath, "utf-8"));
    writeFileSync(
      recordPath,
      JSON.stringify(
        {
          ...settled,
          state: "failed",
          failure: "yielded-without-resumption",
          nackPending: true,
          missingCurReason: REASON,
        },
        null,
        2,
      ),
      "utf-8",
    );
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });

    const senderNew = resolve(tempMailDir, SENDER, "new");
    const arrived = await pollUntil(() => nackMailsIn(senderNew, "yielded-without-resumption").length === 1, 3000);
    expect(arrived, "the owed nack is retried from the record").toBe(true);
    expect(obligationFile(AGENT, inboundId)?.nackPending).toBeFalsy();
    expect(typeof obligationFile(AGENT, inboundId)?.nackSentAt).toBe("string");
    expect(nackMailsIn(senderNew).length).toBe(1);
    expect(h.dispatchCount).toBe(0);
    await h.stop();
  }, 20000);

  it("with a receipt present, settles from the receipt", async () => {
    seedSigningKeys();
    const inboundId = "msg-orphan-receipt";
    const { obligationId, envelopeId } = seedOrphan(inboundId, { deadlineInMs: -1000 });
    const replyId = "reply-orphan-a";
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const signedReply = signEnvelope(
      { v: 1, from: AGENT, to: SENDER, body: "recovered reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
      { [AGENT]: ANVIL_SEED },
    );
    writeReceipt(tempMailDir, AGENT, {
      replyId,
      obligationId,
      replyToId: envelopeId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(signedReply),
    });
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });

    const acked = await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "acked", 3000);
    expect(acked, "the receipt settles it").toBe(true);
    expect(obligationFile(AGENT, inboundId)?.missingCurReason).toBe(REASON);
    expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")).length, "an ack sends no nack").toBe(0);
    // There is no cur/ entry to stamp: the ack path must not attempt one.
    expect(
      warnings.filter((line) => line.includes("ack-stamp-failed")),
      "the missing-entry ack does not attempt a cur/ stamp",
    ).toHaveLength(0);
    expect(h.dispatchCount).toBe(0);
    await h.stop();
  }, 20000);

  it("leaves the obligation untouched when its cur/ file is present but unreadable", async () => {
    seedSigningKeys();
    const inboundId = "msg-cur-unreadable";
    const { obligationId } = seedOrphan(inboundId, { deadlineInMs: -1000 });
    // The cur/ record exists at the matching name but cannot be parsed. It is
    // not a missing record, so the lookup must not take the missing-cur path.
    const curDir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(curDir, { recursive: true });
    writeFileSync(resolve(curDir, `${inboundId}.json`), "{not json", "utf-8");

    const warned: string[] = [];
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      keepRawCur: `${inboundId}.json`,
      warnCalls: warned,
    });
    await sleep(300);

    const rec = obligationFile(AGENT, inboundId);
    expect(rec?.state, "a failed lookup does not settle the record").toBe("yielded");
    expect(rec?.missingCurReason, "and it is not marked as a missing cur/").toBeUndefined();
    expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")).length, "no nack").toBe(0);

    const lines = warned.filter((line) => line.includes("obligation-cur-lookup-failed"));
    expect(lines.length, "one line names the failed lookup").toBe(1);
    expect(lines[0]).toContain(obligationId);
    expect(lines[0]).toContain(inboundId);
    expect(lines[0]).toContain("INVALID_JSON");
    await h.stop();
  }, 20000);

  it("withholds the missing-cur nack-retry allowance once the cur/ file is back", async () => {
    seedSigningKeys();
    const inboundId = "msg-cur-restored";
    const { obligationId } = seedOrphan(inboundId, { deadlineInMs: -1000 });
    // The record still owes its nack and was settled while cur/ was gone.
    const recordPath = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const settled = JSON.parse(readFileSync(recordPath, "utf-8"));
    writeFileSync(
      recordPath,
      JSON.stringify(
        {
          ...settled,
          state: "failed",
          failure: "yielded-without-resumption",
          nackPending: true,
          missingCurReason: REASON,
        },
        null,
        2,
      ),
      "utf-8",
    );
    // The cur/ record is BACK. It does not verify (its body is not a signed
    // envelope), so the normal gated path must refuse to send; only the
    // missing-cur allowance would bypass that gate.
    const curDir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(curDir, { recursive: true });
    writeFileSync(
      resolve(curDir, `${inboundId}.json`),
      JSON.stringify({ id: inboundId, from: SENDER, to: AGENT, body: "not a signed envelope", timestamp: new Date().toISOString(), trust: "external" }),
      "utf-8",
    );

    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, keepRawCur: `${inboundId}.json` });
    await sleep(500);
    expect(
      nackMailsIn(resolve(tempMailDir, SENDER, "new")).length,
      "a present cur/ record takes the normal path, which refuses here",
    ).toBe(0);
    expect(obligationFile(AGENT, inboundId)?.nackPending, "the debt stays on the record").toBe(true);
    await h.stop();
  }, 20000);

  it("r7 an owed nack without the missing-cur reason keeps the inbound gate", async () => {
    seedSigningKeys();
    const inboundId = "msg-owed-nack-no-reason";
    seedOrphan(inboundId);
    transitionObligation(tempMailDir, AGENT, inboundId, "failed", {
      nackPending: true, failure: "yielded-without-resumption",
    });
    // This record was settled without the missing-cur rule. cur/ is absent too,
    // but absence alone does not hand it the retry's allowance.
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      await sleep(1000);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
      expect(obligationFile(AGENT, inboundId)?.nackPending).toBe(true);
    } finally { await h.stop(); }
  }, 20000);

  for (const fault of ["restored", "corrupt", "dangling"] as const) {
    it(`r3 deadline rechecks cur after re-arm: ${fault}`, async () => {
      seedSigningKeys();
      const inboundId = `msg-deadline-${fault}`;
      const { obligationId } = seedOrphan(inboundId, { deadlineInMs: 6000 });
      const warnings: string[] = [];
      const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
      try {
        expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId)).toBe(true);
        const before = obligationFile(AGENT, inboundId);
        const path = resolve(tempMailDir, AGENT, "cur", `${inboundId}.json`);
        mkdirSync(resolve(tempMailDir, AGENT, "cur"), { recursive: true });
        if (fault === "dangling") symlinkSync(`${path}.absent`, path);
        else writeFileSync(path, fault === "corrupt" ? "{not json" : JSON.stringify({
          id: inboundId, from: SENDER, to: AGENT, body: "unsigned", timestamp: new Date().toISOString(),
        }));
        expect(await pollUntil(() => !obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 7000)).toBe(true);
        await sleep(100);
        expect(obligationFile(AGENT, inboundId)).toEqual(before);
        expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
        expect(h.dispatchCount).toBe(0);
        expect(warnings.filter((line) => line.includes("obligation-cur-lookup-failed"))).toHaveLength(fault === "restored" ? 0 : 1);
      } finally { await h.stop(); }
    }, 20000);
  }

  it("r3 owed nack lookup error keeps the normal inbound gate", async () => {
    seedSigningKeys();
    const inboundId = "msg-retry-error";
    seedOrphan(inboundId);
    transitionObligation(tempMailDir, AGENT, inboundId, "failed", {
      nackPending: true, missingCurReason: REASON, failure: "yielded-without-resumption",
    });
    const dir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${inboundId}.json`), "{not json");
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, keepRawCur: `${inboundId}.json` });
    try {
      await sleep(500);
      expect(obligationFile(AGENT, inboundId)?.nackPending).toBe(true);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally { await h.stop(); }
  }, 20000);

  it("r3 dangling cur entry is a lookup error", async () => {
    seedSigningKeys();
    const inboundId = "msg-dangling-cur";
    seedOrphan(inboundId);
    const before = obligationFile(AGENT, inboundId);
    const dir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(dir, { recursive: true });
    symlinkSync(resolve(dir, "absent"), resolve(dir, `${inboundId}.json`));
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, keepRawCur: `${inboundId}.json`, warnCalls: warnings });
    try {
      await sleep(100);
      expect(obligationFile(AGENT, inboundId)).toEqual(before);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
      expect(warnings.filter((line) => line.includes("obligation-cur-lookup-failed"))).toHaveLength(1);
      expect(warnings.join("\n")).toContain("ENOENT");
    } finally { await h.stop(); }
  }, 20000);

  it("r3 state guard refuses a change after the post-scan re-read", async () => {
    seedSigningKeys();
    const inboundId = "msg-write-race";
    seedOrphan(inboundId, { deadlineInMs: 6000 });
    let injected = false;
    setBeforeTransitionForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      setBeforeTransitionForTests(undefined);
      transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "concurrent-reply" });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      // The hook fires from the recovery's own write, whose timing depends on
      // the host; wait for it instead of assuming it landed inside start()'s poll.
      expect(await pollUntil(() => injected, 15000), "recovery reached its guarded write").toBe(true);
      expect(obligationFile(AGENT, inboundId)?.state).toBe("posted");
      expect(obligationFile(AGENT, inboundId)?.replyId).toBe("concurrent-reply");
      expect(obligationFile(AGENT, inboundId)?.missingCurReason).toBe(REASON);
      expect(await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "unconfirmed", 7000)).toBe(true);
    } finally { setBeforeTransitionForTests(undefined); await h.stop(); }
  }, 40000);

  it("r4 the state guard refuses a write decided on a snapshot that moved", async () => {
    seedSigningKeys();
    const inboundId = "msg-expect-guard";
    seedOrphan(inboundId, { state: "yielded", deadlineInMs: 60000 });
    const snapshot = obligationFile(AGENT, inboundId)?.state;
    expect(transitionObligation(tempMailDir, AGENT, inboundId, "delivering", {})?.state).toBe("delivering");
    // Same target state as the record's, so only the prior-state guard can refuse.
    expect(transitionObligation(tempMailDir, AGENT, inboundId, "delivering", {}, undefined, { from: snapshot })).toBeNull();
    expect(obligationFile(AGENT, inboundId)?.state).toBe("delivering");
  });

  it("r5 the deadline settlement refuses a state change after its re-read", async () => {
    seedSigningKeys();
    const inboundId = "msg-settle-guard";
    seedOrphan(inboundId, { state: "yielded", deadlineInMs: -1000 });
    let injected = false;
    setBeforeTransitionForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      setBeforeTransitionForTests(undefined);
      transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "concurrent-reply" });
    });
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(await pollUntil(() => injected, 15000), "settlement reached its guarded write").toBe(true);
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "unconfirmed", 15000),
        "the guarded write was refused; the re-armed record settles",
      ).toBe(true);
      expect(obligationFile(AGENT, inboundId)?.replyId).toBe("concurrent-reply");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
      expect(warnings.join("\n")).toContain("refusing to record the failure");
    } finally { setBeforeTransitionForTests(undefined); await h.stop(); }
  }, 40000);

  it("r5 the unconfirmed settlement refuses a state change after its re-read", async () => {
    seedSigningKeys();
    const inboundId = "msg-unconfirmed-guard";
    seedOrphan(inboundId, { state: "delivering", deadlineInMs: -1000 });
    let injected = false;
    setBeforeTransitionForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      setBeforeTransitionForTests(undefined);
      transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "concurrent-reply" });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(await pollUntil(() => injected, 15000), "settlement reached its guarded write").toBe(true);
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "unconfirmed", 15000),
        "the guarded write was refused; the re-armed record settles",
      ).toBe(true);
      expect(obligationFile(AGENT, inboundId)?.replyId).toBe("concurrent-reply");
    } finally { setBeforeTransitionForTests(undefined); await h.stop(); }
  }, 40000);

  it("r5 a dangling cur/ directory is a lookup error: no settle, no nack, one log line", async () => {
    seedSigningKeys();
    const inboundId = "msg-dangling-cur-dir";
    seedOrphan(inboundId, { deadlineInMs: -1000 });
    const before = obligationFile(AGENT, inboundId);
    const agentDir = resolve(tempMailDir, AGENT);
    symlinkSync(resolve(agentDir, "absent-cur"), resolve(agentDir, "cur"));
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(await pollUntil(() => warnings.some((line) => line.includes("obligation-cur-lookup-failed")), 15000), "the lookup failure is logged").toBe(true);
      await sleep(200);
      expect(obligationFile(AGENT, inboundId)).toEqual(before);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
      expect(warnings.filter((line) => line.includes("obligation-cur-lookup-failed"))).toHaveLength(1);
      expect(warnings.join("\n")).toContain("DANGLING_SYMLINK");
    } finally { await h.stop(); }
  }, 20000);

  it("r8 cur/ as a regular file reports ENOTDIR and leaves the obligation untouched", async () => {
    seedSigningKeys();
    const inboundId = "msg-cur-notdir";
    seedOrphan(inboundId, { deadlineInMs: -1000 });
    const before = obligationFile(AGENT, inboundId);
    const agentDir = resolve(tempMailDir, AGENT);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(resolve(agentDir, "cur"), "not a directory", "utf-8");
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-cur-lookup-failed")), 15000),
        "the failed lookup is logged",
      ).toBe(true);
      await sleep(200);
      expect(obligationFile(AGENT, inboundId), "the obligation is unchanged").toEqual(before);
      expect(obligationFile(AGENT, inboundId)?.missingCurReason, "ENOTDIR is not a missing cur/").toBeUndefined();
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
      expect(h.dispatchCount).toBe(0);
      const lines = warnings.filter((line) => line.includes("obligation-cur-lookup-failed"));
      expect(lines, "one line names the failed lookup").toHaveLength(1);
      expect(lines[0]).toContain("ENOTDIR");
    } finally { await h.stop(); }
  }, 30000);

  it("does not overwrite a posted transition that lands during the receipt scan", async () => {
    seedSigningKeys();
    const inboundId = "msg-race-posted";
    const { obligationId, envelopeId } = seedOrphan(inboundId, {
      deadlineInMs: 8000,
      state: "yielded",
    });
    // A receipt carrying a reply signed by the WRONG key keeps the scan pending
    // (the verifier is gated below) and then reports no evidence.
    const replyId = "reply-race-a";
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const wrongKeyReply = signEnvelope(
      { v: 1, from: AGENT, to: SENDER, body: "race reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
      { [AGENT]: FLINT_SEED },
    );
    writeReceipt(tempMailDir, AGENT, {
      replyId,
      obligationId,
      replyToId: envelopeId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(wrongKeyReply),
    });

    let releaseScan!: () => void;
    const scanGate = new Promise<void>((r) => { releaseScan = r; });
    let scanEntered = false;
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        scanEntered = true;
        await scanGate;
      },
    });
    expect(scanEntered, "the receipt scan is awaiting verification").toBe(true);

    // Simulate a delivery committing `posted` while recovery holds the
    // pre-scan snapshot.
    expect(transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId })?.state).toBe("posted");
    releaseScan();

    await sleep(300);
    expect(obligationFile(AGENT, inboundId)?.state, "the fresh posted state is not overwritten").toBe("posted");
    expect(obligationFile(AGENT, inboundId)?.missingCurReason).toBe(REASON);

    const settled = await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "unconfirmed", 8000);
    expect(settled, "a committed record settles unconfirmed at its deadline, not failed").toBe(true);
    expect(obligationFile(AGENT, inboundId)?.missingCurReason).toBe(REASON);
    expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")).length, "an unconfirmed obligation sends no nack").toBe(0);
    expect(h.dispatchCount).toBe(0);
    await h.stop();
  }, 30000);

  it("r3 post-scan cur lookup: restored", async () => {
    seedSigningKeys();
    const inboundId = "msg-scan-restored";
    const { obligationId, envelopeId } = seedOrphan(inboundId, {
      deadlineInMs: 8000,
      state: "yielded",
    });
    // A receipt carrying a reply signed by the WRONG key keeps the scan pending
    // (the verifier is gated below) and then reports no evidence.
    const replyId = "reply-race-a";
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const wrongKeyReply = signEnvelope(
      { v: 1, from: AGENT, to: SENDER, body: "race reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
      { [AGENT]: FLINT_SEED },
    );
    writeReceipt(tempMailDir, AGENT, {
      replyId,
      obligationId,
      replyToId: envelopeId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(wrongKeyReply),
    });

    let releaseScan!: () => void;
    const scanGate = new Promise<void>((r) => { releaseScan = r; });
    let scanEntered = false;
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, {
      warnCalls: warnings,
      localSender: true,
      noInbound: true,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        scanEntered = true;
        await scanGate;
      },
    });
    expect(scanEntered, "the receipt scan is awaiting verification").toBe(true);

    const before = obligationFile(AGENT, inboundId);
    const path = resolve(tempMailDir, AGENT, "cur", `${inboundId}.json`);
    mkdirSync(resolve(tempMailDir, AGENT, "cur"), { recursive: true });
    writeFileSync(path, JSON.stringify({ id: inboundId, from: SENDER, to: AGENT, body: "unsigned", timestamp: new Date().toISOString() }));
    releaseScan();

    await sleep(300);
    expect(obligationFile(AGENT, inboundId)).toEqual(before);
    expect(warnings.filter((line) => line.includes("obligation-cur-lookup-failed"))).toHaveLength(0);
    expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId)).toBe(false);
    expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    await h.stop();
  }, 30000);

  it("r3 post-scan cur lookup: corrupt", async () => {
    seedSigningKeys();
    const inboundId = "msg-scan-corrupt";
    const { obligationId, envelopeId } = seedOrphan(inboundId, {
      deadlineInMs: 8000,
      state: "yielded",
    });
    // A receipt carrying a reply signed by the WRONG key keeps the scan pending
    // (the verifier is gated below) and then reports no evidence.
    const replyId = "reply-race-a";
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const wrongKeyReply = signEnvelope(
      { v: 1, from: AGENT, to: SENDER, body: "race reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
      { [AGENT]: FLINT_SEED },
    );
    writeReceipt(tempMailDir, AGENT, {
      replyId,
      obligationId,
      replyToId: envelopeId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(wrongKeyReply),
    });

    let releaseScan!: () => void;
    const scanGate = new Promise<void>((r) => { releaseScan = r; });
    let scanEntered = false;
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, {
      warnCalls: warnings,
      localSender: true,
      noInbound: true,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        scanEntered = true;
        await scanGate;
      },
    });
    expect(scanEntered, "the receipt scan is awaiting verification").toBe(true);

    const before = obligationFile(AGENT, inboundId);
    const path = resolve(tempMailDir, AGENT, "cur", `${inboundId}.json`);
    mkdirSync(resolve(tempMailDir, AGENT, "cur"), { recursive: true });
    writeFileSync(path, "{not json");
    releaseScan();

    await sleep(300);
    expect(obligationFile(AGENT, inboundId)).toEqual(before);
    expect(warnings.filter((line) => line.includes("obligation-cur-lookup-failed"))).toHaveLength(1);
    expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId)).toBe(false);
    expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    await h.stop();
  }, 30000);

  /** A signed cur/ entry (promoted by the launcher) plus an obligation record at `state`. */
  function seedVerifiedCur(
    inboundId: string,
    state: "yielded" | "delivering",
    deadlineInMs: number,
    opts: { armed?: boolean } = {},
  ): { obligationId: string; curPath: string } {
    const signedBody = buildSignedBody(SENDER, AGENT, "inbound payload", FLINT_SEED);
    const envelopeId = (JSON.parse(signedBody) as { messageId: string }).messageId;
    const { obligationId } = seedOrphan(inboundId, { state, deadlineInMs, envelopeId, ...opts });
    const curDir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(curDir, { recursive: true });
    const curPath = resolve(curDir, `2026-05-26T00-00-00-${inboundId}.json`);
    writeFileSync(
      curPath,
      JSON.stringify({ id: inboundId, from: SENDER, to: AGENT, body: signedBody, timestamp: new Date().toISOString(), read: false }),
      "utf-8",
    );
    return { obligationId, curPath };
  }

  it("r10 a deadline settles a verified inbound while cur/ holds more names than a scan reads", async () => {
    seedSigningKeys();
    const inboundId = "msg-deadline-scan-limit";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 8000);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "recovery verified the cur/ entry and armed the deadline",
      ).toBe(true);
      exceedCurScanLimit();

      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 15000),
        "the deadline settles from the cur/ path it was armed with",
      ).toBe(true);
      expect(obligationFile(AGENT, inboundId)?.missingCurReason, "the entry is not missing").toBeUndefined();
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
        "no timer is left armed",
      ).toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption")).toHaveLength(1);
      expect(h.dispatchCount, "the deadline dispatches nothing").toBe(0);
    } finally { await h.stop(); }
  }, 40000);

  it("r10 a stale curPath naming another id falls back to the scan", async () => {
    seedSigningKeys();
    const inboundId = "msg-stale-cur-path";
    const { obligationId, curPath } = seedVerifiedCur(inboundId, "yielded", 8000);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "recovery armed the deadline with the verified cur/ path",
      ).toBe(true);
      // The record at the armed path is replaced by ANOTHER inbound, and this
      // inbound's record now lives at a different name.
      const moved = resolve(resolve(tempMailDir, AGENT, "cur"), `2026-05-26T00-00-01-${inboundId}.json`);
      renameSync(curPath, moved);
      writeFileSync(
        curPath,
        JSON.stringify({ id: "msg-other-inbound", from: SENDER, to: AGENT, body: "unrelated", timestamp: new Date().toISOString() }),
        "utf-8",
      );

      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 15000),
        "the scan finds the record at its new name",
      ).toBe(true);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption")).toHaveLength(1);
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
        "no timer is left armed",
      ).toBe(false);
    } finally { await h.stop(); }
  }, 40000);

  it("r14 a deadline past the scan limit with no matching known path reports SCAN_LIMIT and stays unsettled", async () => {
    seedSigningKeys();
    const inboundId = "msg-deadline-scan-limit-gone";
    const { obligationId, curPath } = seedVerifiedCur(inboundId, "yielded", 8000);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "recovery armed the deadline with the verified cur/ path",
      ).toBe(true);
      // Before the deadline fires, the armed path is gone and cur/ holds more
      // names than the bounded scan reads: neither the path probe nor the scan
      // can prove absence.
      renameSync(curPath, `${curPath}.gone`);
      exceedCurScanLimit();

      expect(
        await pollUntil(
          () => warnings.some((line) => line.includes("obligation-cur-lookup-failed") && line.includes("SCAN_LIMIT")),
          15000,
        ),
        "the unmatched lookup past the limit is reported as SCAN_LIMIT",
      ).toBe(true);
      const after = obligationFile(AGENT, inboundId);
      expect(after?.state, "the obligation stays unsettled").toBe("yielded");
      expect(after?.missingCurReason, "a failed lookup is not a clean absence").toBeUndefined();
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
        "the fired deadline is not re-armed",
      ).toBe(false);
    } finally { await h.stop(); }
  }, 40000);

  it("r14 the unconfirmed settlement writes missingCurReason when the record had none", async () => {
    seedSigningKeys();
    const inboundId = "msg-unconfirmed-first-reason";
    const { obligationId, curPath } = seedVerifiedCur(inboundId, "delivering", 8000);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "recovery armed the deadline with no missing-entry reason",
      ).toBe(true);
      expect(obligationFile(AGENT, inboundId)?.missingCurReason, "the record is armed with no reason").toBeUndefined();
      // The verified entry disappears before the deadline: the deadline's clean
      // lookup finds no match, so the committed record settles unconfirmed.
      renameSync(curPath, `${curPath}.gone`);

      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "unconfirmed", 15000),
        "the committed record settles unconfirmed at the deadline",
      ).toBe(true);
      expect(
        obligationFile(AGENT, inboundId)?.missingCurReason,
        "the unconfirmed transition writes the reason itself",
      ).toBe("cur-record-missing");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "an unconfirmed record is not nacked").toHaveLength(0);
    } finally { await h.stop(); }
  }, 40000);

  it("r10 startup's cur/ scan finds a present entry past the scan limit", async () => {
    seedSigningKeys();
    const inboundId = "msg-startup-scan-limit";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 60000);
    exceedCurScanLimit();

    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "the startup scan leaves the obligation recoverable and its deadline armed",
      ).toBe(true);
      expect(warnings.filter((line) => line.includes("obligation-cur-lookup-failed"))).toHaveLength(0);
      expect(obligationFile(AGENT, inboundId)?.missingCurReason, "the entry is not missing").toBeUndefined();
    } finally { await h.stop(); }
  }, 40000);

  it("r11 startup's cur/ scan finds its record beyond the scan boundary", async () => {
    seedSigningKeys();
    const inboundId = "msg-startup-beyond-boundary";
    const signedBody = buildSignedBody(SENDER, AGENT, "inbound payload", FLINT_SEED);
    const envelopeId = (JSON.parse(signedBody) as { messageId: string }).messageId;
    const { obligationId } = seedOrphan(inboundId, { state: "yielded", deadlineInMs: 60000, envelopeId });
    placeCurPastScanBoundary({
      id: inboundId,
      from: SENDER,
      to: AGENT,
      body: signedBody,
      timestamp: new Date().toISOString(),
      read: false,
    });

    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "the startup scan finds the record past the boundary and arms its deadline",
      ).toBe(true);
      expect(warnings.filter((line) => line.includes("obligation-cur-lookup-failed"))).toHaveLength(0);
      expect(obligationFile(AGENT, inboundId)?.missingCurReason, "the entry is not missing").toBeUndefined();
    } finally { await h.stop(); }
  }, 60000);

  it("r10 startup past the scan limit still reports SCAN_LIMIT when no match proves absence", async () => {
    seedSigningKeys();
    const inboundId = "msg-startup-scan-limit-absent";
    seedOrphan(inboundId, { deadlineInMs: -1000 });
    exceedCurScanLimit();

    const before = obligationFile(AGENT, inboundId);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-cur-lookup-failed")), 15000),
        "the unmatched lookup past the limit is reported",
      ).toBe(true);
      expect(warnings.join("\n")).toContain("SCAN_LIMIT");
      expect(obligationFile(AGENT, inboundId), "the obligation is untouched").toEqual(before);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally { await h.stop(); }
  }, 40000);

  for (const state of ["yielded", "delivering"] as const) {
    it(`r10 a refused settlement write on a live record re-arms it: ${state} -> posted reaches a terminal state`, async () => {
      seedSigningKeys();
      const inboundId = `msg-refused-${state}`;
      const { obligationId } = seedOrphan(inboundId, { state, deadlineInMs: -1000 });
      let injected = false;
      setBeforeTransitionForTests((id) => {
        if (id !== inboundId || injected) return;
        injected = true;
        setBeforeTransitionForTests(undefined);
        transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "concurrent-reply" });
      });
      const warnings: string[] = [];
      const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
      try {
        expect(await pollUntil(() => injected, 15000), "settlement reached its guarded write").toBe(true);
        expect(
          await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "unconfirmed", 15000),
          "the re-armed deadline settles the live record from fresh evidence",
        ).toBe(true);
        expect(obligationFile(AGENT, inboundId)?.replyId).toBe("concurrent-reply");
        expect(
          obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
          "no timer is left armed",
        ).toBe(false);
        expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "a committed record is not nacked").toHaveLength(0);
        expect(warnings.join("\n")).toContain("refusing to record");
      } finally { setBeforeTransitionForTests(undefined); await h.stop(); }
    }, 40000);
  }

  it("r11 a retry after a refused write rescans the receipts: one placed before it fires acks", async () => {
    seedSigningKeys();
    const inboundId = "msg-retry-receipt";
    const replyId = "reply-retry-receipt";
    const { obligationId, envelopeId } = seedOrphan(inboundId, { state: "yielded", deadlineInMs: -1000 });
    let injected = false;
    let receiptWritten = false;
    let stateWhenReceiptLanded: string | undefined;
    const writeLateReceipt = (): void => {
      const now = new Date().toISOString();
      const chain: ChainEntry[] = [
        { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
        { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
      ];
      const signedReply = signEnvelope(
        { v: 1, from: AGENT, to: SENDER, body: "late reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
        { [AGENT]: ANVIL_SEED },
      );
      stateWhenReceiptLanded = obligationFile(AGENT, inboundId)?.state;
      writeReceipt(tempMailDir, AGENT, {
        replyId,
        obligationId,
        replyToId: envelopeId,
        route: "local",
        ts: now,
        signedReply: JSON.stringify(signedReply),
      });
      receiptWritten = true;
    };
    setBeforeTransitionForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      setBeforeTransitionForTests(undefined);
      transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId });
      // The outer write is refused once this hook returns; the receipt lands
      // 100 ms after that refusal, well inside the retry's one-second delay.
      setTimeout(writeLateReceipt, 100);
    });
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(await pollUntil(() => receiptWritten, 15000), "the receipt landed after the refusal").toBe(true);
      expect(stateWhenReceiptLanded, "the refused record was still live when the receipt landed").toBe("posted");
      expect(warnings.some((line) => line.includes("refusing to record")), "the guarded write was refused").toBe(true);

      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "acked", 15000),
        "the retry rescans the receipts and acks from the one that landed after the refusal",
      ).toBe(true);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "an ack sends no nack").toHaveLength(0);
    } finally { setBeforeTransitionForTests(undefined); await h.stop(); }
  }, 40000);

  // ── cli#1006 r12 — a refused settlement write on a TERMINAL or GONE record ──
  // The r10 cases above cover a record another writer left LIVE (re-armed). A
  // refused settlement write also has two other outcomes: the record is
  // TERMINAL, or it is GONE. Both are released from the in-process state, with
  // no retry timer, and neither the other writer's terminal state nor the nack
  // mail is touched.
  //
  // The retry's timer lives for one second, and the harness returns after its
  // own startup wait: sample the armed deadlines WHILE startup runs, so a
  // scheduled retry is seen even when it has fired by the time start resolves.
  async function sampleArmedDeadlines(obligationId: string, untilInjected: () => boolean, ms = 1200): Promise<boolean[]> {
    const seen: boolean[] = [];
    await pollUntil(untilInjected, 15000);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      seen.push(obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId));
      await new Promise((r) => setTimeout(r, 5));
    }
    return seen;
  }

  const refusedSettlements = [
    { from: "yielded", write: "failure", warning: "refusing to record the failure" },
    { from: "delivering", write: "unconfirmed", warning: "refusing to record the unconfirmed outcome" },
  ] as const;

  for (const { from, write, warning } of refusedSettlements) {
    for (const terminal of ["acked", "unconfirmed", "failed"] as const) {
      it(`r12 a refused ${write} write on a record another writer made ${terminal} releases it and sends no nack`, async () => {
        seedSigningKeys();
        const inboundId = `msg-refused-terminal-${write}-${terminal}`;
        const { obligationId } = seedOrphan(inboundId, { state: from, deadlineInMs: -1000 });
        let injected = false;
        let terminalRecord: any = null;
        setBeforeTransitionForTests((id) => {
          if (id !== inboundId || injected) return;
          injected = true;
          setBeforeTransitionForTests(undefined);
          transitionObligation(tempMailDir, AGENT, inboundId, terminal, { replyId: "concurrent-writer" });
          terminalRecord = obligationFile(AGENT, inboundId);
        });
        const warnings: string[] = [];
        const hPromise = start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
        const sampled = sampleArmedDeadlines(obligationId, () => injected);
        const h = await hPromise;
        try {
          expect(await pollUntil(() => injected, 15000), "settlement reached its guarded write").toBe(true);
          expect(terminalRecord?.state, "the concurrent writer made the record terminal").toBe(terminal);
          expect(
            await pollUntil(() => warnings.some((line) => line.includes(warning)), 15000),
            "the guarded settlement write was refused",
          ).toBe(true);
          expect(obligationFile(AGENT, inboundId), "the terminal state written by the other writer is unchanged").toEqual(terminalRecord);
          expect(
            obligationStateForTests().contexts.some((c) => c.obligationId === obligationId),
            "the refused obligation is released from the in-process map",
          ).toBe(false);
          expect((await sampled).includes(true), "no retry timer is armed").toBe(false);
          expect(
            obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
            "no retry timer is armed after startup",
          ).toBe(false);
          expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "a refused settlement sends no nack").toHaveLength(0);
        } finally { setBeforeTransitionForTests(undefined); await h.stop(); }
      }, 40000);
    }

    it(`r12 a refused ${write} write on a record DELETED before the re-read releases it and sends no nack`, async () => {
      seedSigningKeys();
      const inboundId = `msg-refused-gone-${write}`;
      const { obligationId } = seedOrphan(inboundId, { state: from, deadlineInMs: -1000 });
      let injected = false;
      setBeforeTransitionForTests((id) => {
        if (id !== inboundId || injected) return;
        injected = true;
        setBeforeTransitionForTests(undefined);
        rmSync(resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`), { force: true });
      });
      const warnings: string[] = [];
      const hPromise = start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
      const sampled = sampleArmedDeadlines(obligationId, () => injected);
      const h = await hPromise;
      try {
        expect(await pollUntil(() => injected, 15000), "settlement reached its guarded write").toBe(true);
        expect(
          await pollUntil(() => warnings.some((line) => line.includes(warning)), 15000),
          "the guarded settlement write was refused",
        ).toBe(true);
        expect(warnings.join("\n"), "the refusal names the record as gone").toContain("obligation is gone");
        expect(obligationFile(AGENT, inboundId), "the record stays deleted").toBeNull();
        expect(
          obligationStateForTests().contexts.some((c) => c.obligationId === obligationId),
          "the gone obligation is released from the in-process map",
        ).toBe(false);
        expect((await sampled).includes(true), "no retry timer is armed").toBe(false);
        expect(
          obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
          "no retry timer is armed after startup",
        ).toBe(false);
        expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "a refused settlement sends no nack").toHaveLength(0);
      } finally { setBeforeTransitionForTests(undefined); await h.stop(); }
    }, 40000);
  }

  it("r15 startup past the scan limit ignores an unrelated malformed entry and finds the match beyond the boundary", async () => {
    seedSigningKeys();
    const inboundId = "msg-startup-limit-malformed";
    const signedBody = buildSignedBody(SENDER, AGENT, "inbound payload", FLINT_SEED);
    const envelopeId = (JSON.parse(signedBody) as { messageId: string }).messageId;
    const { obligationId } = seedOrphan(inboundId, { state: "yielded", deadlineInMs: 60000, envelopeId });
    placeCurPastScanBoundary({
      id: inboundId,
      from: SENDER,
      to: AGENT,
      body: signedBody,
      timestamp: new Date().toISOString(),
      read: false,
    });
    // One unrelated record past the limit cannot be parsed. A read error on it
    // proves nothing about this inbound, so the scan must not report it.
    const malformed = "zzz-malformed-r15.json";
    writeFileSync(resolve(tempMailDir, AGENT, "cur", malformed), "{not json", "utf-8");

    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, keepRawCur: malformed, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "startup finds the entry beyond the boundary and arms its deadline",
      ).toBe(true);
      expect(
        warnings.filter((line) => line.includes("obligation-cur-lookup-failed")),
        "an unrelated read error past the limit is not reported",
      ).toHaveLength(0);
      expect(obligationFile(AGENT, inboundId)?.missingCurReason, "the entry is not missing").toBeUndefined();
    } finally { await h.stop(); }
  }, 60000);

  /**
   * Await the account's bound-agent startup cur/ sweeps and their recoveries for
   * this inbound. A timeout fails the caller's completion assertion, so a delayed
   * bypass cannot pass by outliving the assertions.
   */
  async function waitForStartupSweep(inboundId: string, ms = 15000): Promise<boolean> {
    return awaitStartupCurSweepForTests("default", inboundId, ms);
  }

  it("startup sweep wait returns false for an unstarted account", async () => {
    expect(await awaitStartupCurSweepForTests("unstarted-account", "msg-unstarted", 20)).toBe(false);
  });

  it("startup sweep wait includes the second bound agent while the first agent's receipt scan is suspended", async () => {
    seedSigningKeys();
    const inboundId = "msg-first-agent-receipt";
    const { obligationId, envelopeId } = seedOrphan(inboundId, { deadlineInMs: 60000 });
    const replyId = "reply-first-agent";
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const signedReply = signEnvelope(
      { v: 1, from: AGENT, to: SENDER, body: "recovered reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
      { [AGENT]: ANVIL_SEED },
    );
    writeReceipt(tempMailDir, AGENT, {
      replyId, obligationId, replyToId: envelopeId, route: "local", ts: now, signedReply: JSON.stringify(signedReply),
    });

    const secondAgent = "agent-b";
    const secondInbound = "msg-second-agent-invalid-signature";
    const secondCur = resolve(tempMailDir, secondAgent, "cur", `${secondInbound}.json`);
    const secondDlq = resolve(tempMailDir, secondAgent, "dlq", `${secondInbound}.json`);
    const secondEnvelope = JSON.parse(buildSignedBody(SENDER, secondAgent, "payload", ANVIL_SEED));
    mkdirSync(resolve(tempMailDir, secondAgent, "cur"), { recursive: true });
    writeFileSync(secondCur, JSON.stringify({
      id: secondInbound, from: SENDER, to: secondAgent,
      body: secondEnvelope.body, timestamp: secondEnvelope.timestamp, read: false,
      envelopeId: secondEnvelope.messageId, envelope: secondEnvelope,
    }));
    mailboxReplayStore(resolve(tempMailDir, secondAgent)).recordConsumed(secondEnvelope.messageId);

    let releaseScan!: () => void;
    const scanGate = new Promise<void>((r) => { releaseScan = r; });
    let scanEntered = false;
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((r) => { releaseRecovery = r; });
    let recoveryEntered = false;
    const h = await start(AGENT, SENDER, {
      noInbound: true,
      localSender: true,
      bindings: [AGENT, secondAgent].map((agentId) => ({ agentId, match: { channel: "tps-mail", accountId: "default" } })),
      beforeVerify: async (name) => {
        if (name === AGENT) {
          scanEntered = true;
          await scanGate;
        } else if (name === SENDER) {
          recoveryEntered = true;
          await recoveryGate;
        }
      },
    });
    try {
      expect(scanEntered, "the first agent's receipt scan is suspended").toBe(true);
      expect(existsSync(secondCur)).toBe(true);
      expect(existsSync(secondDlq)).toBe(false);
      let resolved = false;
      const waiting = waitForStartupSweep(secondInbound).then((completed) => {
        resolved = true;
        return {
          completed,
          curExists: existsSync(secondCur),
          quarantinedId: existsSync(secondDlq) ? JSON.parse(readFileSync(secondDlq, "utf8")).id : null,
        };
      });
      await sleep(30);
      expect(resolved, "the wait includes the second agent's unscheduled sweep").toBe(false);
      releaseScan();
      expect(await pollUntil(() => recoveryEntered), "the second agent's recovery is suspended").toBe(true);
      await sleep(30);
      expect(resolved, "the wait includes the second agent's recovery").toBe(false);
      releaseRecovery();
      expect(await waiting).toEqual({ completed: true, curExists: false, quarantinedId: secondInbound });
    } finally {
      releaseScan();
      releaseRecovery();
      await h.stop();
    }
  }, 30000);

  it("startup sweep wait retains the first bound agent's recovery after the second sweep starts", async () => {
    seedSigningKeys();
    const inboundId = "msg-first-bound-agent";
    const secondAgent = "agent-b";
    const secondInbound = "msg-second-bound-agent";
    const curDir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(curDir, { recursive: true });
    writeFileSync(resolve(curDir, `${inboundId}.json`), JSON.stringify({
      id: inboundId, from: SENDER, to: AGENT,
      body: buildSignedBody(SENDER, AGENT, "payload", FLINT_SEED),
      timestamp: new Date().toISOString(), read: false,
    }));
    const secondCurDir = resolve(tempMailDir, secondAgent, "cur");
    mkdirSync(secondCurDir, { recursive: true });
    writeFileSync(resolve(secondCurDir, `${secondInbound}.json`), JSON.stringify({
      id: secondInbound, from: SENDER, to: secondAgent,
      body: "unpromoted", timestamp: new Date().toISOString(), read: false,
    }));

    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((r) => { releaseRecovery = r; });
    let recoveryEntered = false;
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, {
      noInbound: true,
      localSender: true,
      warnCalls: warnings,
      bindings: [AGENT, secondAgent].map((agentId) => ({ agentId, match: { channel: "tps-mail", accountId: "default" } })),
      beforeVerify: async () => { recoveryEntered = true; await recoveryGate; },
    });
    try {
      expect(await pollUntil(() => recoveryEntered), "the first recovery is delayed").toBe(true);
      expect(await pollUntil(() => warnings.some((line) => line.includes(`cur/ recovery refused ${secondInbound}`))),
        "the second agent's sweep has scheduled recovery").toBe(true);
      let resolved = false;
      const waiting = waitForStartupSweep(inboundId).then((completed) => {
        resolved = true;
        return { completed, ackedAt: curRecordById(AGENT, inboundId)?.ackedAt };
      });
      await sleep(30);
      expect(resolved, "the wait includes the delayed first recovery").toBe(false);
      expect(await awaitStartupCurSweepForTests("default", inboundId, 20)).toBe(false);
      releaseRecovery();
      expect(await pollUntil(() => h.dispatched !== null), "the first recovery dispatches").toBe(true);
      await h.deliver("recovered reply", "final");
      h.settle();
      const result = await waiting;
      expect(result.completed).toBe(true);
      expect(result.ackedAt, "the recovery's ack is visible when the wait resolves").toBeString();
    } finally {
      releaseRecovery();
      h.settle();
      await h.stop();
    }
  }, 30000);

  it("r16 two matching cur/ entries report AMBIGUOUS_ID and the completed startup sweep leaves the obligation untouched", async () => {
    seedSigningKeys();
    const inboundId = "msg-ambiguous-cur-r16";
    const signedBody = buildSignedBody(SENDER, AGENT, "inbound payload", FLINT_SEED);
    const envelopeId = (JSON.parse(signedBody) as { messageId: string }).messageId;
    // The obligation's envelope id MUST match the signed entries: with a
    // mismatched id the internal gate refuses the record on its own, which hides
    // whether the lookup error is what kept the sweep away.
    const { obligationId } = seedOrphan(inboundId, { state: "yielded", deadlineInMs: 60000, envelopeId });
    const before = obligationFile(AGENT, inboundId);
    const curDir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(curDir, { recursive: true });
    for (const name of [`2026-05-26T00-00-00-${inboundId}.json`, `2026-05-26T00-00-01-${inboundId}.json`]) {
      writeFileSync(
        resolve(curDir, name),
        JSON.stringify({ id: inboundId, from: SENDER, to: AGENT, body: signedBody, timestamp: new Date().toISOString(), read: false }),
        "utf-8",
      );
    }

    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-cur-lookup-failed")), 15000),
        "startup reports the failed lookup",
      ).toBe(true);
      expect(warnings.join("\n")).toContain("AMBIGUOUS_ID");
      expect(await waitForStartupSweep(inboundId), "the startup sweep completes for this inbound").toBe(true);
      expect(obligationFile(AGENT, inboundId), "the startup sweep leaves the record untouched").toEqual(before);
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
        "no deadline is armed",
      ).toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
      for (const f of curFiles(AGENT)) {
        const rec = JSON.parse(readFileSync(resolve(curDir, f), "utf-8"));
        if (rec?.id !== inboundId) continue;
        expect(rec.ackedAt, "no cur/ entry is acked").toBeUndefined();
      }
      expect(h.dispatchCount, "nothing is dispatched").toBe(0);
    } finally { await h.stop(); }
  }, 60000);

  it("r16 a malformed cur/ entry beside the valid one reports INVALID_JSON and the completed startup sweep leaves the obligation untouched", async () => {
    seedSigningKeys();
    const inboundId = "msg-invalid-json-beside-r16";
    const signedBody = buildSignedBody(SENDER, AGENT, "inbound payload", FLINT_SEED);
    const envelopeId = (JSON.parse(signedBody) as { messageId: string }).messageId;
    const { obligationId } = seedOrphan(inboundId, { state: "yielded", deadlineInMs: 60000, envelopeId });
    const before = obligationFile(AGENT, inboundId);
    const curDir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(curDir, { recursive: true });
    writeFileSync(
      resolve(curDir, `2026-05-26T00-00-00-${inboundId}.json`),
      JSON.stringify({ id: inboundId, from: SENDER, to: AGENT, body: signedBody, timestamp: new Date().toISOString(), read: false }),
      "utf-8",
    );
    // Below the scan limit the malformed entry's read error IS reported: absence
    // is not what the failed lookup proves, so the record is left untouched.
    const malformed = "zzz-malformed-r16.json";
    writeFileSync(resolve(curDir, malformed), "{not json", "utf-8");

    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      keepRawCur: malformed,
      warnCalls: warnings,
    });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-cur-lookup-failed")), 15000),
        "startup reports the failed lookup",
      ).toBe(true);
      expect(warnings.join("\n")).toContain("INVALID_JSON");
      expect(await waitForStartupSweep(inboundId), "the startup sweep completes for this inbound").toBe(true);
      expect(obligationFile(AGENT, inboundId), "the startup sweep leaves the record untouched").toEqual(before);
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
        "no deadline is armed",
      ).toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
      expect(curRecordById(AGENT, inboundId)?.ackedAt, "the cur/ entry is not acked").toBeUndefined();
      expect(h.dispatchCount, "nothing is dispatched").toBe(0);
    } finally { await h.stop(); }
  }, 60000);

  /**
   * An open obligation with a matching cur/ entry. A start's recovery re-arms its
   * deadline, and that recovery is scheduled after the lookup pass: an armed
   * deadline proves the second start got past the lookup pass.
   */
  function seedCurCanary(inboundId: string): string {
    const signedBody = buildSignedBody(SENDER, AGENT, "payload", FLINT_SEED);
    const envelopeId = (JSON.parse(signedBody) as { messageId: string }).messageId;
    const { obligationId } = seedOrphan(inboundId, { state: "yielded", deadlineInMs: 60000, envelopeId });
    const curDir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(curDir, { recursive: true });
    writeFileSync(
      resolve(curDir, `zzz-canary-${inboundId}.json`),
      JSON.stringify({ id: inboundId, from: SENDER, to: AGENT, body: signedBody, timestamp: new Date().toISOString(), read: false }),
      "utf-8",
    );
    return obligationId;
  }

  it("r16 a repeated SCAN_LIMIT for one inbound is reported once per process", async () => {
    seedSigningKeys();
    const inboundId = "msg-scan-limit-once-r16";
    seedOrphan(inboundId, { deadlineInMs: 60000 });
    exceedCurScanLimit();

    const warnings: string[] = [];
    const first = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(
          () => warnings.some((line) => line.includes("obligation-cur-lookup-failed") && line.includes("SCAN_LIMIT")),
          15000,
        ),
        "the first start reports the scan limit",
      ).toBe(true);
    } finally { await first.stop(); }

    const canaryId = seedCurCanary("msg-loop-canary-r16");
    const second = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === canaryId), 15000),
        "the second start got past its lookup pass",
      ).toBe(true);
      expect(
        warnings.filter((line) => line.includes("obligation-cur-lookup-failed") && line.includes("SCAN_LIMIT")),
        "the same inbound and code are reported once",
      ).toHaveLength(1);
    } finally { await second.stop(); }
  }, 60000);

  it("r16 an earlier different lookup error does not suppress a later SCAN_LIMIT", async () => {
    seedSigningKeys();
    const inboundId = "msg-scan-limit-second-code-r16";
    seedOrphan(inboundId, { deadlineInMs: 60000 });
    const curDir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(curDir, { recursive: true });
    const malformed = "zzz-malformed-r16-code.json";
    writeFileSync(resolve(curDir, malformed), "{not json", "utf-8");

    const warnings: string[] = [];
    const first = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      keepRawCur: malformed,
      warnCalls: warnings,
    });
    try {
      expect(
        await pollUntil(
          () => warnings.some((line) => line.includes("obligation-cur-lookup-failed") && line.includes("INVALID_JSON")),
          15000,
        ),
        "the first start reports the malformed entry",
      ).toBe(true);
    } finally { await first.stop(); }

    exceedCurScanLimit();
    const second = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      keepRawCur: malformed,
      warnCalls: warnings,
    });
    try {
      expect(
        await pollUntil(
          () => warnings.some((line) => line.includes("obligation-cur-lookup-failed") && line.includes("SCAN_LIMIT")),
          15000,
        ),
        "the scan limit carries a different code, so it is reported too",
      ).toBe(true);
      expect(
        warnings.filter((line) => line.includes("obligation-cur-lookup-failed")),
        "both lookup failures are logged",
      ).toHaveLength(2);
    } finally { await second.stop(); }
  }, 60000);

  it("r16 a cur/ entry restored after the scan goes through reconcileObligation and is re-armed", async () => {
    seedSigningKeys();
    const inboundId = "msg-scan-restored-reconciled";
    const signedBody = buildSignedBody(SENDER, AGENT, "inbound payload", FLINT_SEED);
    const envelope = JSON.parse(signedBody) as { messageId: string; body: string; timestamp: string; replyToId?: string };
    const envelopeId = envelope.messageId;
    const { obligationId } = seedOrphan(inboundId, { deadlineInMs: 8000, state: "yielded", envelopeId });
    // A receipt carrying a reply signed by the WRONG key keeps the scan pending
    // at the verifier and then reports no evidence.
    const replyId = "reply-r15-restored";
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const wrongKeyReply = signEnvelope(
      { v: 1, from: AGENT, to: SENDER, body: "race reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
      { [AGENT]: FLINT_SEED },
    );
    writeReceipt(tempMailDir, AGENT, {
      replyId,
      obligationId,
      replyToId: envelopeId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(wrongKeyReply),
    });

    let releaseScan!: () => void;
    const scanGate = new Promise<void>((r) => { releaseScan = r; });
    let scanEntered = false;
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, {
      warnCalls: warnings,
      localSender: true,
      noInbound: true,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        scanEntered = true;
        await scanGate;
      },
    });
    try {
      expect(scanEntered, "the receipt scan is awaiting verification").toBe(true);
      const curDir = resolve(tempMailDir, AGENT, "cur");
      mkdirSync(curDir, { recursive: true });
      writeFileSync(
        resolve(curDir, `2026-05-26T00-00-00-${inboundId}.json`),
        JSON.stringify({
          id: inboundId,
          from: SENDER,
          to: AGENT,
          body: envelope.body,
          timestamp: envelope.timestamp,
          envelopeId,
          envelope,
          replyToId: envelope.replyToId,
          read: true,
        }),
        "utf-8",
      );
      mailboxReplayStore(resolve(tempMailDir, AGENT)).recordConsumed(envelopeId);
      releaseScan();

      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "recovery reconciles the restored entry and re-arms its deadline",
      ).toBe(true);
      expect(obligationFile(AGENT, inboundId)?.state, "the record stays open").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
    } finally { await h.stop(); }
  }, 40000);

  function scanLimitLines(warnings: string[]): string[] {
    return warnings.filter((line) => line.includes("obligation-cur-lookup-failed") && line.includes("SCAN_LIMIT"));
  }

  /** Fill one agent's cur/ past the scan limit with terminal-stamped unrelated entries. */
  function exceedScanLimitFor(mailDir: string, agent: string): void {
    const dir = resolve(mailDir, agent, "cur");
    mkdirSync(dir, { recursive: true });
    const ackedAt = new Date(0).toISOString();
    for (let i = 0; i < 4100; i++) {
      writeFileSync(
        resolve(dir, `zz-other-${i}.json`),
        JSON.stringify({ id: `other-${i}`, envelope: { messageId: `env-other-${i}` }, ackedAt }),
      );
    }
  }

  /** Write an open obligation directly for any agent under any maildir. */
  function seedOpenObligation(mailDir: string, agent: string, inboundId: string, deadlineInMs: number): string {
    const dir = resolve(mailDir, agent, ".obligations");
    mkdirSync(dir, { recursive: true });
    const obligationId = `ob-${agent}-${inboundId}`;
    writeFileSync(
      resolve(dir, `${inboundId}.json`),
      JSON.stringify({
        obligationId,
        inboundId,
        inboundEnvelopeId: `env-${inboundId}`,
        inboundTimestamp: new Date().toISOString(),
        from: SENDER,
        to: agent,
        accountId: "default",
        state: "yielded",
        deadlineAt: new Date(Date.now() + deadlineInMs).toISOString(),
        attempts: 1,
      }, null, 2),
      "utf-8",
    );
    return obligationId;
  }

  it("r18 a record for another message at the conventional cur/ path does not suppress missing-entry recovery", async () => {
    seedSigningKeys();
    const inboundId = "msg-other-at-path-r18";
    seedOrphan(inboundId, { deadlineInMs: -1000 });
    const curDir = resolve(tempMailDir, AGENT, "cur");
    mkdirSync(curDir, { recursive: true });
    const otherEnvelope = JSON.parse(buildSignedBody(SENDER, AGENT, "other payload", FLINT_SEED));
    // A VALID, terminal record for a DIFFERENT message id at the conventional
    // cur/<inboundId>.json path.
    writeFileSync(
      resolve(curDir, `${inboundId}.json`),
      JSON.stringify({
        id: "msg-other",
        from: SENDER,
        to: AGENT,
        body: otherEnvelope.body,
        timestamp: otherEnvelope.timestamp,
        envelopeId: otherEnvelope.messageId,
        envelope: otherEnvelope,
        read: true,
        ackedAt: new Date(0).toISOString(),
      }),
      "utf-8",
    );

    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      const failed = await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 15000);
      expect(failed, "missing-entry recovery settles the obligation").toBe(true);
      const rec = obligationFile(AGENT, inboundId);
      expect(rec?.failure).toBe("yielded-without-resumption");
      expect(rec?.missingCurReason, "the absent entry is recorded").toBe(REASON);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption").length, "one nack").toBe(1);
      expect(h.dispatchCount, "no agent reply is dispatched").toBe(0);
      expect(warnings.join("\n"), "the clean lookup is not reported as a failure").not.toContain("obligation-cur-lookup-failed");
    } finally { await h.stop(); }
  }, 60000);

  it("r18 a SCAN_LIMIT for a second inbound id in the same mailbox is reported", async () => {
    seedSigningKeys();
    const firstId = "msg-scan-limit-first-r18";
    const secondId = "msg-scan-limit-second-r18";
    seedOrphan(firstId, { deadlineInMs: 60000 });
    seedOrphan(secondId, { deadlineInMs: 60000 });
    exceedCurScanLimit();
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      const seen = await pollUntil(() => scanLimitLines(warnings).length >= 2, 20000);
      expect(seen, "both inbounds report the scan limit").toBe(true);
      const lines = scanLimitLines(warnings);
      expect(lines.length, "one line per inbound id").toBe(2);
      expect(lines.join("\n")).toContain(firstId);
      expect(lines.join("\n")).toContain(secondId);
    } finally { await h.stop(); }
  }, 60000);

  it("r18 a SCAN_LIMIT for the same inbound id under a second bound agent is reported", async () => {
    seedSigningKeys();
    const inboundId = "msg-scan-limit-second-agent-r18";
    const otherAgent = "agent-b";
    writeFileSync(join(tempKeysDir, `${otherAgent}.key`), ANVIL_SEED);
    const firstObligation = seedOpenObligation(tempMailDir, AGENT, inboundId, 60000);
    const secondObligation = seedOpenObligation(tempMailDir, otherAgent, inboundId, 60000);
    exceedScanLimitFor(tempMailDir, AGENT);
    exceedScanLimitFor(tempMailDir, otherAgent);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      bindings: [
        { agentId: AGENT, match: { channel: "tps-mail", accountId: "default" } },
        { agentId: otherAgent, match: { channel: "tps-mail", accountId: "default" } },
      ],
      warnCalls: warnings,
    });
    try {
      const seen = await pollUntil(() => scanLimitLines(warnings).length >= 2, 30000);
      expect(seen, "both bound agents report the scan limit").toBe(true);
      const lines = scanLimitLines(warnings);
      expect(lines.length, "one line per agent").toBe(2);
      expect(lines.join("\n")).toContain(firstObligation);
      expect(lines.join("\n")).toContain(secondObligation);
    } finally { await h.stop(); }
  }, 90000);

  it("r18 the same inbound id in a second maildir is reported again", async () => {
    seedSigningKeys();
    const inboundId = "msg-scan-limit-second-maildir-r18";
    const otherMailDir = mkdtempSync(join(tmpdir(), "tps-oblig-mail-second-"));
    try {
      seedOpenObligation(tempMailDir, AGENT, inboundId, 60000);
      seedOpenObligation(otherMailDir, AGENT, inboundId, 60000);
      exceedScanLimitFor(tempMailDir, AGENT);
      exceedScanLimitFor(otherMailDir, AGENT);
      const warnings: string[] = [];

      const first = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
      try {
        expect(await pollUntil(() => scanLimitLines(warnings).length >= 1, 20000), "the first maildir reports the scan limit").toBe(true);
      } finally { await first.stop(); }

      const second = await start(AGENT, SENDER, {
        localSender: true,
        noInbound: true,
        accountId: "second",
        mailDir: otherMailDir,
        accounts: { default: { mailDir: tempMailDir }, second: { mailDir: otherMailDir } },
        bindings: [{ agentId: AGENT, match: { channel: "tps-mail", accountId: "second" } }],
        warnCalls: warnings,
      });
      try {
        expect(await pollUntil(() => scanLimitLines(warnings).length >= 2, 20000), "the second maildir reports it too").toBe(true);
        expect(scanLimitLines(warnings).length, "two lines, one per maildir").toBe(2);
      } finally { await second.stop(); }
    } finally {
      rmSync(otherMailDir, { recursive: true, force: true });
    }
  }, 90000);

  it("r18 a SCAN_LIMIT logged by the deadline suppresses the same warning on a restart", async () => {
    seedSigningKeys();
    const inboundId = "msg-deadline-scan-limit-once-r18";
    seedOrphan(inboundId, { deadlineInMs: 12000 });
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      // The startup lookup is a clean miss; push cur/ past the scan limit before
      // the re-armed deadline fires, so the deadline's own lookup reports it.
      exceedCurScanLimit();
      expect(
        await pollUntil(() => scanLimitLines(warnings).some((line) => line.includes(inboundId)), 20000),
        "the deadline reports the scan limit",
      ).toBe(true);
      expect(scanLimitLines(warnings).filter((line) => line.includes(inboundId)), "once").toHaveLength(1);
    } finally { await h.stop(); }

    const canaryId = seedCurCanary("msg-canary-r18-deadline-once");
    const second = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === canaryId), 30000),
        "the restart got past its lookup pass",
      ).toBe(true);
      expect(scanLimitLines(warnings).filter((line) => line.includes(inboundId)), "the restart does not repeat it").toHaveLength(1);
    } finally { await second.stop(); }
  }, 120000);

  it("r18 a lookup error logged by missing-entry recovery suppresses the same warning on a restart", async () => {
    seedSigningKeys();
    const inboundId = "msg-post-scan-error-once-r18";
    const { obligationId } = seedOrphan(inboundId, { deadlineInMs: 60000 });
    const envelopeId = `env-${inboundId}`;
    // A receipt carrying a reply signed by the WRONG key keeps the scan pending
    // at the verifier and then reports no evidence, so the post-scan lookup runs.
    const replyId = "reply-r18-post-scan";
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const wrongKeyReply = signEnvelope(
      { v: 1, from: AGENT, to: SENDER, body: "race reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
      { [AGENT]: FLINT_SEED },
    );
    writeReceipt(tempMailDir, AGENT, {
      replyId,
      obligationId,
      replyToId: envelopeId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(wrongKeyReply),
    });

    let releaseScan!: () => void;
    const scanGate = new Promise<void>((r) => { releaseScan = r; });
    let scanEntered = false;
    const malformed = "zzz-malformed-r18-post-scan.json";
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      warnCalls: warnings,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        scanEntered = true;
        await scanGate;
      },
    });
    try {
      expect(scanEntered, "the missing-entry receipt scan is awaiting verification").toBe(true);
      const curDir = resolve(tempMailDir, AGENT, "cur");
      mkdirSync(curDir, { recursive: true });
      writeFileSync(resolve(curDir, malformed), "{not json", "utf-8");
      releaseScan();
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-cur-lookup-failed") && line.includes("INVALID_JSON")), 20000),
        "the post-scan lookup reports the malformed entry",
      ).toBe(true);
      expect(
        warnings.filter((line) => line.includes("obligation-cur-lookup-failed") && line.includes("INVALID_JSON")),
        "once, from the post-scan lookup",
      ).toHaveLength(1);
    } finally { await h.stop(); }

    const second = await start(AGENT, SENDER, { localSender: true, noInbound: true, keepRawCur: malformed, warnCalls: warnings });
    try {
      // The sweep runs after the startup lookup pass; awaiting its completion
      // proves this start looked the inbound up rather than returning early.
      expect(
        await awaitStartupCurSweepForTests("default", inboundId, 30000),
        "the restart completes its startup sweep",
      ).toBe(true);
      expect(
        warnings.filter((line) => line.includes("obligation-cur-lookup-failed") && line.includes("INVALID_JSON")),
        "the restart does not repeat it",
      ).toHaveLength(1);
    } finally { await second.stop(); }
  }, 120000);

  // ── cli#1059 — bounded in-process retry and revision-checked writes ────────

  it("1059 a deadline lookup error retries in-process and settles once the fault clears", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-lookup-retry";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 500);
    let faulty = true;
    setObligationCurLookupFaultForTests((id) => (id === inboundId && faulty ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([300, 300, 300]);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 15000),
        "the deadline lookup error scheduled an in-process retry",
      ).toBe(true);
      faulty = false;
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 15000),
        "a later attempt settles the live record after the lookup recovers",
      ).toBe(true);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption")).toHaveLength(1);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 three refused arms (the initial arm and two re-arms) consume the bounded attempts and then resolve", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-arm-retry";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 1500);
    // The initial arm and retries 1 and 2 are refused; retry 3 must arm.
    let refusals = 3;
    setArmDeadlineFaultForTests((id) => id === inboundId && refusals-- > 0);
    const prevDelays = setObligationRetryDelaysForTests([50, 100, 200]);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "a later attempt arms the deadline",
      ).toBe(true);
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 15000),
        "the armed deadline resolves the obligation in this process",
      ).toBe(true);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption")).toHaveLength(1);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setArmDeadlineFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 a lookup fault through all three attempts logs one exhaustion warning and writes nothing", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-retry-exhausted";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 1200);
    let lookups = 0;
    setObligationCurLookupFaultForTests((id) => {
      if (id !== inboundId) return undefined;
      lookups++;
      return "EIO";
    });
    const prevDelays = setObligationRetryDelaysForTests([50, 100, 150]);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "the deadline is armed before the faulting deadline fires",
      ).toBe(true);
      const before = readFileSync(resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8");
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "the cap is reached with a named warning",
      ).toBe(true);
      expect(warnings.filter((line) => line.includes("obligation-retry-exhausted"))).toHaveLength(1);
      expect(warnings.join("\n")).toContain("EIO");
      // The initial deadline check plus all three bounded retries ran before
      // the cap: removing the third delay would stop at three lookups.
      expect(lookups, "the initial check and three retries ran").toBe(4);
      await sleep(200);
      const after = readFileSync(resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8");
      expect(after, "the record is byte-identical").toBe(before);
      const retry = obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
      expect(retry?.exhausted, "the budget stays exhausted with no timer").toBe(true);
      expect(retry?.dueAt, "an exhausted entry holds no due time").toBe(Number.POSITIVE_INFINITY);
      expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), "no deadline timer is left").toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "the cap sends no nack").toHaveLength(0);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 a re-arm of the state and deadline a record already carries writes nothing", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-rearm-noop";
    // Seed the record in the shape the completed startup arm leaves (revision 1,
    // lastTransitionAt). Recovery still arms the deadline it reads; the arm has
    // nothing to record, so it must not write — including while the deadline's
    // cur/ lookup is faulting and the bounded retries run.
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 1200, { armed: true });
    let lookups = 0;
    setObligationCurLookupFaultForTests((id) => {
      if (id !== inboundId) return undefined;
      lookups++;
      return "EIO";
    });
    const prevDelays = setObligationRetryDelaysForTests([50, 100, 150]);
    const warnings: string[] = [];
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const before = readFileSync(path, "utf-8");
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "recovery arms the deadline the record already carries",
      ).toBe(true);
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "the faulting deadline check exhausts its budget",
      ).toBe(true);
      expect(lookups, "the initial check and three retries ran").toBe(4);
      await sleep(200);
      expect(readFileSync(path, "utf-8"), "the re-arm is not a write").toBe(before);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 shutdown clears a pending retry and a restarted account is not touched by it", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-retry-shutdown";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    setObligationCurLookupFaultForTests((id) => (id === inboundId ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([600, 600, 600]);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 15000),
        "a retry is pending",
      ).toBe(true);
      await h.stop();
      expect(obligationStateForTests().retries.some((r) => r.obligationId === obligationId), "shutdown clears the retry").toBe(false);

      transitionObligation(tempMailDir, AGENT, inboundId, "unconfirmed", { failure: "restart-fixture" });
      const before = readFileSync(resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8");
      const h2 = await start(AGENT, SENDER, { localSender: true, noInbound: true });
      await sleep(900);
      const after = readFileSync(resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8");
      expect(after, "the old retry does not act after the restart").toBe(before);
      await h2.stop();
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      try { await h.stop(); } catch { /* already stopped */ }
    }
  }, 40000);

  it("1059 a record that settles while a retry waits cancels the retry with no write", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-retry-cancel";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    setObligationCurLookupFaultForTests((id) => (id === inboundId ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([600, 600, 600]);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 15000),
        "a retry is pending",
      ).toBe(true);
      transitionObligation(tempMailDir, AGENT, inboundId, "unconfirmed", { failure: "settled-concurrently" });
      const before = readFileSync(resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8");
      await sleep(900);
      const after = readFileSync(resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8");
      expect(after, "the cancelled retry writes nothing").toBe(before);
      expect(obligationStateForTests().retries.some((r) => r.obligationId === obligationId)).toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 a same-state deadline extension refuses the stale settle write and sends no early nack", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-same-state";
    seedOrphan(inboundId, { state: "yielded", deadlineInMs: -1000 });
    let injected = false;
    setBeforeTransitionForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      setBeforeTransitionForTests(undefined);
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", {
        deadlineAt: new Date(Date.now() + 2500).toISOString(),
      });
    });
    const prevDelays = setObligationRetryDelaysForTests([50, 100, 200]);
    const warnings: string[] = [];
    const hPromise = start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(await pollUntil(() => injected, 15000), "the settlement reached its guarded write").toBe(true);
      expect(obligationFile(AGENT, inboundId)?.state, "the stale settle write is refused").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no early nack is sent").toHaveLength(0);
      const h = await hPromise;
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 15000),
        "the fresh record is re-evaluated and settles at its extended deadline",
      ).toBe(true);
      expect(warnings.join("\n")).toContain("refusing to record the failure");
      await h.stop();
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setBeforeTransitionForTests(undefined);
    }
  }, 40000);

  it("1059 a record with no revision reads as 0 and its first write sets 1", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-legacy-revision";
    seedOrphan(inboundId, { state: "yielded", deadlineInMs: 60000 });
    expect(obligationFile(AGENT, inboundId)?.revision).toBeUndefined();
    const written = transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "reply-legacy" });
    expect(written?.revision).toBe(1);
    expect(obligationFile(AGENT, inboundId)?.revision).toBe(1);
  });

  it("1059 two writers on the same snapshot revision: exactly one wins", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-revision-race";
    seedOrphan(inboundId, { state: "posted", deadlineInMs: 60000 });
    const snapshot = obligationFile(AGENT, inboundId);
    expect(snapshot?.revision).toBeUndefined();
    const stale = snapshot?.revision ?? 0;
    const first = transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "reply-first" }, undefined, {
      from: "posted",
      revision: stale,
    });
    const second = transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "reply-second" }, undefined, {
      from: "posted",
      revision: stale,
    });
    expect(first?.revision, "the first writer lands revision 1").toBe(1);
    expect(second, "the second writer on the same revision is refused").toBeNull();
    expect(obligationFile(AGENT, inboundId)?.replyId).toBe("reply-first");
    expect(obligationFile(AGENT, inboundId)?.revision).toBe(1);
  });

  // ── cli#1059 round 2 ──────────────────────────────────────────────────────

  it("1059 r2 a startup arm does not overwrite a deadline extension with the stored argument", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r2-arm-extension";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", -1000);
    let extended = false;
    setBeforeArmReadForTests((id) => {
      if (id !== inboundId || extended) return;
      extended = true;
      setBeforeArmReadForTests(undefined);
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", {
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
      });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(await pollUntil(() => extended, 15000), "the extension landed before the first arm read").toBe(true);
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 5000),
        "the deadline is armed",
      ).toBe(true);
      await sleep(600);
      expect(obligationFile(AGENT, inboundId)?.state, "the extended deadline is not overwritten").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setBeforeArmReadForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r2 a deadline extension during a held receipt scan redoes the deadline decision", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r2-scan-extension";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 60000);
    const envelopeId = obligationFile(AGENT, inboundId)?.inboundEnvelopeId as string;
    let gate: Promise<void> | null = null;
    let releaseScan: (() => void) | null = null;
    let scanEntered = false;
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      warnCalls: warnings,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        scanEntered = true;
        if (gate) await gate;
      },
    });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "startup armed the long deadline",
      ).toBe(true);
      // A receipt signed by the WRONG key keeps the deadline scan held at the
      // verifier and then reports no evidence.
      const replyId = "reply-r2-scan";
      const now = new Date().toISOString();
      const chain: ChainEntry[] = [
        { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
        { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
      ];
      const wrongKeyReply = signEnvelope(
        { v: 1, from: AGENT, to: SENDER, body: "race reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
        { [AGENT]: FLINT_SEED },
      );
      writeReceipt(tempMailDir, AGENT, {
        replyId,
        obligationId,
        replyToId: envelopeId,
        route: "local",
        ts: now,
        signedReply: JSON.stringify(wrongKeyReply),
      });
      gate = new Promise<void>((r) => { releaseScan = r; });
      // Move the deadline into the past, then fire the deadline through the
      // subscription event the plugin uses for a yielded run.
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", { deadlineAt: new Date(Date.now() - 1000).toISOString() });
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      expect(await pollUntil(() => scanEntered, 15000), "the deadline scan is held at the verifier").toBe(true);
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", { deadlineAt: new Date(Date.now() + 5000).toISOString() });
      releaseScan!();
      await sleep(500);
      expect(obligationFile(AGENT, inboundId)?.state, "the old deadline does not settle the extended record").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
        "the extended deadline is re-armed",
      ).toBe(true);
    } finally {
      await h.stop();
    }
  }, 40000);

  it("1059 r2 an ack is bound to the scanned revision and reply identity", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r2-ack-binding";
    const { obligationId, envelopeId } = seedOrphan(inboundId, { state: "yielded", deadlineInMs: -1000 });
    // The record names reply-old and a REAL signed receipt for it exists.
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const seeded = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...seeded, replyId: "reply-old" }, null, 2), "utf-8");
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const signedReply = signEnvelope(
      { v: 1, from: AGENT, to: SENDER, body: "old reply", messageId: "reply-old", timestamp: now, replyToId: envelopeId, delegationChain: chain },
      { [AGENT]: ANVIL_SEED },
    );
    writeReceipt(tempMailDir, AGENT, {
      replyId: "reply-old",
      obligationId,
      replyToId: envelopeId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(signedReply),
    });
    // A same-state writer replaces replyId between the scan and the ack write.
    let injected = false;
    setBeforeTransitionForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      setBeforeTransitionForTests(undefined);
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", { replyId: "reply-new" });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(await pollUntil(() => injected, 15000), "the ack reached its guarded write").toBe(true);
      expect(await pollUntil(() => obligationFile(AGENT, inboundId)?.state !== "yielded", 15000), "the record is re-evaluated").toBe(true);
      expect(obligationFile(AGENT, inboundId)?.state, "the old receipt does not ack the new reply").not.toBe("acked");
      expect(obligationFile(AGENT, inboundId)?.replyId).toBe("reply-new");
    } finally {
      setBeforeTransitionForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r2 an overflowing or malformed revision is unverified and is never written", async () => {
    seedSigningKeys();
    const overflow = 9007199254740992;
    expect(overflow + 1, "the overflow is why revisions are bounded").toBe(overflow);
    const values: Array<[string, unknown]> = [
      ["overflow", overflow],
      ["string", "3"],
      ["negative", -1],
      ["fraction", 1.5],
      ["null", null],
    ];
    for (const [label, revision] of values) {
      const inboundId = `msg-1059-r2-rev-${label}`;
      seedOrphan(inboundId, { state: "yielded", deadlineInMs: 60000 });
      const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      writeFileSync(path, JSON.stringify({ ...raw, revision }, null, 2), "utf-8");
      const before = readFileSync(path, "utf-8");
      const read = readObligationResult(tempMailDir, AGENT, inboundId);
      expect(read.status, `${label} is unverified`).toBe("unverified");
      expect(read.status === "unverified" ? read.code : "", `${label} reports the revision`).toBe("INVALID_REVISION");
      expect(transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: `reply-${label}` }), `${label} is never transitioned`).toBeNull();
      expect(() => writeObligation(tempMailDir, AGENT, { ...raw, state: "posted" }), `${label} is never written`).toThrow();
      expect(readFileSync(path, "utf-8"), `${label} record is byte-identical`).toBe(before);
    }
  });

  it("1059 r2 repeated yield events keep a pending retry's due time", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r2-retry-due";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    setObligationCurLookupFaultForTests((id) => (id === inboundId ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([5000]);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 15000),
        "a retry is pending",
      ).toBe(true);
      const before = obligationStateForTests().retries.find((r) => r.obligationId === obligationId)!;
      expect(before.attempt).toBe(1);
      for (let i = 0; i < 3; i++) {
        capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
        await sleep(150);
      }
      const after = obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
      expect(after?.attempt, "no extra attempt is consumed").toBe(1);
      expect(after?.dueAt, "the pending due time is unchanged").toBe(before.dueAt);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r2 an event after exhaustion does not reopen the budget or warn again", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r2-exhausted-event";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    setObligationCurLookupFaultForTests((id) => (id === inboundId ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([50, 60, 70]);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "the cap is reached",
      ).toBe(true);
      expect(warnings.filter((line) => line.includes("obligation-retry-exhausted"))).toHaveLength(1);
      const exhausted = obligationStateForTests().retries.find((r) => r.obligationId === obligationId)!;
      expect(exhausted.exhausted).toBe(true);
      expect(exhausted.attempt).toBe(3);
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      await sleep(500);
      expect(
        warnings.filter((line) => line.includes("obligation-retry-exhausted")),
        "no second exhaustion warning",
      ).toHaveLength(1);
      const after = obligationStateForTests().retries.find((r) => r.obligationId === obligationId)!;
      expect(after.exhausted, "the budget stays exhausted").toBe(true);
      expect(after.attempt).toBe(3);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r3 scheduled retry due times use the unoverridden defaults for every attempt", async () => {
    seedSigningKeys();
    // Read the ACTIVE array without changing it: an override left behind by
    // another test would otherwise hide a changed default.
    const defaults = setObligationRetryDelaysForTests([]);
    setObligationRetryDelaysForTests(defaults);
    expect(defaults, "the active delays are the unoverridden defaults").toEqual([1000, 4000, 16000]);
    const inboundId = "msg-1059-r3-default-delays";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 200);
    let faulty = true;
    setObligationCurLookupFaultForTests((id) => (id === inboundId && faulty ? "EIO" : undefined));
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      // Record each attempt's due time as it is scheduled. Attempt 3 is
      // observable after 1 s + 4 s; its own 16 s wait is not consumed.
      const seen = new Map<number, { dueAt: number; observedAt: number }>();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !seen.has(3)) {
        const entry = obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
        if (entry && !seen.has(entry.attempt)) seen.set(entry.attempt, { dueAt: entry.dueAt, observedAt: Date.now() });
        await sleep(20);
      }
      faulty = false;
      const expected = [1000, 4000, 16000];
      for (let attempt = 1; attempt <= 3; attempt++) {
        const entry = seen.get(attempt);
        expect(entry, `attempt ${attempt} was scheduled`).toBeDefined();
        const remaining = entry!.dueAt - entry!.observedAt;
        expect(remaining, `attempt ${attempt} uses the active ${expected[attempt - 1]} ms delay`)
          .toBeGreaterThanOrEqual(expected[attempt - 1] - 250);
        expect(remaining, `attempt ${attempt} uses the active ${expected[attempt - 1]} ms delay`)
          .toBeLessThanOrEqual(expected[attempt - 1] + 250);
      }
    } finally {
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r2 a throwing retry is logged and the next bounded attempt runs", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r2-retry-throws";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    setObligationCurLookupFaultForTests((id) => (id === inboundId ? "EIO" : undefined));
    setObligationRetryFaultForTests((id, attempt) => (id === inboundId && attempt === 1 ? "injected-retry-throw" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([50, 60, 70]);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-failed") && line.includes("injected-retry-throw")), 15000),
        "the throwing retry is logged",
      ).toBe(true);
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "the next bounded attempts ran",
      ).toBe(true);
      expect(warnings.filter((line) => line.includes("obligation-retry-exhausted"))).toHaveLength(1);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      setObligationRetryFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r3 an arm blocked by the REAL mail lock re-arms a null deadline and settles only at that deadline", async () => {
    seedSigningKeys();
    const warnings: string[] = [];
    const prevDelays = setObligationRetryDelaysForTests([300]);
    const prevDeadline = process.env.TPS_OBLIGATION_DEADLINE_MS;
    process.env.TPS_OBLIGATION_DEADLINE_MS = "1500";
    const h = await start(AGENT, SENDER, { localSender: true, warnCalls: warnings });
    const inboundId = h.inboundId;
    const obligationId = h.obligationId()!;
    let lock: ReturnType<typeof acquireMailLockSync> = null;
    try {
      try {
        lock = acquireMailLockSync(resolve(tempMailDir, AGENT), { timeoutMs: 0 });
        expect(lock, "the mailbox lock is held").not.toBeNull();
        h.settle();
        expect(
          await pollUntil(() => obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 15000),
          "a bounded retry is scheduled after the failed arm",
        ).toBe(true);
        expect(
          warnings.some((line) => line.includes("dispatch failed")),
          "a held lock is not a dispatch-failed verdict",
        ).toBe(false);
      } finally {
        lock?.release();
      }
      // The record never got its deadline written (the arm failed). The retry
      // must ARM a fresh window, not parse null as a passed deadline.
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "the retry arms the deadline the failed arm could not write",
      ).toBe(true);
      await sleep(600);
      expect(obligationFile(AGENT, inboundId)?.state, "the fresh yield stays yielded inside the window").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no early nack").toHaveLength(0);
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 15000),
        "the configured deadline settles the obligation",
      ).toBe(true);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption")).toHaveLength(1);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      if (prevDeadline === undefined) delete process.env.TPS_OBLIGATION_DEADLINE_MS;
      else process.env.TPS_OBLIGATION_DEADLINE_MS = prevDeadline;
      await h.stop();
    }
  }, 40000);

  it("1059 r2 a retry whose failure write throws is logged once and not retried again", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r2-write-failed";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    let faulty = true;
    setObligationCurLookupFaultForTests((id) => (id === inboundId && faulty ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([600]);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 15000),
        "the first retry is scheduled",
      ).toBe(true);
      faulty = false;
      // The retry's settlement write throws (a store lock/write failure).
      setBeforeTransitionForTests((id) => {
        if (id === inboundId) throw new Error("injected store write throw");
      });
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-write-failed")), 15000),
        "the retry's store write is refused",
      ).toBe(true);
      expect(
        obligationStateForTests().retries.some((r) => r.obligationId === obligationId),
        "one attempt, no retry",
      ).toBe(false);
    } finally {
      setBeforeTransitionForTests(undefined);
    }
    try {
      await sleep(200);
      expect(obligationFile(AGENT, inboundId)?.state, "the record is left for restart").toBe("yielded");
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r2 a retry whose settle write is refused consumes exactly one next attempt", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r2-retry-refused";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    let faulty = true;
    setObligationCurLookupFaultForTests((id) => (id === inboundId && faulty ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([400, 5000, 5000]);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 15000),
        "the first retry is scheduled",
      ).toBe(true);
      faulty = false;
      // The retry's own settlement write is refused by a same-state extension.
      let injected = false;
      setBeforeTransitionForTests((id) => {
        if (id !== inboundId || injected) return;
        injected = true;
        setBeforeTransitionForTests(undefined);
        transitionObligation(tempMailDir, AGENT, inboundId, "yielded", {
          deadlineAt: new Date(Date.now() + 5000).toISOString(),
        });
      });
      expect(await pollUntil(() => injected, 15000), "the retry reached its guarded write").toBe(true);
      expect(
        await pollUntil(() => obligationStateForTests().retries.find((r) => r.obligationId === obligationId)?.attempt === 2, 15000),
        "exactly one further attempt is scheduled",
      ).toBe(true);
      await sleep(300);
      expect(
        obligationStateForTests().retries.find((r) => r.obligationId === obligationId)?.attempt,
        "the refused write is not counted twice",
      ).toBe(2);
      expect(obligationFile(AGENT, inboundId)?.state).toBe("yielded");
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      setBeforeTransitionForTests(undefined);
      await h.stop();
    }
  }, 40000);

  // ── cli#1059 round 3 ───────────────────────────────────────────────────────

  it("1059 r3 an event before the first retry due time adds no lookup, write, timer, settlement or nack", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r3-event-before-due";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    let lookups = 0;
    setObligationCurLookupFaultForTests((id) => {
      if (id !== inboundId) return undefined;
      lookups++;
      return "EIO";
    });
    const prevDelays = setObligationRetryDelaysForTests([5000]);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 15000),
        "a retry is pending",
      ).toBe(true);
      const beforeBytes = readFileSync(resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8");
      const beforeState = obligationStateForTests();
      const beforeLookups = lookups;
      for (let i = 0; i < 3; i++) {
        capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
        await sleep(80);
      }
      expect(lookups, "the event ran no cur/ lookup").toBe(beforeLookups);
      expect(
        readFileSync(resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8"),
        "the event wrote nothing",
      ).toBe(beforeBytes);
      expect(obligationStateForTests().deadlines, "the event installed no deadline timer").toEqual(beforeState.deadlines);
      const retry = obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
      expect(retry?.attempt, "the pending attempt is unchanged").toBe(beforeState.retries.find((r) => r.obligationId === obligationId)?.attempt);
      expect(retry?.dueAt, "the pending due time stands").toBe(beforeState.retries.find((r) => r.obligationId === obligationId)?.dueAt);
      expect(obligationFile(AGENT, inboundId)?.state, "the event settled nothing").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "the event sent no nack").toHaveLength(0);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r3 an unverified cap read keeps the last verified state and does not reopen the budget", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r3-cap-unverified";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    let faulty = true;
    let lookups = 0;
    setObligationCurLookupFaultForTests((id) => {
      if (id !== inboundId || !faulty) return undefined;
      lookups++;
      return "EIO";
    });
    const prevDelays = setObligationRetryDelaysForTests([200, 200, 200]);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const backup = `${path}.bak`;
    let swapped = false;
    try {
      expect(
        await pollUntil(() => {
          const entry = obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
          return entry?.attempt === 3 && !entry.exhausted && entry.dueAt !== Number.POSITIVE_INFINITY;
        }, 15000),
        "the third attempt is scheduled",
      ).toBe(true);
      const beforeBytes = readFileSync(path, "utf-8");
      // The cap's record read is unverified (a directory at the path fails for
      // every uid); the last verified state must survive it.
      renameSync(path, backup);
      mkdirSync(path);
      swapped = true;
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "the cap is reached with an unverified read",
      ).toBe(true);
      rmdirSync(path);
      renameSync(backup, path);
      swapped = false;
      const exhausted = obligationStateForTests().retries.find((r) => r.obligationId === obligationId)!;
      expect(exhausted.exhausted).toBe(true);
      expect(exhausted.state, "the last verified state survives the unverified cap read").toBe("yielded");
      const beforeLookups = lookups;
      faulty = false;
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      await sleep(600);
      expect(lookups, "the event runs no lookup").toBe(beforeLookups);
      expect(readFileSync(path, "utf-8"), "the event writes nothing").toBe(beforeBytes);
      expect(obligationFile(AGENT, inboundId)?.state, "the event settles nothing").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "the event sends no nack").toHaveLength(0);
    } finally {
      if (swapped) {
        try { rmdirSync(path); } catch { /* best effort */ }
        try { renameSync(backup, path); } catch { /* best effort */ }
      }
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r3 an event after exhaustion with the fault cleared neither reopens the budget nor settles", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r3-exhausted-event-clear";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    let faulty = true;
    let lookups = 0;
    setObligationCurLookupFaultForTests((id) => {
      if (id !== inboundId || !faulty) return undefined;
      lookups++;
      return "EIO";
    });
    const prevDelays = setObligationRetryDelaysForTests([50, 60, 70]);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "the cap is reached",
      ).toBe(true);
      const exhausted = obligationStateForTests().retries.find((r) => r.obligationId === obligationId)!;
      expect(exhausted.exhausted).toBe(true);
      expect(exhausted.state, "the last verified state is remembered through the cap").toBe("yielded");
      const beforeBytes = readFileSync(resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8");
      const beforeLookups = lookups;
      faulty = false;
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      await sleep(600);
      expect(lookups, "the cleared fault is never looked up again").toBe(beforeLookups);
      expect(
        readFileSync(resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8"),
        "the event wrote nothing",
      ).toBe(beforeBytes);
      const after = obligationStateForTests().retries.find((r) => r.obligationId === obligationId)!;
      expect(after.exhausted, "the budget stays exhausted").toBe(true);
      expect(after.attempt).toBe(3);
      expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), "no deadline was armed").toBe(false);
      expect(obligationFile(AGENT, inboundId)?.state, "the event settled nothing").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "the event sent no nack").toHaveLength(0);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r3 a held quarantine scan does not fail or nack a record whose reply was replaced", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r3-quarantine-binding";
    // No cur/ entry: the missing-cur path decides from the record, so the
    // attributed marker can be the only evidence for the reply it names.
    seedOrphan(inboundId, { state: "yielded", deadlineInMs: -1000 });
    const obligationId = `ob-${inboundId}`;
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const seeded = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...seeded, replyId: "reply-old" }, null, 2), "utf-8");
    const envelopeId = seeded.inboundEnvelopeId as string;
    // A metadata receipt for reply-old signed by the WRONG key keeps the scan
    // held at its verifier; the attributed malformed marker is found after it.
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const wrongKeyReply = signEnvelope(
      { v: 1, from: AGENT, to: SENDER, body: "old reply", messageId: "reply-old", timestamp: now, replyToId: envelopeId, delegationChain: chain },
      { [AGENT]: FLINT_SEED },
    );
    writeReceipt(tempMailDir, AGENT, {
      replyId: "reply-old",
      obligationId,
      replyToId: envelopeId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(wrongKeyReply),
    });
    const senderCur = resolve(tempMailDir, SENDER, "cur");
    mkdirSync(senderCur, { recursive: true });
    writeFileSync(resolve(senderCur, ".malformed-2026-05-26T00-00-00-reply-old.json"), "{not json", "utf-8");
    let gateEntered = false;
    let releaseScan: (() => void) | null = null;
    const scanGate = new Promise<void>((r) => { releaseScan = r; });
    // Once the scan is released, replace the reply in the record as the
    // settlement is about to re-read it; the malformed verdict was gathered
    // for reply-old.
    setBeforeSettleReadForTests((id) => {
      if (id !== inboundId) return;
      setBeforeSettleReadForTests(undefined);
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", {
        replyId: "reply-new",
        deadlineAt: new Date(Date.now() + 60000).toISOString(),
      });
    });
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        gateEntered = true;
        await scanGate;
      },
    });
    try {
      expect(await pollUntil(() => gateEntered, 15000), "the missing-cur scan is held at its verifier").toBe(true);
      releaseScan!();
      await sleep(500);
      expect(obligationFile(AGENT, inboundId)?.state, "the old reply's quarantine does not fail the new reply").toBe("yielded");
      expect(obligationFile(AGENT, inboundId)?.replyId).toBe("reply-new");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent for the new reply").toHaveLength(0);
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
        "the fresh record is left to its own deadline",
      ).toBe(true);
    } finally {
      // Release a held scan before teardown waits on the startup promise.
      releaseScan?.();
      setBeforeSettleReadForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r3 an invalid-revision failed record sends no nack at startup", async () => {
    seedSigningKeys();
    const agentId = "agent-a";
    const inboundId = "msg-1059-r3-invalid-rev-nack";
    const reason = "receipt-malformed";
    const curDir = resolve(tempMailDir, agentId, "cur");
    const obligationsDir = resolve(tempMailDir, agentId, ".obligations");
    mkdirSync(curDir, { recursive: true });
    mkdirSync(obligationsDir, { recursive: true });
    writeFileSync(
      resolve(curDir, `2026-05-26T00-00-00-${inboundId}.json`),
      JSON.stringify({
        id: inboundId,
        from: "flint",
        to: agentId,
        body: buildSignedBody("flint", agentId, "x", FLINT_SEED),
        timestamp: new Date().toISOString(),
        read: false,
        nackedAt: new Date().toISOString(),
        nackReason: reason,
      }, null, 2),
      "utf-8",
    );
    const path = resolve(obligationsDir, `${inboundId}.json`);
    writeFileSync(path, JSON.stringify({
      obligationId: `ob-${inboundId}`,
      inboundId,
      inboundTimestamp: new Date().toISOString(),
      from: "flint",
      to: agentId,
      accountId: "default",
      state: "failed",
      deadlineAt: null,
      attempts: 1,
      failure: reason,
      nackPending: true,
      lastTransitionAt: new Date().toISOString(),
      revision: "3",
    }, null, 2), "utf-8");
    const flintNew = resolve(tempMailDir, "flint", "new");
    const h = await start(agentId, "flint", { localSender: true, noInbound: true });
    try {
      await sleep(600);
      expect(nackMailsIn(flintNew, reason), "an unverified record owes no mail").toHaveLength(0);
      expect(listObligations(tempMailDir, agentId), "the listing skips the invalid record").toHaveLength(0);
    } finally {
      await h.stop();
    }
  }, 20000);

  it("1059 r3 an invalid-revision terminal record is retained by the sweep", async () => {
    const agentId = "agent-a";
    const inboundId = "msg-1059-r3-invalid-rev-retention";
    const aged = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const dir = resolve(tempMailDir, agentId, ".obligations");
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `${inboundId}.json`);
    writeFileSync(path, JSON.stringify({
      obligationId: `ob-${inboundId}`,
      inboundId,
      inboundTimestamp: aged,
      from: "flint",
      to: agentId,
      accountId: "default",
      state: "unconfirmed",
      deadlineAt: null,
      attempts: 1,
      lastTransitionAt: aged,
      revision: "3",
    }, null, 2), "utf-8");
    const swept = sweepTerminalObligations(tempMailDir, agentId, 7, { info: () => {}, warn: () => {} });
    expect(swept.removed, "no invalid record is deleted").toBe(0);
    expect(swept.unreadable, "it is counted as unreadable").toBe(1);
    expect(obligationFile(agentId, inboundId), "the record is retained").toBeTruthy();
  });

  it("1059 r3 a missing-cur terminal decision re-arms when the record moves under it", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r3-missing-cur-move";
    // No cur/ entry: the missing-cur path decides from the record.
    seedOrphan(inboundId, { state: "yielded", deadlineInMs: -1000 });
    let injected = false;
    // The move lands between the post-scan fresh read and the settlement's own
    // re-read: without the caller snapshot binding, the old deadline verdict
    // would fail the extended record.
    setBeforeSettleReadForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      setBeforeSettleReadForTests(undefined);
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", {
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
      });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(await pollUntil(() => injected, 15000), "the terminal decision reached its record re-read").toBe(true);
      await sleep(400);
      expect(obligationFile(AGENT, inboundId)?.state, "the moved record is not failed").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === `ob-${inboundId}`),
        "the fresh deadline is armed",
      ).toBe(true);
    } finally {
      setBeforeSettleReadForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r7 a missing-cur receipt-none verdict does not fail a reply replaced during the scan", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r7-missing-cur-replace";
    // No cur/ entry: the missing-cur path decides from the record. The record
    // names reply-old and its deadline has passed, so the old reply's "no
    // receipt" scan is the evidence the terminal branch acts on.
    seedOrphan(inboundId, { state: "yielded", deadlineInMs: -1000 });
    const obligationId = `ob-${inboundId}`;
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const seeded = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...seeded, replyId: "reply-old" }, null, 2), "utf-8");
    const envelopeId = seeded.inboundEnvelopeId as string;
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    // A receipt for reply-old signed by the WRONG key holds the scan at its
    // verifier, so the replacement lands while the scan is in flight.
    writeReceipt(tempMailDir, AGENT, {
      replyId: "reply-old",
      obligationId,
      replyToId: envelopeId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(signEnvelope(
        { v: 1, from: AGENT, to: SENDER, body: "old reply", messageId: "reply-old", timestamp: now, replyToId: envelopeId, delegationChain: chain },
        { [AGENT]: FLINT_SEED },
      )),
    });
    let gateEntered = false;
    let releaseScan: (() => void) | null = null;
    const scanGate = new Promise<void>((r) => { releaseScan = r; });
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        gateEntered = true;
        await scanGate;
      },
    });
    try {
      expect(await pollUntil(() => gateEntered, 15000), "the missing-cur scan is held at its verifier").toBe(true);
      // The replacement lands after the scan read its snapshot: it names
      // reply-new, whose VALID receipt is on disk.
      writeReceipt(tempMailDir, AGENT, {
        replyId: "reply-new",
        obligationId,
        replyToId: envelopeId,
        route: "local",
        ts: now,
        signedReply: JSON.stringify(signEnvelope(
          { v: 1, from: AGENT, to: SENDER, body: "new reply", messageId: "reply-new", timestamp: now, replyToId: envelopeId, delegationChain: chain },
          { [AGENT]: ANVIL_SEED },
        )),
      });
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", { replyId: "reply-new" });
      releaseScan!();
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "acked", 5000),
        "the replacement is judged on its own receipt",
      ).toBe(true);
      expect(obligationFile(AGENT, inboundId)?.replyId).toBe("reply-new");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent for the replacement").toHaveLength(0);
    } finally {
      // Release a held scan before teardown waits on the startup promise.
      releaseScan?.();
      setBeforeSettleReadForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r3 an old nack stamp does not fail a record that moved to posted during its internal-inbound await", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r3-stamp-moved";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 60000);
    const curPath = resolve(tempMailDir, AGENT, "cur", `2026-05-26T00-00-00-${inboundId}.json`);
    const cur = JSON.parse(readFileSync(curPath, "utf-8"));
    writeFileSync(curPath, JSON.stringify({ ...cur, nackedAt: new Date().toISOString(), nackReason: "old-stamp" }, null, 2), "utf-8");
    // The gap is between the settlement's internal-inbound await and its
    // re-read; the record commits there.
    let injected = false;
    setBeforeSettleReadForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      setBeforeSettleReadForTests(undefined);
      transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "reply-posted" });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(await pollUntil(() => injected, 15000), "the settlement reached its record re-read").toBe(true);
      await sleep(400);
      expect(obligationFile(AGENT, inboundId)?.state, "the committed record is not failed").toBe("posted");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
      expect(
        await pollUntil(
          () => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
          5000,
        ),
        "the record is left to its deadline",
      ).toBe(true);
    } finally {
      setBeforeSettleReadForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r3 a pre-commit failure does not fail a record that posted during its internal-inbound await", async () => {
    seedSigningKeys();
    const h = await start(AGENT, SENDER, { localSender: true });
    const inboundId = h.inboundId;
    const obligationId = h.obligationId()!;
    let injected = false;
    setBeforeSettleReadForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      setBeforeSettleReadForTests(undefined);
      transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "reply-posted" });
    });
    try {
      h.skip("empty");
      h.settle();
      expect(await pollUntil(() => injected, 15000), "the pre-commit verdict reached its record re-read").toBe(true);
      await sleep(400);
      expect(obligationFile(AGENT, inboundId)?.state, "the committed record is not failed").toBe("posted");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
      expect(
        await pollUntil(
          () => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
          5000,
        ),
        "the record is left to its deadline",
      ).toBe(true);
    } finally {
      setBeforeSettleReadForTests(undefined);
      await h.stop();
    }
  }, 40000);
  // ── cli#1059 round 4 ───────────────────────────────────────────────────────

  it("1059 r4 an event during a running retry starts no second attempt or scan", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r4-running-serialized";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    const envelopeId = obligationFile(AGENT, inboundId)?.inboundEnvelopeId as string;
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    writeReceipt(tempMailDir, AGENT, {
      replyId: "reply-r4-serial",
      obligationId,
      replyToId: envelopeId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(signEnvelope(
        { v: 1, from: AGENT, to: SENDER, body: "held reply", messageId: "reply-r4-serial", timestamp: now, replyToId: envelopeId, delegationChain: chain },
        { [AGENT]: FLINT_SEED },
      )),
    });
    setObligationCurLookupFaultForTests((id) => (id === inboundId ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([200, 50, 50]);
    const warnings: string[] = [];
    let verifyCalls = 0;
    let gateEntered = false;
    let releaseScan: (() => void) | null = null;
    const scanGate = new Promise<void>((r) => { releaseScan = r; });
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      warnCalls: warnings,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        verifyCalls++;
        // Scan 1 is startup recovery and scan 2 is the fired deadline; scan 3
        // is the retry this test holds while it sends the event.
        if (verifyCalls === 3) { gateEntered = true; await scanGate; }
      },
    });
    try {
      expect(await pollUntil(() => gateEntered, 15000), "the retry scan is held at its verifier").toBe(true);
      const scansWhileHeld = verifyCalls;
      for (let i = 0; i < 3; i++) {
        capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
        await sleep(100);
      }
      expect(verifyCalls, "the event starts no second scan while the retry runs").toBe(scansWhileHeld);
      expect(
        warnings.some((line) => line.includes("obligation-retry-exhausted")),
        "no cap is reached while the running check owns the entry",
      ).toBe(false);
      releaseScan!();
      await sleep(300);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "the held check sends no nack").toHaveLength(0);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r4 an unknown baseline never reopens the budget on a readable record", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r4-unknown-baseline";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 1500);
    const prevDelays = setObligationRetryDelaysForTests([100, 100, 100]);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const backup = `${path}.bak`;
    let swapped = false;
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "startup armed the deadline",
      ).toBe(true);
      // From here every read, including the cap read, is unverified: no
      // verified state ever enters the entry.
      renameSync(path, backup);
      mkdirSync(path);
      swapped = true;
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "the cap is reached with unverified reads",
      ).toBe(true);
      const exhausted = obligationStateForTests().retries.find((r) => r.obligationId === obligationId)!;
      expect(exhausted.exhausted).toBe(true);
      expect(exhausted.state, "no verified baseline exists").toBeUndefined();
      expect(
        warnings.some((line) => line.includes("record is unresolved")),
        "an unverified cap read is reported as unresolved, not open",
      ).toBe(true);
      rmdirSync(path);
      renameSync(backup, path);
      swapped = false;
      const beforeBytes = readFileSync(path, "utf-8");
      const beforeAttempt = exhausted.attempt;
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      await sleep(500);
      const after = obligationStateForTests().retries.find((r) => r.obligationId === obligationId)!;
      expect(after.exhausted, "the same readable state is not a move").toBe(true);
      expect(after.attempt, "no new attempt is consumed").toBe(beforeAttempt);
      expect(readFileSync(path, "utf-8"), "the event writes nothing").toBe(beforeBytes);
      expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId)).toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "the event sends no nack").toHaveLength(0);
    } finally {
      if (swapped) {
        try { rmdirSync(path); } catch { /* best effort */ }
        try { renameSync(backup, path); } catch { /* best effort */ }
      }
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r4 a record deleted between the last check and the cap read cancels the retry", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r4-cap-deleted";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    setObligationCurLookupFaultForTests((id) => (id === inboundId ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([100, 100, 100]);
    const warnings: string[] = [];
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    let deleted = false;
    setBeforeRetryCapReadForTests((id) => {
      if (id !== inboundId || deleted) return;
      deleted = true;
      rmSync(path, { force: true });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(await pollUntil(() => deleted, 15000), "the cap read saw the record deleted").toBe(true);
      await sleep(200);
      expect(obligationStateForTests().retries.some((r) => r.obligationId === obligationId), "the retry is cleared, not exhausted").toBe(false);
      expect(warnings.filter((line) => line.includes("obligation-retry-exhausted"))).toHaveLength(0);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setBeforeRetryCapReadForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r4 a record settled terminally between the last check and the cap read cancels the retry", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r4-cap-terminal";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    setObligationCurLookupFaultForTests((id) => (id === inboundId ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([100, 100, 100]);
    const warnings: string[] = [];
    let settled = false;
    setBeforeRetryCapReadForTests((id) => {
      if (id !== inboundId || settled) return;
      settled = true;
      transitionObligation(tempMailDir, AGENT, inboundId, "unconfirmed", { failure: "cap-terminal-fixture" });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(await pollUntil(() => settled, 15000), "the cap read saw the terminal record").toBe(true);
      await sleep(200);
      expect(obligationFile(AGENT, inboundId)?.state).toBe("unconfirmed");
      expect(obligationStateForTests().retries.some((r) => r.obligationId === obligationId), "the retry is cleared").toBe(false);
      expect(warnings.filter((line) => line.includes("obligation-retry-exhausted"))).toHaveLength(0);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setBeforeRetryCapReadForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r4 an exhausted budget reopens only on a verified live-state move", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r4-reopen";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    let faulty = true;
    setObligationCurLookupFaultForTests((id) => (id === inboundId && faulty ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([100, 100, 100]);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "the budget is exhausted in a known state",
      ).toBe(true);
      expect(obligationFile(AGENT, inboundId)?.state).toBe("yielded");
      faulty = false;
      transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "reply-r4-reopen" });
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      expect(
        await pollUntil(() => {
          const entry = obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
          return entry !== undefined && entry.attempt === 1 && !entry.exhausted;
        }, 5000),
        "a fresh bounded attempt starts from the new state",
      ).toBe(true);
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "unconfirmed", 15000),
        "the fresh attempt settles the committed record without a nack",
      ).toBe(true);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r4 a record deleted during a pending retry cancels it with no write", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r4-pending-deleted";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    setObligationCurLookupFaultForTests((id) => (id === inboundId ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([600]);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    try {
      expect(
        await pollUntil(() => obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 15000),
        "a retry is pending",
      ).toBe(true);
      rmSync(path, { force: true });
      await sleep(900);
      expect(obligationStateForTests().retries.some((r) => r.obligationId === obligationId), "the retry is cancelled").toBe(false);
      expect(existsSync(path), "the cancelled retry writes nothing").toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r4 a record at the exact revision limit refuses its next write and keeps its bytes", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r4-at-limit";
    seedOrphan(inboundId, { state: "yielded", deadlineInMs: 60000 });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...raw, revision: Number.MAX_SAFE_INTEGER }, null, 2), "utf-8");
    expect(readObligationResult(tempMailDir, AGENT, inboundId).status, "the exact limit is still a usable revision").toBe("found");
    const before = readFileSync(path, "utf-8");
    expect(() => transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "reply-at-limit" }))
      .toThrow(/revision limit/);
    expect(() => writeObligation(tempMailDir, AGENT, { ...raw, state: "posted" })).toThrow(/revision limit/);
    expect(readFileSync(path, "utf-8"), "the record's bytes are preserved").toBe(before);
  });

  it("1059 r4 createObligation refuses an unverified existing record", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r4-create-unverified";
    seedOrphan(inboundId, { state: "yielded", deadlineInMs: 60000 });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...raw, revision: "3" }, null, 2), "utf-8");
    const before = readFileSync(path, "utf-8");
    expect(() => createObligation(tempMailDir, AGENT, () => ({ ...raw, state: "pending" })))
      .toThrow(/unverified/);
    expect(readFileSync(path, "utf-8"), "the unverified record is not overwritten").toBe(before);
  });

  it("1059 r4 a non-subscription arm against an exhausted entry arms nothing and writes nothing", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r4-non-subscription";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 60000);
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // No envelope pin: a replay carries a fresh signed envelope, and the
    // recovery gate binds the RECORD id, not the original envelope id.
    delete raw.inboundEnvelopeId;
    writeFileSync(path, JSON.stringify(raw, null, 2), "utf-8");
    setArmDeadlineFaultForTests((id) => id === inboundId);
    const prevDelays = setObligationRetryDelaysForTests([100, 100, 100]);
    const warnings: string[] = [];
    const infoCalls: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings, infoCalls });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "startup recovery exhausts the arm retries",
      ).toBe(true);
      expect(obligationStateForTests().retries.find((r) => r.obligationId === obligationId)?.exhausted).toBe(true);
      // A bypassing caller would now arm successfully; only the state machine
      // may hold the budget back.
      setArmDeadlineFaultForTests(undefined);
      const before = readFileSync(path, "utf-8");
      // A replay of the same inbound reaches reconcileObligation, whose arm is
      // NOT the yield subscription.
      const replayBody = buildSignedBody(SENDER, AGENT, "replay payload", FLINT_SEED);
      writeFileSync(
        resolve(tempMailDir, AGENT, "new", `2026-05-26T00-00-01-${inboundId}.json`),
        JSON.stringify({
          id: inboundId,
          from: SENDER,
          to: AGENT,
          body: replayBody,
          timestamp: new Date().toISOString(),
          headers: { "X-TPS-Trust": "agent", "X-TPS-Surface": "tps-mail" },
          deliveryAttempts: 0,
        }, null, 2),
        "utf-8",
      );
      expect(
        await pollUntil(() => infoCalls.some((line) => line.includes("already has obligation")), 15000),
        "the replay reaches the non-subscription reconcile path",
      ).toBe(true);
      await sleep(400);
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
        "the non-subscription caller arms no deadline",
      ).toBe(false);
      expect(readFileSync(path, "utf-8"), "the non-subscription caller writes nothing").toBe(before);
      expect(
        obligationStateForTests().retries.find((r) => r.obligationId === obligationId)?.exhausted,
        "the entry stays exhausted",
      ).toBe(true);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setArmDeadlineFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r4 a quarantine store write that throws maps to write-failed, not stale", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r4-quarantine-write-failed";
    const { obligationId } = seedOrphan(inboundId, { state: "yielded", deadlineInMs: -1000 });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...raw, replyId: "reply-old" }, null, 2), "utf-8");
    const senderCur = resolve(tempMailDir, SENDER, "cur");
    mkdirSync(senderCur, { recursive: true });
    writeFileSync(resolve(senderCur, ".malformed-2026-05-26T00-00-00-reply-old.json"), "{not json", "utf-8");
    const warnings: string[] = [];
    let thrown = false;
    setBeforeTransitionForTests((id) => {
      if (id !== inboundId || thrown) return;
      thrown = true;
      setBeforeTransitionForTests(undefined);
      throw new Error("injected store write throw");
    });
    let observed: string | undefined;
    setQuarantineOutcomeForTests((id, outcome) => { if (id === obligationId) observed = outcome; });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    const before = readFileSync(path, "utf-8");
    try {
      expect(await pollUntil(() => warnings.some((line) => line.includes("obligation-write-failed")), 15000), "the store write was refused").toBe(true);
      await sleep(300);
      expect(observed, "the quarantine maps its own outcome").toBe("write-failed");
      expect(readFileSync(path, "utf-8"), "the failed write changes nothing").toBe(before);
      expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), "no rescan is armed").toBe(false);
      expect(obligationStateForTests().retries.some((r) => r.obligationId === obligationId), "no retry is scheduled").toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setBeforeTransitionForTests(undefined);
      setQuarantineOutcomeForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r4 a quarantine with nothing to settle maps to none, not stale", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r4-quarantine-none";
    const { obligationId } = seedOrphan(inboundId, { state: "yielded", deadlineInMs: -1000 });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...raw, replyId: "reply-old" }, null, 2), "utf-8");
    const senderCur = resolve(tempMailDir, SENDER, "cur");
    mkdirSync(senderCur, { recursive: true });
    writeFileSync(resolve(senderCur, ".malformed-2026-05-26T00-00-00-reply-old.json"), "{not json", "utf-8");
    let removed = false;
    setBeforeSettleEntryForTests((id) => {
      if (id !== inboundId || removed) return;
      removed = true;
      rmSync(path, { force: true });
    });
    let observed: string | undefined;
    setQuarantineOutcomeForTests((id, outcome) => { if (id === obligationId) observed = outcome; });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(await pollUntil(() => observed !== undefined, 15000), "the quarantine reached its decision").toBe(true);
      expect(observed, "a gone record is not `stale`").toBe("none");
      await sleep(300);
      expect(existsSync(path), "nothing is written").toBe(false);
      expect(obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), "no rescan is armed").toBe(false);
      expect(obligationStateForTests().retries.some((r) => r.obligationId === obligationId), "no retry is scheduled").toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setBeforeSettleEntryForTests(undefined);
      setQuarantineOutcomeForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r6 an unknown record state is unverified: no write and no nack", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r6-unknown-state";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 800);
    const prevDelays = setObligationRetryDelaysForTests([100, 100, 100]);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "startup armed the deadline",
      ).toBe(true);
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      writeFileSync(path, JSON.stringify({ ...raw, state: "armed" }, null, 2), "utf-8");
      const corrupted = readFileSync(path, "utf-8");
      expect(
        await pollUntil(
          () => warnings.some((line) => line.includes("obligation-retry-exhausted")) || obligationFile(AGENT, inboundId)?.state !== "armed",
          15000,
        ),
        "the deadline's bounded checks end at the cap",
      ).toBe(true);
      expect(readFileSync(path, "utf-8"), "an unknown state is never written").toBe(corrupted);
      expect(obligationFile(AGENT, inboundId)?.state, "the unknown state stays as it was").toBe("armed");
      expect(readObligation(tempMailDir, AGENT, inboundId), "readObligation refuses the unknown state").toBeNull();
      expect(
        transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "r" }),
        "no transition over the unknown state",
      ).toBeNull();
      expect(readFileSync(path, "utf-8"), "the refused transition wrote nothing").toBe(corrupted);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "an unknown state never reaches the failure branch").toHaveLength(0);
      expect(readObligationResult(tempMailDir, AGENT, inboundId).status, "an unknown state is unverified").toBe("unverified");
      const exhausted = warnings.find((line) => line.includes("obligation-retry-exhausted"));
      expect(exhausted, "the cap names the unreadable error").toContain("obligation record unreadable (INVALID_RECORD)");
      expect(exhausted).not.toContain("re-check requested");
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r6 a no-op patch compares field presence and value exactly", () => {
    const inboundId = "msg-1059-r6-presence";
    seedOrphan(inboundId, { state: "yielded", deadlineInMs: 60000 });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const startRev = obligationFile(AGENT, inboundId)?.revision ?? 0;

    // absent -> null is a write
    expect(transitionObligation(tempMailDir, AGENT, inboundId, "yielded", { failure: null as any })?.revision)
      .toBe(startRev + 1);
    expect(obligationFile(AGENT, inboundId)?.failure, "the null lands").toBeNull();

    // null -> absent is a write
    const nullRev = obligationFile(AGENT, inboundId)?.revision;
    expect(transitionObligation(tempMailDir, AGENT, inboundId, "yielded", { failure: undefined })?.revision)
      .toBe(nullRev + 1);
    expect(Object.hasOwn(obligationFile(AGENT, inboundId), "failure"), "the field is removed").toBe(false);

    // absent -> absent, same value: no write
    const before = readFileSync(path, "utf-8");
    expect(transitionObligation(tempMailDir, AGENT, inboundId, "yielded", { failure: undefined })?.revision)
      .toBe(nullRev + 1);
    expect(readFileSync(path, "utf-8"), "an identical patch writes nothing").toBe(before);
  });

  it("1059 r6 a deadline check owns its entry: an arm request during its held scan writes nothing", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r6-deadline-owns";
    const { obligationId, curPath } = seedVerifiedCur(inboundId, "yielded", 1500);
    const envelopeId = obligationFile(AGENT, inboundId)?.inboundEnvelopeId as string;
    const replyId = "reply-r6-deadline-owns";
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const prevDelays = setObligationRetryDelaysForTests([8000]);
    let scans = 0;
    let gateEntered = false;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        scans++;
        if (scans === 1) { gateEntered = true; await gate; }
      },
    });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "startup armed the deadline",
      ).toBe(true);
      // The receipt is written after the arm, so only the fired deadline's scan
      // sees it (and that scan is the one held).
      writeReceipt(tempMailDir, AGENT, {
        replyId,
        obligationId,
        replyToId: envelopeId,
        route: "local",
        ts: now,
        signedReply: JSON.stringify(signEnvelope(
          { v: 1, from: AGENT, to: SENDER, body: "held reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
          { [AGENT]: ANVIL_SEED },
        )),
      });
      expect(await pollUntil(() => gateEntered, 15000), "the fired deadline is held in its scan").toBe(true);
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      writeFileSync(path, JSON.stringify({ ...raw, deadlineAt: null, revision: (raw.revision ?? 0) + 1 }, null, 2), "utf-8");
      const before = readFileSync(path, "utf-8");
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      await sleep(300);
      expect(readFileSync(path, "utf-8"), "the arm request writes nothing while the deadline owns the entry").toBe(before);
      expect(scans, "the arm request starts no second scan").toBe(1);
      expect(
        obligationStateForTests().retries.some((r) => r.obligationId === obligationId && r.exhausted),
        "no cap is reached",
      ).toBe(false);
      release!();
      await sleep(500);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
      expect(obligationFile(AGENT, inboundId)?.state, "the decision re-arms instead of settling a null deadline").toBe("yielded");
      expect(existsSync(curPath), "the inbound is untouched").toBe(true);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r6 a deadline check owns its entry: a retry cannot settle while its scan is held", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r6-deadline-serial";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 1500);
    const envelopeId = obligationFile(AGENT, inboundId)?.inboundEnvelopeId as string;
    const replyId = "reply-r6-deadline-serial";
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const prevDelays = setObligationRetryDelaysForTests([60]);
    let scans = 0;
    let gateEntered = false;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        scans++;
        if (scans === 1) { gateEntered = true; await gate; }
      },
    });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "startup armed the deadline",
      ).toBe(true);
      writeReceipt(tempMailDir, AGENT, {
        replyId,
        obligationId,
        replyToId: envelopeId,
        route: "local",
        ts: now,
        signedReply: JSON.stringify(signEnvelope(
          { v: 1, from: AGENT, to: SENDER, body: "held reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
          { [AGENT]: ANVIL_SEED },
        )),
      });
      expect(await pollUntil(() => gateEntered, 15000), "the fired deadline is held in its scan").toBe(true);
      // An arm failure would otherwise schedule a bounded retry here.
      setArmDeadlineFaultForTests((id) => id === inboundId);
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      await sleep(400);
      expect(scans, "no retry scan starts while the deadline check runs").toBe(1);
      expect(obligationFile(AGENT, inboundId)?.state, "no retry settles the record while the deadline check runs").toBe("yielded");
      release!();
      await sleep(500);
      expect(obligationFile(AGENT, inboundId)?.state, "the deadline's own decision acks once").toBe("acked");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "an ack sends no nack").toHaveLength(0);
    } finally {
      setArmDeadlineFaultForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r6 a completion that resolves to none keeps a re-check request", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r6-complete-none";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", -1000);
    const prevDelays = setObligationRetryDelaysForTests([300]);
    const warnings: string[] = [];
    let tampered = false;
    const curPath = resolve(tempMailDir, AGENT, "cur", `2026-05-26T00-00-00-${inboundId}.json`);
    const original = readFileSync(curPath, "utf-8");
    setBeforeSettleEntryForTests((id) => {
      if (id !== inboundId || tampered) return;
      tampered = true;
      // The settlement's inbound gate will now refuse, so the decision
      // resolves to `none`; the event asks for a re-check in the same window.
      const rec = JSON.parse(readFileSync(curPath, "utf-8"));
      writeFileSync(curPath, JSON.stringify({ ...rec, from: "other-sender" }, null, 2), "utf-8");
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      setTimeout(() => { try { writeFileSync(curPath, original, "utf-8"); } catch { /* */ } }, 20);
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 10000),
        "the re-check runs against the restored inbound and settles the record",
      ).toBe(true);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "the settled failure sends its nack").toHaveLength(1);
    } finally {
      setBeforeSettleEntryForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r6 the exhaustion warning names the error carried through the running check", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r6-last-error";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", -1000);
    const prevDelays = setObligationRetryDelaysForTests([300, 400]);
    const warnings: string[] = [];
    let lookups = 0;
    setObligationCurLookupFaultForTests((id) => (id === inboundId && lookups++ < 2 ? "EIO" : undefined));
    let tampered = false;
    setBeforeSettleEntryForTests((id) => {
      if (id !== inboundId || tampered) return;
      tampered = true;
      // The last attempt resolves `none` while an event asks for a re-check; the
      // completion then reaches the cap.
      const curPath = resolve(tempMailDir, AGENT, "cur", curFiles(AGENT)[0]!);
      const rec = JSON.parse(readFileSync(curPath, "utf-8"));
      writeFileSync(curPath, JSON.stringify({ ...rec, from: "other-sender" }, null, 2), "utf-8");
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      const hit = await pollUntil(
        () => warnings.some((line) => line.includes("obligation-retry-exhausted")),
        15000,
      );
      expect(hit, "the cap is reached").toBe(true);
      const line = warnings.find((l) => l.includes("obligation-retry-exhausted"))!;
      expect(line, "the warning names the real last error").toContain("cur/ lookup failed (EIO)");
      expect(line).not.toContain("re-check requested");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setBeforeSettleEntryForTests(undefined);
      setObligationCurLookupFaultForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r6 a deadline-path verified read is a baseline for the reopen rule", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r6-deadline-baseline";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", -1000);
    const prevDelays = setObligationRetryDelaysForTests([0]);
    const warnings: string[] = [];
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const backup = `${path}.bak`;
    let swapped = false;
    // The deadline decision's read is verified; the record turns unreadable
    // before its settlement, so the cap's own read cannot supply the baseline.
    setBeforeSettleEntryForTests((id) => {
      if (id !== inboundId || swapped) return;
      swapped = true;
      renameSync(path, backup);
      mkdirSync(path);
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "the budget is exhausted",
      ).toBe(true);
      expect(warnings.some((line) => line.includes("record is unresolved")), "the cap read was unverified").toBe(true);
      const exhausted = warnings.find((line) => line.includes("obligation-retry-exhausted"))!;
      expect(exhausted, "the cap names the unreadable error").toContain("obligation record unreadable (");
      expect(exhausted).not.toContain("re-check requested");
      const entry = obligationStateForTests().retries.find((r) => r.obligationId === obligationId)!;
      expect(entry.exhausted).toBe(true);
      expect(entry.state, "the deadline path's verified read is the baseline").toBe("yielded");
      rmdirSync(path);
      renameSync(backup, path);
      swapped = false;
      expect(transitionObligation(tempMailDir, AGENT, inboundId, "posted", { replyId: "reply-r6-baseline" })?.state).toBe("posted");
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      const reopened = obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
      expect(reopened?.exhausted, "a verified live-state move reopens the budget").toBe(false);
      expect(reopened?.attempt, "a fresh attempt starts").toBe(1);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "exhaustion sent no nack").toHaveLength(0);
    } finally {
      if (swapped) {
        try { rmdirSync(path); } catch { /* */ }
        try { renameSync(backup, path); } catch { /* */ }
      }
      setBeforeSettleEntryForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r6 a record gone at attempt 1 cancels the budget there, not at the cap", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r6-attempt-cancel";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 600000);
    const prevDelays = setObligationRetryDelaysForTests([300, 3000, 3000]);
    const warnings: string[] = [];
    // The startup arm fails once, leaving attempt 1 pending and no armed timer.
    let armFaults = 1;
    setArmDeadlineFaultForTests((id) => id === inboundId && armFaults-- > 0);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    try {
      expect(
        await pollUntil(() => obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 15000),
        "the refused startup arm scheduled attempt 1",
      ).toBe(true);
      rmSync(path, { force: true });
      expect(
        await pollUntil(() => !obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 1500),
        "the missing record cancels the budget at attempt 1",
      ).toBe(true);
      expect(warnings.filter((line) => line.includes("obligation-retry-failed"))).toHaveLength(0);
      expect(warnings.filter((line) => line.includes("obligation-retry-exhausted"))).toHaveLength(0);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setArmDeadlineFaultForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r8 a deadline whose failure write throws does not retry after an event", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r8-deadline-write-failed";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 1500);
    const prevDelays = setObligationRetryDelaysForTests([80]);
    const warnings: string[] = [];
    let writeThrows = false;
    let eventFired = false;
    setBeforeTransitionForTests((id) => {
      if (id === inboundId && writeThrows) throw new Error("injected store write throw");
    });
    setBeforeSettleReadForTests((id) => {
      if (id !== inboundId || eventFired) return;
      eventFired = true;
      // The settlement's store write now throws, and an event lands in the same
      // window: the running check would otherwise hand a re-check to a retry.
      writeThrows = true;
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-write-failed")), 15000),
        "the deadline's store write threw",
      ).toBe(true);
      expect(eventFired, "an event landed during the deadline check").toBe(true);
      await sleep(500);
      expect(
        obligationStateForTests().retries.some((r) => r.obligationId === obligationId),
        "a thrown store write ends the budget",
      ).toBe(false);
      expect(
        warnings.filter((line) => line.includes("obligation-write-failed")),
        "the single attempt is not retried",
      ).toHaveLength(1);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
    } finally {
      setBeforeSettleReadForTests(undefined);
      setBeforeTransitionForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r9 a deadline whose ack write throws does not retry it", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r9-deadline-ack-write-failed";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 3000);
    const envelopeId = obligationFile(AGENT, inboundId)?.inboundEnvelopeId as string;
    const replyId = "reply-r9-ack-write-failed";
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const prevDelays = setObligationRetryDelaysForTests([80]);
    const warnings: string[] = [];
    let writeThrows = false;
    let ackThrows = 0;
    setBeforeTransitionForTests((id, next) => {
      if (id !== inboundId || !writeThrows) return;
      // Count the ack transition only. A deadline timer can fire slightly
      // before `deadlineAt` (timer rounding); the deadline path then re-arms
      // instead of settling, and that re-arm is a different write.
      if (next !== "acked") return;
      ackThrows++;
      throw new Error("injected ack write throw");
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "startup armed the deadline",
      ).toBe(true);
      // The receipt is written after the arm, so only the fired deadline's scan
      // finds it, and its ack transition is the write that throws.
      writeReceipt(tempMailDir, AGENT, {
        replyId,
        obligationId,
        replyToId: envelopeId,
        route: "local",
        ts: now,
        signedReply: JSON.stringify(signEnvelope(
          { v: 1, from: AGENT, to: SENDER, body: "acked reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
          { [AGENT]: ANVIL_SEED },
        )),
      });
      writeThrows = true;
      expect(await pollUntil(() => ackThrows > 0, 15000), "the deadline's ack write threw").toBe(true);
      // The sequence ends when the write-failed outcome has cleared the retry
      // entry: wait for that event, not a fixed sleep.
      expect(
        await pollUntil(
          () => warnings.some((line) => line.includes("could not record the ack")) &&
            !obligationStateForTests().retries.some((r) => r.obligationId === obligationId) &&
            !obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
          15000,
        ),
        "the ack attempt ended and left no retry or deadline",
      ).toBe(true);
      expect(ackThrows, "the ack write is attempted once").toBe(1);
      expect(
        obligationStateForTests().retries.some((r) => r.obligationId === obligationId),
        "a thrown ack write ends the budget",
      ).toBe(false);
      expect(
        warnings.filter((line) => line.includes("obligation-write-failed") && line.includes("could not record the ack")),
        "logged once by name",
      ).toHaveLength(1);
      expect(warnings.filter((line) => line.includes("obligation-retry-failed"))).toHaveLength(0);
      expect(obligationFile(AGENT, inboundId)?.state, "the record keeps its state").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
    } finally {
      setBeforeTransitionForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r10 a deadline whose unconfirmed write throws does not retry after an event", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r10-deadline-unconfirmed-write-failed";
    const { obligationId } = seedVerifiedCur(inboundId, "delivering", 1500);
    const prevDelays = setObligationRetryDelaysForTests([80]);
    const warnings: string[] = [];
    let writeThrows = false;
    let eventFired = false;
    setBeforeTransitionForTests((id) => {
      if (id === inboundId && writeThrows) throw new Error("injected store write throw");
    });
    setBeforeSettleReadForTests((id) => {
      if (id !== inboundId || eventFired) return;
      eventFired = true;
      // The committed record's unconfirmed write now throws, and an event lands
      // in the same window.
      writeThrows = true;
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("could not record the unconfirmed outcome")), 15000),
        "the deadline's unconfirmed write threw",
      ).toBe(true);
      expect(eventFired, "an event landed during the deadline check").toBe(true);
      await sleep(500);
      expect(
        obligationStateForTests().retries.some((r) => r.obligationId === obligationId),
        "a thrown unconfirmed write ends the budget",
      ).toBe(false);
      expect(
        warnings.filter((line) => line.includes("obligation-write-failed")),
        "the single attempt is not retried",
      ).toHaveLength(1);
      expect(obligationFile(AGENT, inboundId)?.state, "the record keeps its state").toBe("delivering");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
    } finally {
      setBeforeSettleReadForTests(undefined);
      setBeforeTransitionForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r10 an ack expecting one reply is refused at the same revision when the record names another", () => {
    const inboundId = "msg-1059-r10-expect-reply";
    seedOrphan(inboundId, { state: "posted", deadlineInMs: 60000, armed: true });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...raw, replyId: "reply-r10-new" }, null, 2), "utf-8");
    const before = readFileSync(path, "utf-8");
    expect(
      transitionObligation(tempMailDir, AGENT, inboundId, "acked", {}, undefined, {
        from: "posted",
        revision: raw.revision,
        replyId: "reply-r10-old",
      }),
      "an ack expecting reply-r10-old is refused",
    ).toBeNull();
    expect(readFileSync(path, "utf-8"), "the refused ack wrote nothing").toBe(before);
    expect(
      transitionObligation(tempMailDir, AGENT, inboundId, "acked", {}, undefined, {
        from: "posted",
        revision: raw.revision,
        replyId: "reply-r10-new",
      })?.state,
      "the same ack expecting the reply the record names lands",
    ).toBe("acked");
  });

  it("1059 r10 a deadline settlement is refused when deadlineAt moved at the same revision", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r10-same-rev-deadline";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 1500);
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const extended = new Date(Date.now() + 60000).toISOString();
    let injected = false;
    setBeforeSettleReadForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      // A writer that keeps the revision extends the deadline between the
      // decision and its write.
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      writeFileSync(path, JSON.stringify({ ...raw, deadlineAt: extended }, null, 2), "utf-8");
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(await pollUntil(() => injected, 15000), "the deadline settlement reached its record re-read").toBe(true);
      await sleep(400);
      expect(obligationFile(AGENT, inboundId)?.state, "the extended record is not failed").toBe("yielded");
      expect(obligationFile(AGENT, inboundId)?.deadlineAt, "the extension stands").toBe(extended);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no early nack").toHaveLength(0);
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 5000),
        "the fresh record's deadline is armed",
      ).toBe(true);
    } finally {
      setBeforeSettleReadForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r10 a deadline settlement is refused when replyId moved at the same revision", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r10-same-rev-reply";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 1500);
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const seeded = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...seeded, replyId: "reply-r10-old" }, null, 2), "utf-8");
    const envelopeId = seeded.inboundEnvelopeId as string;
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    let injected = false;
    setBeforeSettleReadForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      // A writer that keeps the revision replaces the reply, and the
      // replacement carries its own receipt.
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      writeFileSync(path, JSON.stringify({ ...raw, replyId: "reply-r10-new" }, null, 2), "utf-8");
      writeReceipt(tempMailDir, AGENT, {
        replyId: "reply-r10-new",
        obligationId,
        replyToId: envelopeId,
        route: "local",
        ts: now,
        signedReply: JSON.stringify(signEnvelope(
          { v: 1, from: AGENT, to: SENDER, body: "new reply", messageId: "reply-r10-new", timestamp: now, replyToId: envelopeId, delegationChain: chain },
          { [AGENT]: ANVIL_SEED },
        )),
      });
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(await pollUntil(() => injected, 15000), "the deadline settlement reached its record re-read").toBe(true);
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state !== "yielded", 15000),
        "the fresh record is settled",
      ).toBe(true);
      expect(obligationFile(AGENT, inboundId)?.state, "the replacement is acked on its own receipt").toBe("acked");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "the old reply's verdict sends no nack").toHaveLength(0);
    } finally {
      setBeforeSettleReadForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r10 an old nack stamp is refused when the state moved at the same revision", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r10-same-rev-state";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 60000);
    const curPath = resolve(tempMailDir, AGENT, "cur", `2026-05-26T00-00-00-${inboundId}.json`);
    const cur = JSON.parse(readFileSync(curPath, "utf-8"));
    writeFileSync(curPath, JSON.stringify({ ...cur, nackedAt: new Date().toISOString(), nackReason: "old-stamp" }, null, 2), "utf-8");
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    let injected = false;
    setBeforeSettleReadForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      // The record commits through a writer that keeps the revision.
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      writeFileSync(path, JSON.stringify({ ...raw, state: "posted" }, null, 2), "utf-8");
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(await pollUntil(() => injected, 15000), "the settlement reached its record re-read").toBe(true);
      await sleep(400);
      expect(obligationFile(AGENT, inboundId)?.state, "the committed record is not failed").toBe("posted");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 5000),
        "the record is left to its deadline",
      ).toBe(true);
    } finally {
      setBeforeSettleReadForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r10 a later check that finds the record terminal or gone releases an exhausted budget", async () => {
    seedSigningKeys();
    const terminalId = "msg-1059-r10-release-terminal";
    const goneId = "msg-1059-r10-release-gone";
    const obligationIds: Record<string, string> = {};
    for (const inboundId of [terminalId, goneId]) {
      obligationIds[inboundId] = seedVerifiedCur(inboundId, "yielded", 60000).obligationId;
      const p = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      // No envelope pin: a replay carries a fresh signed envelope (as in the r4
      // replay test).
      delete raw.inboundEnvelopeId;
      writeFileSync(p, JSON.stringify(raw, null, 2), "utf-8");
    }
    const goneRecord = resolve(tempMailDir, AGENT, ".obligations", `${goneId}.json`);
    // A decoy receipt for the gone case: it passes the unsigned pins, so the
    // replay's scan looks up the agent's key, and its wrong signature is not
    // evidence.
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    writeReceipt(tempMailDir, AGENT, {
      replyId: "reply-r10-decoy",
      obligationId: obligationIds[goneId]!,
      replyToId: goneId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(signEnvelope(
        { v: 1, from: AGENT, to: SENDER, body: "decoy", messageId: "reply-r10-decoy", timestamp: now, replyToId: goneId, delegationChain: chain },
        { [AGENT]: FLINT_SEED },
      )),
    });
    setArmDeadlineFaultForTests((id) => id === terminalId || id === goneId);
    const prevDelays = setObligationRetryDelaysForTests([100, 100, 100]);
    const warnings: string[] = [];
    const infoCalls: string[] = [];
    let removeGone = false;
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      warnCalls: warnings,
      infoCalls,
      beforeVerify: async (name) => {
        // The record disappears during the replay's reconcile, at the decoy's
        // key lookup, which runs before that reconcile's arm check.
        if (name !== AGENT || !removeGone) return;
        if (!infoCalls.some((line) => line.includes(`inbound ${goneId} already has obligation`))) return;
        removeGone = false;
        rmSync(goneRecord, { force: true });
      },
    });
    const replay = (inboundId: string) =>
      writeFileSync(
        resolve(tempMailDir, AGENT, "new", `2026-05-26T00-00-01-${inboundId}.json`),
        JSON.stringify({
          id: inboundId,
          from: SENDER,
          to: AGENT,
          body: buildSignedBody(SENDER, AGENT, "replay payload", FLINT_SEED),
          timestamp: new Date().toISOString(),
          headers: { "X-TPS-Trust": "agent", "X-TPS-Surface": "tps-mail" },
          deliveryAttempts: 0,
        }, null, 2),
        "utf-8",
      );
    const entry = (inboundId: string) =>
      obligationStateForTests().retries.find((r) => r.obligationId === obligationIds[inboundId]);
    try {
      expect(
        await pollUntil(() => entry(terminalId)?.exhausted === true && entry(goneId)?.exhausted === true, 15000),
        "startup recovery exhausts both budgets",
      ).toBe(true);
      setArmDeadlineFaultForTests(undefined);
      expect(transitionObligation(tempMailDir, AGENT, terminalId, "acked", {})?.state).toBe("acked");
      replay(terminalId);
      expect(
        await pollUntil(() => infoCalls.some((line) => line.includes(`inbound ${terminalId} already has obligation`)), 15000),
        "the replay reaches the non-subscription reconcile path",
      ).toBe(true);
      expect(
        await pollUntil(() => entry(terminalId) === undefined, 3000),
        "a terminal record releases the exhausted budget",
      ).toBe(true);
      removeGone = true;
      replay(goneId);
      expect(
        await pollUntil(() => infoCalls.some((line) => line.includes(`inbound ${goneId} already has obligation`)), 15000),
        "the second replay reaches the non-subscription reconcile path",
      ).toBe(true);
      expect(
        await pollUntil(() => entry(goneId) === undefined, 3000),
        "a missing record releases the exhausted budget",
      ).toBe(true);
      expect(removeGone, "the record was removed during that reconcile").toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"))).toHaveLength(0);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setArmDeadlineFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r10 an unparseable deadlineAt arms a fresh window and settles only at that deadline", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r10-unparseable-deadline";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 60000);
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...raw, deadlineAt: "not-a-date" }, null, 2), "utf-8");
    const prevDeadline = process.env.TPS_OBLIGATION_DEADLINE_MS;
    process.env.TPS_OBLIGATION_DEADLINE_MS = "1500";
    const startedAt = Date.now();
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "startup arms the deadline",
      ).toBe(true);
      const armedAt = Date.parse(obligationFile(AGENT, inboundId)?.deadlineAt);
      expect(Number.isFinite(armedAt), "the unparseable deadline is replaced").toBe(true);
      expect(armedAt, "by a fresh window").toBeGreaterThan(startedAt);
      await sleep(600);
      expect(obligationFile(AGENT, inboundId)?.state, "the record stays yielded inside the window").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no early nack").toHaveLength(0);
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 15000),
        "the fresh deadline settles the obligation",
      ).toBe(true);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption")).toHaveLength(1);
    } finally {
      if (prevDeadline === undefined) delete process.env.TPS_OBLIGATION_DEADLINE_MS;
      else process.env.TPS_OBLIGATION_DEADLINE_MS = prevDeadline;
      await h.stop();
    }
  }, 40000);

  it("1059 r9 a stale retry does not settle or release a replacement check's entry", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r9-stale-retry-owns";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 600000);
    const envelopeId = obligationFile(AGENT, inboundId)?.inboundEnvelopeId as string;
    const replyId = "reply-r9-stale-retry-owns";
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    // The startup arm fails, so startup schedules the first bounded attempt.
    let armFault = true;
    setArmDeadlineFaultForTests((id) => id === inboundId && armFault);
    const prevDelays = setObligationRetryDelaysForTests([1200, 1200, 1200]);
    const infoCalls: string[] = [];
    let holdNextScan = false;
    const gates: { release: () => void }[] = [];
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      infoCalls,
      beforeVerify: async (name) => {
        if (name !== AGENT || !holdNextScan) return;
        holdNextScan = false;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        gates.push({ release });
        await gate;
      },
    });
    const entryFor = () => obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
    try {
      expect(
        await pollUntil(() => entryFor()?.attempt === 1 && entryFor()?.dueAt !== Number.POSITIVE_INFINITY, 15000),
        "the refused startup arm scheduled the first bounded attempt",
      ).toBe(true);
      // The receipt lands while that attempt waits, and the record's deadline is
      // now past, so its scan is the next AGENT verification and is held there.
      writeReceipt(tempMailDir, AGENT, {
        replyId,
        obligationId,
        replyToId: envelopeId,
        route: "local",
        ts: now,
        signedReply: JSON.stringify(signEnvelope(
          { v: 1, from: AGENT, to: SENDER, body: "held reply", messageId: replyId, timestamp: now, replyToId: envelopeId, delegationChain: chain },
          { [AGENT]: ANVIL_SEED },
        )),
      });
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", {
        deadlineAt: new Date(Date.now() - 1000).toISOString(),
      });
      armFault = false;
      holdNextScan = true;
      expect(await pollUntil(() => gates.length === 1, 15000), "the retry is held in its receipt scan").toBe(true);
      const before = readFileSync(path, "utf-8");
      // The retry state is dropped while the check awaits its scan: it no
      // longer owns the entry.
      expect(releaseObligationRetryForTests(obligationId), "the running entry is released").toBe(true);
      expect(entryFor(), "no entry remains").toBeUndefined();
      // A fired deadline claims the entry and is held in its own receipt scan.
      holdNextScan = true;
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      expect(await pollUntil(() => gates.length === 2, 15000), "the deadline check is held in its scan").toBe(true);
      expect(entryFor()?.attempt, "the deadline check owns the entry now").toBe(0);
      // The deadline check loses its entry too, and an arm failure schedules the
      // next bounded attempt, which claims the entry while both scans stay held.
      expect(releaseObligationRetryForTests(obligationId), "the deadline check's entry is released").toBe(true);
      setObligationRetryDelaysForTests([0, 400, 400]);
      armFault = true;
      holdNextScan = true;
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      expect(await pollUntil(() => gates.length === 3, 15000), "the next bounded attempt claims the entry").toBe(true);
      expect(entryFor()?.attempt, "the bounded attempt owns the entry").toBe(1);
      gates[0]!.release();
      await sleep(400);
      expect(readFileSync(path, "utf-8"), "the stale retry writes nothing").toBe(before);
      expect(entryFor()?.attempt, "the stale retry releases no replacement").toBe(1);
      gates[1]!.release();
      await sleep(400);
      expect(readFileSync(path, "utf-8"), "the stale deadline check writes nothing").toBe(before);
      expect(entryFor()?.attempt, "the stale deadline check releases no replacement").toBe(1);
      gates[2]!.release();
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "acked", 15000),
        "the surviving check acks on the receipt",
      ).toBe(true);
      expect(infoCalls.filter((line) => line.includes("tps-mail: acked")).length, "the record is acked once").toBe(1);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
      expect(await pollUntil(() => entryFor() === undefined, 3000), "the retry state is released").toBe(true);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setArmDeadlineFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r11 a stale retry that throws after its await leaves the replacement entry and its outcome intact", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r11-stale-retry-throw";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 600000);
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    // The startup arm fails, so startup schedules the first bounded attempt.
    let armFault = true;
    setArmDeadlineFaultForTests((id) => id === inboundId && armFault);
    const prevDelays = setObligationRetryDelaysForTests([1200, 1200, 1200]);
    const warnings: string[] = [];
    let holdNextInboundVerify = false;
    const gates: { release: () => void }[] = [];
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      warnCalls: warnings,
      beforeVerify: async (name) => {
        if (name !== SENDER || !holdNextInboundVerify) return;
        holdNextInboundVerify = false;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        gates.push({ release });
        await gate;
      },
    });
    const entryFor = () => obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
    try {
      expect(
        await pollUntil(() => entryFor()?.attempt === 1 && entryFor()?.dueAt !== Number.POSITIVE_INFINITY, 15000),
        "the refused startup arm scheduled the first bounded attempt",
      ).toBe(true);
      // The deadline moves into the past, so this attempt settles, and its inbound
      // verification is held.
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", {
        deadlineAt: new Date(Date.now() - 1000).toISOString(),
      });
      armFault = false;
      holdNextInboundVerify = true;
      expect(await pollUntil(() => gates.length === 1, 15000), "the retry is held at its inbound verification").toBe(true);
      // The retry state is dropped while the check awaits: it no longer owns the
      // entry.
      expect(releaseObligationRetryForTests(obligationId), "the running entry is released").toBe(true);
      expect(entryFor(), "no entry remains").toBeUndefined();
      // An arm failure schedules the next bounded attempt, which claims the entry
      // while the stale check stays held.
      setObligationRetryDelaysForTests([0, 400, 400]);
      armFault = true;
      holdNextInboundVerify = true;
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      expect(await pollUntil(() => gates.length === 2, 15000), "a replacement bounded attempt owns the entry").toBe(true);
      expect(entryFor()?.attempt, "the replacement attempt owns the entry").toBe(1);
      const before = readFileSync(path, "utf-8");
      // The stale check resumes from its await and throws at the record re-read.
      let settleThrows = 0;
      setBeforeSettleReadForTests((id) => {
        if (id !== inboundId) return;
        settleThrows++;
        throw new Error("injected stale settle throw");
      });
      gates[0]!.release();
      expect(await pollUntil(() => settleThrows === 1, 5000), "the stale check threw after its await").toBe(true);
      await sleep(400);
      expect(entryFor()?.attempt, "the replacement entry is not rescheduled").toBe(1);
      expect(entryFor()?.dueAt, "the replacement is still running, not replaced by a timer").toBe(Number.POSITIVE_INFINITY);
      expect(entryFor()?.exhausted, "the replacement is not exhausted").toBe(false);
      expect(warnings.filter((line) => line.includes("obligation-retry-failed")), "the stale catch logs nothing").toHaveLength(0);
      expect(readFileSync(path, "utf-8"), "the stale check writes nothing").toBe(before);
      // The replacement finishes on its own: its outcome lands.
      setBeforeSettleReadForTests(undefined);
      gates[1]!.release();
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 15000),
        "the replacement's own outcome lands",
      ).toBe(true);
      expect(
        nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption"),
        "the replacement nacks once",
      ).toHaveLength(1);
      expect(await pollUntil(() => entryFor() === undefined, 5000), "the replacement releases its own entry").toBe(true);
    } finally {
      setBeforeSettleReadForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      setArmDeadlineFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r11 a stale deadline check that throws after its await leaves the replacement entry and its outcome intact", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r11-stale-deadline-throw";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 800);
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const prevDelays = setObligationRetryDelaysForTests([1200, 1200, 1200]);
    const warnings: string[] = [];
    let holdNextInboundVerify = false;
    const gates: { release: () => void }[] = [];
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      warnCalls: warnings,
      beforeVerify: async (name) => {
        if (name !== SENDER || !holdNextInboundVerify) return;
        holdNextInboundVerify = false;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        gates.push({ release });
        await gate;
      },
    });
    const entryFor = () => obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "startup armed the deadline",
      ).toBe(true);
      holdNextInboundVerify = true;
      // The fired deadline claims the entry and is held at its inbound
      // verification.
      expect(await pollUntil(() => gates.length === 1, 15000), "the fired deadline is held at its inbound verification").toBe(true);
      expect(entryFor()?.attempt, "the deadline check owns the entry").toBe(0);
      expect(releaseObligationRetryForTests(obligationId), "the deadline check's entry is released").toBe(true);
      expect(entryFor(), "no entry remains").toBeUndefined();
      // An arm failure schedules the next bounded attempt, which claims the entry
      // while the stale deadline check stays held.
      setObligationRetryDelaysForTests([0, 400, 400]);
      setArmDeadlineFaultForTests((id) => id === inboundId);
      holdNextInboundVerify = true;
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      expect(await pollUntil(() => gates.length === 2, 15000), "a replacement bounded attempt owns the entry").toBe(true);
      expect(entryFor()?.attempt, "the replacement attempt owns the entry").toBe(1);
      const before = readFileSync(path, "utf-8");
      // The stale deadline check resumes from its await and throws at the record
      // re-read.
      let settleThrows = 0;
      setBeforeSettleReadForTests((id) => {
        if (id !== inboundId) return;
        settleThrows++;
        throw new Error("injected stale settle throw");
      });
      gates[0]!.release();
      expect(await pollUntil(() => settleThrows === 1, 5000), "the stale deadline check threw after its await").toBe(true);
      await sleep(400);
      expect(entryFor()?.attempt, "the replacement entry is not rescheduled").toBe(1);
      expect(entryFor()?.dueAt, "the replacement is still running, not replaced by a timer").toBe(Number.POSITIVE_INFINITY);
      expect(entryFor()?.exhausted, "the replacement is not exhausted").toBe(false);
      expect(warnings.filter((line) => line.includes("obligation-retry-failed")), "the stale catch logs nothing").toHaveLength(0);
      expect(readFileSync(path, "utf-8"), "the stale check writes nothing").toBe(before);
      // The replacement finishes on its own: its outcome lands.
      setBeforeSettleReadForTests(undefined);
      gates[1]!.release();
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "failed", 15000),
        "the replacement's own outcome lands",
      ).toBe(true);
      expect(
        nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption"),
        "the replacement nacks once",
      ).toHaveLength(1);
      expect(await pollUntil(() => entryFor() === undefined, 5000), "the replacement releases its own entry").toBe(true);
    } finally {
      setBeforeSettleReadForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      setArmDeadlineFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  // ── cli#1059 round 13 ────────────────────────────────────────────────────

  it("1059 r13 an arm that verified the record carries its state into the exhausted budget", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r13-arm-baseline";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 600000);
    const prevDelays = setObligationRetryDelaysForTests([0]);
    const warnings: string[] = [];
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const backup = `${path}.bak`;
    let swapped = false;
    // The arm's read verifies the record, but its write throws: the state it
    // saw must still reach the exhausted entry.
    setBeforeTransitionForTests((id) => {
      if (id === inboundId) throw new Error("injected arm write throw");
    });
    // No retry may read the record, so only the arm can supply the baseline.
    setObligationRetryFaultForTests((id) => (id === inboundId ? "injected-before-read" : undefined));
    setBeforeRetryCapReadForTests((id) => {
      if (id !== inboundId || swapped) return;
      swapped = true;
      renameSync(path, backup);
      mkdirSync(path);
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "the budget is exhausted with an unverified cap read",
      ).toBe(true);
      const entry = obligationStateForTests().retries.find((r) => r.obligationId === obligationId)!;
      expect(entry.exhausted, "the cap holds the entry").toBe(true);
      expect(entry.state, "the arm's verified state is the baseline").toBe("yielded");
    } finally {
      if (swapped) {
        try { rmdirSync(path); } catch { /* best effort */ }
        try { renameSync(backup, path); } catch { /* best effort */ }
      }
      setBeforeTransitionForTests(undefined);
      setObligationRetryFaultForTests(undefined);
      setBeforeRetryCapReadForTests(undefined);
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r13 a deadline beyond the timer limit is capped without settling early", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r13-timer-cap";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 30 * 24 * 60 * 60 * 1000);
    let armReads = 0;
    setBeforeArmReadForTests((id) => {
      if (id === inboundId) armReads++;
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "the long deadline is armed",
      ).toBe(true);
      const settled = armReads;
      await sleep(500);
      expect(armReads, "the capped timer does not fire and re-arm in a loop").toBe(settled);
      expect(obligationFile(AGENT, inboundId)?.state, "the record is not settled early").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no early nack").toHaveLength(0);
    } finally {
      setBeforeArmReadForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r13 an inbound restored during the missing-cur rescan takes the gated path", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r13-missing-cur-restored";
    const signedBody = buildSignedBody(SENDER, AGENT, "inbound payload", FLINT_SEED);
    const envelopeId = (JSON.parse(signedBody) as { messageId: string }).messageId;
    const { obligationId } = seedOrphan(inboundId, { state: "yielded", deadlineInMs: -1000, envelopeId });
    const path = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const seeded = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...seeded, replyId: "reply-old" }, null, 2), "utf-8");
    const curPath = resolve(tempMailDir, AGENT, "cur", `2026-05-26T00-00-00-${inboundId}.json`);
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    // A receipt for reply-old signed by the WRONG key holds the first scan.
    writeReceipt(tempMailDir, AGENT, {
      replyId: "reply-old",
      obligationId,
      replyToId: envelopeId,
      route: "local",
      ts: now,
      signedReply: JSON.stringify(signEnvelope(
        { v: 1, from: AGENT, to: SENDER, body: "old reply", messageId: "reply-old", timestamp: now, replyToId: envelopeId, delegationChain: chain },
        { [AGENT]: FLINT_SEED },
      )),
    });
    let scanGates = 0;
    let restored = false;
    const releases: (() => void)[] = [];
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      beforeVerify: async (name) => {
        if (name !== AGENT) return;
        scanGates += 1;
        if (scanGates === 2) {
          mkdirSync(resolve(tempMailDir, AGENT, "cur"), { recursive: true });
          writeFileSync(
            curPath,
            JSON.stringify({ id: inboundId, from: SENDER, to: AGENT, body: signedBody, timestamp: new Date().toISOString(), read: false }),
            "utf-8",
          );
          restored = true;
        }
        if (scanGates > 2) return;
        await new Promise<void>((r) => { releases[scanGates] = r; });
      },
    });
    try {
      expect(await pollUntil(() => scanGates >= 1, 15000), "the first missing-cur scan is held").toBe(true);
      writeReceipt(tempMailDir, AGENT, {
        replyId: "reply-new",
        obligationId,
        replyToId: envelopeId,
        route: "local",
        ts: now,
        signedReply: JSON.stringify(signEnvelope(
          { v: 1, from: AGENT, to: SENDER, body: "new reply", messageId: "reply-new", timestamp: now, replyToId: envelopeId, delegationChain: chain },
          { [AGENT]: ANVIL_SEED },
        )),
      });
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", { replyId: "reply-new" });
      releases[1]!();
      expect(await pollUntil(() => scanGates >= 2, 15000), "the rescan is held").toBe(true);
      expect(restored, "the inbound returned during the rescan").toBe(true);
      releases[2]!();
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "acked", 5000),
        "the restored inbound is acked",
      ).toBe(true);
      expect(
        (JSON.parse(readFileSync(curPath, "utf-8")) as { ackedAt?: string }).ackedAt,
        "the gated path stamps the restored inbound",
      ).toBeDefined();
      expect(
        obligationFile(AGENT, inboundId)?.missingCurReason,
        "the restored inbound is not settled on the missing-cur allowance",
      ).toBeUndefined();
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
    } finally {
      releases[1]?.();
      releases[2]?.();
      await h.stop();
    }
  }, 40000);

  it("1059 r13 a yield event that finds the record closed releases the exhausted state", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r13-event-closed";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 300);
    setObligationCurLookupFaultForTests((id) => (id === inboundId ? "EIO" : undefined));
    const prevDelays = setObligationRetryDelaysForTests([50, 60, 70]);
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-retry-exhausted")), 15000),
        "the budget is exhausted",
      ).toBe(true);
      expect(obligationStateForTests().retries.some((r) => r.obligationId === obligationId)).toBe(true);
      expect(transitionObligation(tempMailDir, AGENT, inboundId, "acked", {})?.state).toBe("acked");
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      expect(
        obligationStateForTests().retries.some((r) => r.obligationId === obligationId),
        "the closed record releases the exhausted entry",
      ).toBe(false);
      expect(
        obligationStateForTests().contexts.some((c) => c.obligationId === obligationId),
        "the yield context is released",
      ).toBe(false);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setObligationCurLookupFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r13 the receipt scan uses the record's reply id before the dispatch-local one", async () => {
    seedSigningKeys();
    const h = await start(AGENT, SENDER, { localSender: true });
    const inboundId = h.inboundId;
    let injected = false;
    setBeforeReceiptScanForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      setBeforeReceiptScanForTests(undefined);
      const current = readObligation(tempMailDir, AGENT, inboundId)!;
      transitionObligation(tempMailDir, AGENT, inboundId, current.state, { replyId: "reply-replaced" }, undefined, {
        from: current.state,
        revision: current.revision ?? 0,
      });
      // The sender has consumed the posted file: only the metadata receipt for
      // the dispatch-local reply is left for the scan.
      const delivered = resolve(tempMailDir, SENDER, "new");
      for (const name of readdirSync(delivered)) {
        if (name.endsWith(".json")) renameSync(resolve(delivered, name), resolve(delivered, `${name}.gone`));
      }
    });
    try {
      await h.deliver("final answer", "final");
      h.settle();
      expect(await pollUntil(() => injected, 15000), "the record was replaced before the scan").toBe(true);
      await sleep(500);
      expect(obligationFile(AGENT, inboundId)?.replyId).toBe("reply-replaced");
      expect(
        obligationFile(AGENT, inboundId)?.state,
        "the posted reply's receipt does not ack the replacement",
      ).not.toBe("acked");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
    } finally {
      setBeforeReceiptScanForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r15 a moved reply id does not accept an earlier reply's posted file", async () => {
    seedSigningKeys();
    const h = await start(AGENT, SENDER, { localSender: true });
    const inboundId = h.inboundId;
    let injected = false;
    setBeforeReceiptScanForTests((id) => {
      if (id !== inboundId || injected) return;
      injected = true;
      setBeforeReceiptScanForTests(undefined);
      const current = readObligation(tempMailDir, AGENT, inboundId)!;
      transitionObligation(tempMailDir, AGENT, inboundId, current.state, { replyId: "reply-b" }, undefined, {
        from: current.state,
        revision: current.revision ?? 0,
      });
      // Reply A's posted file is left in the recipient's new/.
    });
    try {
      await h.deliver("final answer", "final");
      h.settle();
      expect(await pollUntil(() => injected, 15000), "the record was replaced before the scan").toBe(true);
      await sleep(500);
      expect(
        readdirSync(resolve(tempMailDir, SENDER, "new")).filter((name) => name.endsWith(".json")).length,
        "reply A's posted file is still there",
      ).toBeGreaterThan(0);
      expect(obligationFile(AGENT, inboundId)?.replyId).toBe("reply-b");
      expect(
        obligationFile(AGENT, inboundId)?.state,
        "reply A's posted file does not ack reply B",
      ).not.toBe("acked");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
    } finally {
      setBeforeReceiptScanForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r15 a deadline check released during inbound verification writes nothing", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r15-released-check";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", -1000);
    const recordPath = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
    const before = readFileSync(recordPath, "utf-8");
    let released = false;
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      beforeVerify: async () => {
        if (released) return;
        // Only the deadline check owns a retry entry; the startup reconcile
        // verifies before any entry exists and must not release.
        if (!obligationStateForTests().retries.some((r) => r.obligationId === obligationId)) return;
        // Hold the inbound verification, release the running deadline check
        // while that await is pending, then let the verification finish. The
        // record is gone when the yield event looks, so the event releases the
        // check; the record returns before the await resolves.
        released = true;
        rmSync(recordPath);
        capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
        writeFileSync(recordPath, before, "utf-8");
      },
    });
    try {
      expect(await pollUntil(() => released, 15000), "the deadline check paused during inbound verification").toBe(true);
      await sleep(500);
      expect(obligationFile(AGENT, inboundId)?.state, "the released check writes no terminal state").toBe("yielded");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption"), "no nack is sent").toHaveLength(0);
    } finally {
      await h.stop();
    }
  }, 40000);

  it("1059 r15 a cur/ entry that returns after the missing-cur rescan is verified and stamped", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r15-rescan-cur-returns";
    const { obligationId, curPath } = seedVerifiedCur(inboundId, "yielded", -1000);
    const curBytes = readFileSync(curPath, "utf-8");
    const replyToId = (JSON.parse(JSON.parse(curBytes).body) as { messageId: string }).messageId;
    rmSync(curPath);
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
      { agent: AGENT, kind: "agent", timestamp: now, rationale: "agent reply", signature: null },
    ];
    let readPasses = 0;
    setBeforeSettleReadForTests((id) => {
      if (id !== inboundId) return;
      readPasses++;
      if (readPasses !== 1) return;
      setBeforeSettleReadForTests(undefined);
      // The first settlement is stale: the record now names reply B, whose
      // receipt exists, so the rescan finds it.
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", { replyId: "reply-b" }, undefined, {
        from: "yielded",
        revision: 0,
      });
      writeReceipt(tempMailDir, AGENT, {
        replyId: "reply-b",
        obligationId,
        replyToId,
        route: "local",
        ts: now,
        signedReply: JSON.stringify(signEnvelope(
          { v: 1, from: AGENT, to: SENDER, body: "reply b", messageId: "reply-b", timestamp: now, replyToId, delegationChain: chain },
          { [AGENT]: ANVIL_SEED },
        )),
      });
    });
    let entries = 0;
    setBeforeSettleEntryForTests((id) => {
      if (id !== inboundId) return;
      entries++;
      // The inbound returns after the rescan and its cur/ lookup, at the
      // settlement decision point; the rescanned receipt must go through the
      // normal gate.
      if (entries === 2) writeFileSync(curPath, curBytes, "utf-8");
    });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "acked", 15000),
        "the rescanned receipt acks the obligation",
      ).toBe(true);
      expect(
        (JSON.parse(readFileSync(curPath, "utf-8")) as { ackedAt?: string }).ackedAt,
        "the restored inbound is verified and stamped",
      ).toBeDefined();
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
    } finally {
      setBeforeSettleEntryForTests(undefined);
      setBeforeSettleReadForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r13 a record whose inboundId does not match its lookup key is unverified", () => {
    const dir = resolve(tempMailDir, AGENT, ".obligations");
    mkdirSync(dir, { recursive: true });
    const record = {
      obligationId: "ob-b",
      inboundId: "b",
      inboundTimestamp: new Date().toISOString(),
      from: SENDER,
      to: AGENT,
      accountId: "default",
      state: "yielded",
      deadlineAt: null,
      attempts: 1,
      revision: 3,
    };
    const path = resolve(dir, "a.json");
    const bytes = JSON.stringify(record, null, 2);
    writeFileSync(path, bytes, "utf-8");
    expect(readObligation(tempMailDir, AGENT, "a"), "the mismatched point read is not a record").toBeNull();
    expect(readObligationResult(tempMailDir, AGENT, "a"), "the mismatched point read is unverified for that reason").toMatchObject({ status: "unverified", code: "INBOUND_ID_MISMATCH" });
    expect(
      transitionObligation(tempMailDir, AGENT, "a", "posted", { replyId: "r" }),
      "no transition writes through the mismatched key",
    ).toBeNull();
    expect(existsSync(resolve(dir, "b.json")), "the other key is not created").toBe(false);
    expect(readFileSync(path, "utf-8"), "the mismatched file is unchanged").toBe(bytes);
    // A correctly keyed record still uses its own revision, and a patch cannot
    // repoint its write key.
    const correct = { ...record, obligationId: "ob-c", inboundId: "c", revision: 2 };
    const cPath = resolve(dir, "c.json");
    writeFileSync(cPath, JSON.stringify(correct, null, 2), "utf-8");
    const updated = transitionObligation(tempMailDir, AGENT, "c", "posted", { replyId: "r", inboundId: "d" });
    expect(updated?.inboundId, "the write key does not move with the patch").toBe("c");
    expect(updated?.revision, "a correctly keyed record uses its own revision").toBe(3);
    expect(existsSync(resolve(dir, "d.json")), "no file is written under the patched id").toBe(false);
    expect(readFileSync(cPath, "utf-8"), "the record stays under its own key").toContain('"inboundId": "c"');
  });

  it("1059 r13 an unverified obligation at startup intake is logged, not an unhandled rejection", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r13-startup-unverified";
    const body = buildSignedBody(SENDER, AGENT, "startup payload", FLINT_SEED);
    const envelope = JSON.parse(body);
    mkdirSync(resolve(tempMailDir, AGENT, "new"), { recursive: true });
    writeFileSync(
      resolve(tempMailDir, AGENT, "new", `${inboundId}.json`),
      JSON.stringify({ id: inboundId, from: SENDER, to: AGENT, body, timestamp: envelope.timestamp, read: false }),
      "utf-8",
    );
    const dir = resolve(tempMailDir, AGENT, ".obligations");
    mkdirSync(dir, { recursive: true });
    const badPath = resolve(dir, `${inboundId}.json`);
    const bad = JSON.stringify({
      obligationId: `ob-${inboundId}`,
      inboundId,
      inboundTimestamp: new Date().toISOString(),
      from: SENDER,
      to: AGENT,
      accountId: "default",
      state: "pending",
      deadlineAt: null,
      attempts: 1,
      revision: "3",
    }, null, 2);
    writeFileSync(badPath, bad, "utf-8");
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => warnings.some((line) => line.includes("obligation-create-failed")), 15000),
        "the refused create is logged by name",
      ).toBe(true);
      expect(readFileSync(badPath, "utf-8"), "the unverified record is unchanged").toBe(bad);
      expect(
        readdirSync(resolve(tempMailDir, AGENT, "cur")).some((name) => name.includes(inboundId)),
        "the promoted inbound stays available in cur/",
      ).toBe(true);
    } finally {
      await h.stop();
    }
  }, 40000);

  it("1059 r14 a cur/ lookup error during the missing-cur rescan settles nothing", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r14-rescan-cur-error";
    const { obligationId } = seedOrphan(inboundId, { deadlineInMs: -1000 });
    const prevDelays = setObligationRetryDelaysForTests([60000, 60000, 60000]);
    setBeforeSettleReadForTests((id) => {
      if (id !== inboundId) return;
      setBeforeSettleReadForTests(undefined);
      // The first verdict's snapshot moves: the caller re-reads and rescans.
      transitionObligation(tempMailDir, AGENT, inboundId, "yielded", { replyId: "reply-moved" }, undefined, {
        from: "yielded",
        revision: 0,
      });
      // The inbound is still gone, but the rescan's own cur/ lookup fails.
      setObligationCurLookupFaultForTests((faultId) => (faultId === inboundId ? "EIO" : undefined));
    });
    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(
          () => warnings.some((line) => line.includes("obligation-cur-lookup-failed") && line.includes("EIO")),
          15000,
        ),
        "the failed rescan lookup is reported",
      ).toBe(true);
      await sleep(300);
      const rec = obligationFile(AGENT, inboundId);
      expect(rec?.state, "the error branch settles nothing").toBe("yielded");
      expect(rec?.replyId, "the moved reply is left in place").toBe("reply-moved");
      expect(rec?.failure, "no failure is recorded").toBeUndefined();
      expect(rec?.nackSentAt, "no nack stamp is written to the record").toBeUndefined();
      const retry = obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
      expect(retry, "the failed lookup schedules a bounded retry").toBeDefined();
      expect(retry!.dueAt, "the retry waits for its bounded delay").toBeGreaterThan(Date.now());
      expect(
        existsSync(resolve(tempMailDir, AGENT, "cur", `2026-05-26T00-00-00-${inboundId}.json`)),
        "no cur/ record is created to stamp",
      ).toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
    } finally {
      setObligationCurLookupFaultForTests(undefined);
      setBeforeSettleReadForTests(undefined);
      releaseObligationRetryForTests(obligationId);
      setObligationRetryDelaysForTests(prevDelays);
      await h.stop();
    }
  }, 40000);

  it("1059 r14 a capped deadline timer re-arms for the remainder and settles at the original deadline", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r14-timer-cap-fires";
    // The plugin reads this clock; it stays still through startup, so the
    // capped wake-up is observed before the deadline can arrive.
    let clock = Date.now();
    setObligationNowForTests(() => clock);
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 1500);
    const seededDeadline = obligationFile(AGENT, inboundId)!.deadlineAt;
    const prevCap = setObligationTimerCapForTests(300);
    let armReads = 0;
    setBeforeArmReadForTests((id) => { if (id === inboundId) armReads++; });
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "the future deadline is armed",
      ).toBe(true);
      const firstArmReads = armReads;
      expect(await pollUntil(() => armReads > firstArmReads, 1200), "the capped timer fires").toBe(true);
      expect(obligationFile(AGENT, inboundId)?.state, "the record stays open when the cap fires").toBe("yielded");
      expect(obligationFile(AGENT, inboundId)?.deadlineAt, "the durable deadline is unchanged").toBe(seededDeadline);
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
        "the remainder is re-armed",
      ).toBe(true);
      expect(clock, "the original deadline is still ahead").toBeLessThan(Date.parse(seededDeadline!));
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack before the deadline").toHaveLength(0);
      // Advance the controlled clock past the deadline. The nack is sent after
      // the failed state is written, so wait for the mail, not only the state.
      clock = Date.parse(seededDeadline!) + 1000;
      expect(
        await pollUntil(() => nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption").length > 0, 4000),
        "the nack lands at the original deadline",
      ).toBe(true);
      expect(obligationFile(AGENT, inboundId)?.state, "the record settles at the original deadline").toBe("failed");
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new"), "yielded-without-resumption"), "one nack at the deadline").toHaveLength(1);
    } finally {
      setObligationTimerCapForTests(prevCap);
      setBeforeArmReadForTests(undefined);
      setObligationNowForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r14 a yield event that finds the record missing releases its state", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r14-event-missing";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 20000);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "the record is open with a deadline and a context",
      ).toBe(true);
      const recordPath = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
      rmSync(recordPath);
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      expect(
        obligationStateForTests().retries.some((r) => r.obligationId === obligationId),
        "a missing record starts no retry",
      ).toBe(false);
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
        "the armed deadline is released",
      ).toBe(false);
      expect(
        obligationStateForTests().contexts.some((c) => c.obligationId === obligationId),
        "the yield context is released",
      ).toBe(false);
      expect(existsSync(recordPath), "the missing record is not recreated").toBe(false);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
    } finally { await h.stop(); }
  }, 40000);

  it("1059 r14 a yield event that finds the record unverified with no armed deadline schedules a retry", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r14-event-unverified";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 20000);
    setArmDeadlineFaultForTests((id) => id === inboundId);
    const prevDelays = setObligationRetryDelaysForTests([60000, 60000, 60000]);
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().retries.some((r) => r.obligationId === obligationId), 15000),
        "the failed arm left a scheduled retry",
      ).toBe(true);
      expect(releaseObligationRetryForTests(obligationId), "the entry is dropped").toBe(true);
      expect(
        obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId),
        "no deadline is armed",
      ).toBe(false);
      const recordPath = resolve(tempMailDir, AGENT, ".obligations", `${inboundId}.json`);
      const seeded = JSON.parse(readFileSync(recordPath, "utf-8"));
      const unverified = JSON.stringify({ ...seeded, revision: "3" }, null, 2);
      writeFileSync(recordPath, unverified, "utf-8");
      capturedSubscription.handle({ runId: obligationId, data: { yielded: true } });
      const retry = obligationStateForTests().retries.find((r) => r.obligationId === obligationId);
      expect(retry, "an unverified event read schedules a retry").toBeDefined();
      expect(retry!.exhausted, "the retry is not exhausted").toBe(false);
      expect(retry!.dueAt, "the retry has a due time").toBeGreaterThan(Date.now());
      expect(readFileSync(recordPath, "utf-8"), "the unverified record is not written").toBe(unverified);
      expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")), "no nack is sent").toHaveLength(0);
    } finally {
      setObligationRetryDelaysForTests(prevDelays);
      setArmDeadlineFaultForTests(undefined);
      await h.stop();
    }
  }, 40000);

  it("1059 r14 a startup intake rejection after promotion is logged, not unhandled", async () => {
    seedSigningKeys();
    const inboundId = "msg-1059-r14-startup-finalize-throws";
    const body = buildSignedBody(SENDER, AGENT, "startup payload", FLINT_SEED);
    const envelope = JSON.parse(body);
    mkdirSync(resolve(tempMailDir, AGENT, "new"), { recursive: true });
    writeFileSync(
      resolve(tempMailDir, AGENT, "new", `${inboundId}.json`),
      JSON.stringify({ id: inboundId, from: SENDER, to: AGENT, body, timestamp: envelope.timestamp, read: false }),
      "utf-8",
    );
    const warnings: string[] = [];
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    const h = await start(AGENT, SENDER, {
      localSender: true,
      noInbound: true,
      finalizeContextThrows: true,
      warnCalls: warnings,
    });
    try {
      expect(
        await pollUntil(
          () => warnings.some((line) => line.includes("processNewFile error") && line.includes("context finalizer refused")),
          15000,
        ),
        "the intake rejection is logged by name",
      ).toBe(true);
      await sleep(200);
      expect(rejections, "no unhandled rejection").toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
      await h.stop();
    }
  }, 40000);
});

});
