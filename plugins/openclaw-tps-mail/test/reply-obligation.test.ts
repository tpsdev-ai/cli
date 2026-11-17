import { MailClient, mailboxReplayStore } from "@tpsdev-ai/agent";
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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync, chmodSync, symlinkSync, renameSync } from "node:fs";
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
import pluginModule, { obligationStateForTests } from "../src/index.js";
import { createObligation, transitionObligation, setBeforeTransitionForTests, sweepTerminalObligations, writeReceipt } from "../src/obligations.js";

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
      dispatchFailedCounts?: any;
      warnCalls?: string[];
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

    if (opts.localSender) mkdirSync(resolve(tempMailDir, sender, "new"), { recursive: true });
    // cli#389: host TYPE decides locality (a branch relays non-bound recipients).
    if (opts.branchHost) {
      mkdirSync(resolve(tempHome, ".tps", "identity"), { recursive: true });
      writeFileSync(resolve(tempHome, ".tps", "identity", "host.json"), "{}\n", "utf-8");
    }
    const newDir = resolve(tempMailDir, agentId, "new");
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
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
          dispatchCount++;
          dispatchedArgs = args;
          await new Promise<void>((res) => { settleFn = res; });
          return { failedCounts: opts.dispatchFailedCounts ?? 0 };
        },
      },
    };

    const cfg = {
      channels: { "tps-mail": { accounts: opts.accounts ?? { default: { mailDir: tempMailDir, enabled: true } } } },
      bindings: [{ agentId, match: { channel: "tps-mail", accountId: "default" } }],
    };
    const warnCalls = opts.warnCalls ?? [];
    const ctx = {
      account: { accountId: "default", mailDir: tempMailDir, enabled: true },
      cfg,
      log: { info: () => {}, warn: (...a: any[]) => warnCalls.push(a.map(String).join(" ")), error: () => {} },
      channelRuntime,
      abortSignal: accountAbort.signal,
    };

    if (opts.noInbound) {
      for (const file of readdirSafe(resolve(tempMailDir, agentId, "cur"))) {
        if (file === opts.keepRawCur) continue;
        const path = resolve(tempMailDir, agentId, "cur", file);
        const record = JSON.parse(readFileSync(path, "utf8"));
        if (record.envelope) {
          mailboxReplayStore(resolve(tempMailDir, agentId)).recordConsumed(record.envelope.messageId);
          continue;
        }
        const envelope = JSON.parse(record.body);
        writeFileSync(path, JSON.stringify({ ...record, body: envelope.body, timestamp: envelope.timestamp,
          envelopeId: envelope.messageId, envelope, replyToId: envelope.replyToId }));
        mailboxReplayStore(resolve(tempMailDir, agentId)).recordConsumed(envelope.messageId);
      }
    }
    const startPromise = capturedPlugin.gateway.startAccount(ctx);
    await pollUntil(() => dispatchedArgs !== null || curFiles(agentId).length > 0 || existsSync(resolve(tempMailDir, agentId, "dlq")), 4000);

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
   * sweep leaves it in place (an unacked one is re-dispatched or quarantined).
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
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true });

    const acked = await pollUntil(() => obligationFile(AGENT, inboundId)?.state === "acked", 3000);
    expect(acked, "the receipt settles it").toBe(true);
    expect(obligationFile(AGENT, inboundId)?.missingCurReason).toBe(REASON);
    expect(nackMailsIn(resolve(tempMailDir, SENDER, "new")).length, "an ack sends no nack").toBe(0);
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
        "the guarded write was refused, and the live record settles from fresh evidence",
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
        "the guarded write was refused, and the live record settles from fresh evidence",
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

  /** A verified cur/ entry plus an obligation record at `state` with `deadlineInMs`. */
  function seedVerifiedCur(
    inboundId: string,
    state: "yielded" | "delivering",
    deadlineInMs: number,
  ): { obligationId: string; curPath: string } {
    const signedBody = buildSignedBody(SENDER, AGENT, "inbound payload", FLINT_SEED);
    const envelopeId = (JSON.parse(signedBody) as { messageId: string }).messageId;
    const { obligationId } = seedOrphan(inboundId, { state, deadlineInMs, envelopeId });
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

  it("r10 startup proves presence beyond the scan limit and arms the deadline", async () => {
    seedSigningKeys();
    const inboundId = "msg-startup-scan-limit";
    const { obligationId } = seedVerifiedCur(inboundId, "yielded", 60000);
    exceedCurScanLimit();

    const warnings: string[] = [];
    const h = await start(AGENT, SENDER, { localSender: true, noInbound: true, warnCalls: warnings });
    try {
      expect(
        await pollUntil(() => obligationStateForTests().deadlines.some((d) => d.obligationId === obligationId), 15000),
        "the startup scan finds the entry past the limit and arms its deadline",
      ).toBe(true);
      expect(warnings.filter((line) => line.includes("obligation-cur-lookup-failed"))).toHaveLength(0);
      expect(obligationFile(AGENT, inboundId)?.missingCurReason, "the entry is not missing").toBeUndefined();
    } finally { await h.stop(); }
  }, 40000);

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
});


});
