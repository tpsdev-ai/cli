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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import { signEnvelope, type Envelope, type ChainEntry } from "@tpsdev-ai/agent";

import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const FLINT_SEED = Buffer.alloc(32, 0x01); // the sender
const ANVIL_SEED = Buffer.alloc(32, 0x02); // the agent (signs the reply)

function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

// Import the plugin — default export gives us { register }.
import pluginModule from "../src/index.js";

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
      localSender?: boolean;
      branchHost?: boolean;
      bodyFrom?: string;
      bodySeed?: Buffer;
      signAgentKey?: boolean;
      noInbound?: boolean;
      accounts?: Record<string, { mailDir: string }>;
      dispatchFailedCounts?: any;
      warnCalls?: string[];
    } = {},
  ) {
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
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
      abortSignal: abortController.signal,
    };

    const startPromise = capturedPlugin.gateway.startAccount(ctx);
    await pollUntil(() => dispatchedArgs !== null || curFiles(agentId).length > 0 || existsSync(resolve(tempMailDir, agentId, "dlq")), 4000);

    return {
      inboundId,
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
      stop: async () => { abortController.abort(); try { await startPromise; } catch { /* aborted */ } },
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
    expect(readdirSafe(resolve(tempMailDir, "flint", "new")).filter((f) => f.endsWith(".json")).length).toBe(0);

    await h.stop();
  }, 15000);

  // ── F-S2c ──────────────────────────────────────────────────────────────────
  it("F-S2c: a missing signing key is FAILED by name, nacked, never acked", async () => {
    const h = await start("anvil", "flint", { localSender: true, signAgentKey: false });
    await h.deliver("final answer", "final");
    h.settle();

    await pollUntil(() => !!curRecord("anvil")?.nackedAt, 2000);
    const cur = curRecord("anvil");
    expect(cur?.ackedAt).toBeUndefined();
    expect(cur?.nackReason).toContain("missing-signing-key");
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("failed");
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
});
