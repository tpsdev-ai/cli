/**
 * final-selection.test.ts — cli#400 round-2 fixtures: the dispatcher posts the
 * turn's LAST real final, never a silent one, and a deadline-before-settlement
 * never acks.
 *
 * OpenClaw calls `deliver` once per non-reasoning final in a turn, in order
 * (verified against the installed runtime: dispatch-*.js loops the turn's
 * replies and enqueues each as kind "final"). The old plugin kept the FIRST
 * (`if (posted) return`), so a turn that revised its verdict posted the stale
 * one. The plugin now remembers the LATEST final carrying real text and posts
 * exactly once after the dispatch resolves.
 *
 * The NO_REPLY case is driven through OpenClaw's OWN normaliser
 * (normalize-reply-*.js), not a fake that skips it: an exact `NO_REPLY` final
 * is SUPPRESSED before `deliver` is ever reached.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { signEnvelope, type ChainEntry } from "@tpsdev-ai/agent";

hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const FLINT_SEED = Buffer.alloc(32, 0x01);
const ANVIL_SEED = Buffer.alloc(32, 0x02);
const pubkeyFromSeed = (seed: Buffer) => Buffer.from(ed.getPublicKey(new Uint8Array(seed)));

// The runtime's own silent-reply normaliser (hashed filename; resolve it).
const require = createRequire(import.meta.url);
const openclawDist = join(dirname(require.resolve("openclaw/package.json")), "dist");
const normFile = readdirSync(openclawDist).find((f) => /^normalize-reply-.*\.js$/.test(f));
if (!normFile) throw new Error(`openclaw normalise-reply module not found under ${openclawDist}`);
const { t: normalizeReplyPayload } = (await import(pathToFileURL(join(openclawDist, normFile)).href)) as {
  t: (payload: any, opts?: any) => any;
};

import pluginModule from "../src/index.js";
let capturedPlugin: any;
let capturedSubscription: any;
pluginModule.register({
  registerChannel: ({ plugin }: any) => { capturedPlugin = plugin; },
  registerAgentEventSubscription: (sub: any) => { capturedSubscription = sub; },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

function readdirSafe(d: string): string[] { try { return readdirSync(d); } catch { return []; } }
async function pollUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return pred();
}
function signedBody(from: string, to: string, body: string, seed: Buffer): string {
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: new Date().toISOString(), rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: new Date().toISOString(), rationale: `agent ${from}`, signature: null },
  ];
  return JSON.stringify(signEnvelope({ v: 1, from, to, body, messageId: `msg-${Date.now()}`, timestamp: new Date().toISOString(), delegationChain: chain }, { [from]: seed }));
}

let tempMailDir: string, tempKeysDir: string, tempHome: string;
let abort: AbortController;
let origHome: string | undefined, origKeys: string | undefined, origDeadline: string | undefined;

beforeEach(() => {
  tempMailDir = mkdtempSync(join(tmpdir(), "tps-final-mail-"));
  tempKeysDir = mkdtempSync(join(tmpdir(), "tps-final-keys-"));
  tempHome = mkdtempSync(join(tmpdir(), "tps-final-home-"));
  abort = new AbortController();
  writeFileSync(join(tempKeysDir, "anvil.key"), ANVIL_SEED);
  writeFileSync(join(tempKeysDir, "flint.key"), FLINT_SEED);
  origKeys = process.env.TPS_TEST_KEYS_DIR; process.env.TPS_TEST_KEYS_DIR = tempKeysDir;
  origHome = process.env.HOME; process.env.HOME = tempHome;
  origDeadline = process.env.TPS_OBLIGATION_DEADLINE_MS;
});
afterEach(() => {
  abort.abort();
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origKeys === undefined) delete process.env.TPS_TEST_KEYS_DIR; else process.env.TPS_TEST_KEYS_DIR = origKeys;
  if (origDeadline === undefined) delete process.env.TPS_OBLIGATION_DEADLINE_MS; else process.env.TPS_OBLIGATION_DEADLINE_MS = origDeadline;
  for (const d of [tempMailDir, tempKeysDir, tempHome]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

function curRecord(agent: string): any | null {
  const dir = resolve(tempMailDir, agent, "cur");
  for (const f of readdirSafe(dir)) { try { return JSON.parse(readFileSync(join(dir, f), "utf-8")); } catch { /* */ } }
  return null;
}
function obligationFile(agent: string, id: string): any | null {
  try { return JSON.parse(readFileSync(resolve(tempMailDir, agent, ".obligations", `${id}.json`), "utf-8")); } catch { return null; }
}
function postedReplies(recipient: string): any[] {
  const dir = resolve(tempMailDir, recipient, "new");
  return readdirSafe(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
}

async function start(agentId: string, sender: string, opts: { localSender?: boolean; branchHost?: boolean } = {}) {
  mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
    createMailVerifyClient: async () => ({
      async getAgent(name: string) {
        if (name === sender) return { publicKey: pubkeyFromSeed(FLINT_SEED) };
        if (name === agentId) return { publicKey: pubkeyFromSeed(ANVIL_SEED) };
        return null;
      },
    }),
  }));
  if (opts.localSender) mkdirSync(resolve(tempMailDir, sender, "new"), { recursive: true });
  // cli#389: host TYPE decides locality (a branch relays non-bound recipients
  // to the outbox; the office delivers into a maildir).
  if (opts.branchHost) {
    mkdirSync(resolve(tempHome, ".tps", "identity"), { recursive: true });
    writeFileSync(resolve(tempHome, ".tps", "identity", "host.json"), "{}\n", "utf-8");
  }
  const newDir = resolve(tempMailDir, agentId, "new");
  mkdirSync(newDir, { recursive: true });
  const inboundId = `msg-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(resolve(newDir, `2026-05-26T00-00-00-${inboundId}.json`), JSON.stringify({
    id: inboundId, from: sender, to: agentId, body: signedBody(sender, agentId, "inbound", FLINT_SEED),
    timestamp: new Date().toISOString(), headers: { "X-TPS-Trust": "agent", "X-TPS-Surface": "tps-mail" }, deliveryAttempts: 0,
  }, null, 2), "utf-8");

  let dispatchedArgs: any = null;
  let settleFn: (() => void) | null = null;
  const channelRuntime = {
    routing: { buildAgentSessionKey: (p: any) => `agent:${p.agentId}:tps-mail:default:${p.peer.id}` },
    reply: {
      finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
      dispatchReplyWithBufferedBlockDispatcher: async (args: any) => { dispatchedArgs = args; await new Promise<void>((res) => { settleFn = res; }); return { failedCounts: 0 }; },
    },
  };
  const cfg = { bindings: [{ agentId, match: { channel: "tps-mail", accountId: "default" } }] };
  const ctx = {
    account: { accountId: "default", mailDir: tempMailDir, enabled: true }, cfg,
    log: { info: () => {}, warn: () => {}, error: () => {} }, channelRuntime, abortSignal: abort.signal,
  };
  const startPromise = capturedPlugin.gateway.startAccount(ctx);
  await pollUntil(() => dispatchedArgs !== null || curRecord(agentId) !== null, 4000);

  return {
    inboundId, startPromise,
    obligationId: (): string | null => dispatchedArgs?.replyOptions?.runId ?? null,
    deliver: (text: string) => dispatchedArgs!.dispatcherOptions.deliver({ text }, { kind: "final" }),
    skip: (reason = "empty") => dispatchedArgs!.dispatcherOptions.onSkip?.({ text: "" }, { kind: "final", reason }),
    settle: () => settleFn?.(),
    stop: async () => { abort.abort(); try { await startPromise; } catch { /* aborted */ } },
    /** Feed each text through OpenClaw's OWN normaliser, then the plugin's deliver. */
    feedViaRuntime: async (texts: string[]) => {
      for (const text of texts) {
        let reason: string | null = null;
        const norm = normalizeReplyPayload({ text }, { onSkip: (r: string) => { reason = r; } });
        if (norm) await dispatchedArgs!.dispatcherOptions.deliver(norm, { kind: "final" });
        else dispatchedArgs!.dispatcherOptions.onSkip?.({ text }, { kind: "final", reason });
      }
    },
  };
}

describe("cli#400 — the dispatcher posts the LAST real final", () => {
  it("'x' then an empty final → the posted body is 'x' (the empty one is never posted)", async () => {
    const h = await start("anvil", "flint", { localSender: true });
    await h.deliver("x");
    h.skip("empty");
    h.settle();
    await pollUntil(() => postedReplies("flint").length === 1, 2000);
    const replies = postedReplies("flint");
    expect(replies.length).toBe(1);
    expect(JSON.parse(replies[0]!.body).body).toBe("x");
    await h.stop();
  }, 15000);

  it("REGRESSION GUARD: a NO_REPLY final (through OpenClaw's own normaliser) is never posted; 'verdict' is", async () => {
    const h = await start("anvil", "flint", { localSender: true });
    // OpenClaw's normaliser suppresses the exact NO_REPLY before deliver; the
    // plugin's guard covers the same token if a surface ever delivers it raw.
    await h.feedViaRuntime(["verdict", "NO_REPLY"]);
    h.settle();
    await pollUntil(() => postedReplies("flint").length === 1, 2000);
    const replies = postedReplies("flint");
    expect(replies.length).toBe(1);
    expect(JSON.parse(replies[0]!.body).body).toBe("verdict");
    expect(replies.some((r) => JSON.parse(r.body).body === "NO_REPLY")).toBe(false);
    await h.stop();
  }, 15000);

  it("all finals silent/empty → FAILED by name with a nack, never acked", async () => {
    const h = await start("anvil", "flint", { localSender: true });
    await h.feedViaRuntime(["", "NO_REPLY"]);
    h.settle();
    const failed = await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "failed", 2000);
    expect(failed).toBe(true);
    expect(obligationFile("anvil", h.inboundId)?.failure).toBe("empty-final-text");
    expect(curRecord("anvil")?.nackedAt).toBeDefined();
    expect(curRecord("anvil")?.ackedAt).toBeUndefined();
    expect(postedReplies("flint").length).toBe(0);
    await h.stop();
  }, 15000);
});

describe("cli#400 — yield / deadline interplay", () => {
  it("(i) a buffered final followed by a yield: the final is posted and acked", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const h = await start("anvil", "flint", { localSender: true });
    const obId = h.obligationId();
    expect(obId).not.toBeNull();
    await h.deliver("buffered verdict");           // the final
    capturedSubscription.handle({ runId: obId, seq: 1, stream: "lifecycle", ts: Date.now(), data: { yielded: true }, sessionKey: "s" }); // then a yield
    h.settle();
    const acked = await pollUntil(() => !!curRecord("anvil")?.ackedAt, 3000);
    expect(acked).toBe(true);
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("acked");
    const replies = postedReplies("flint");
    expect(replies.length).toBe(1);
    expect(JSON.parse(replies[0]!.body).body).toBe("buffered verdict");
    await h.stop();
  }, 15000);

  it("(ii) the deadline expires BEFORE the dispatch settles, then a final arrives: stays FAILED, no ackedAt", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "80"; // fires while the dispatch is still open
    const h = await start("anvil", "flint", { localSender: true });
    const obId = h.obligationId();
    expect(obId).not.toBeNull();
    // A yield arms the deadline while the dispatch is STILL open…
    capturedSubscription.handle({ runId: obId, seq: 1, stream: "lifecycle", ts: Date.now(), data: { yielded: true }, sessionKey: "s" });
    const failedBefore = await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "failed", 4000);
    expect(failedBefore).toBe(true);              // …and it expires (fails) first
    expect(curRecord("anvil")?.nackedAt).toBeDefined();

    // NOW the dispatch resolves with a final.
    await h.deliver("late final");
    h.settle();
    await new Promise((r) => setTimeout(r, 200));

    // The terminal failure stands; the inbound must NOT be acked.
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("failed");
    expect(curRecord("anvil")?.ackedAt).toBeUndefined();
    expect(curRecord("anvil")?.nackedAt).toBeDefined();
    await h.stop();
  }, 20000);
});

describe("cli#398 T2 — a raw NO_REPLY final is an immediate empty-final-text, not a 60-minute yield", () => {
  it("(a) the only final is a raw NO_REPLY delivered to deliver → immediate empty-final-text + nack, no deadline armed", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000"; // a yield would NOT fail soon
    const h = await start("anvil", "flint", { localSender: true });
    await h.deliver("NO_REPLY"); // reaches deliver verbatim (2026.5.7 + silentReplyRewrite.direct = false)
    h.settle();
    const failed = await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "failed", 2000);
    expect(failed).toBe(true);
    expect(obligationFile("anvil", h.inboundId)?.failure).toBe("empty-final-text");
    expect(curRecord("anvil")?.nackedAt).toBeDefined();
    expect(curRecord("anvil")?.ackedAt).toBeUndefined();
    expect(postedReplies("flint").length).toBe(0);
    await h.stop();
  }, 15000);

  it("(b) 'verdict' then a raw NO_REPLY → posts 'verdict' and acks", async () => {
    const h = await start("anvil", "flint", { localSender: true });
    await h.deliver("verdict");
    await h.deliver("NO_REPLY");
    h.settle();
    await pollUntil(() => !!curRecord("anvil")?.ackedAt, 3000);
    expect(curRecord("anvil")?.ackedAt).toBeDefined();
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("acked");
    const replies = postedReplies("flint");
    expect(replies.length).toBe(1);
    expect(JSON.parse(replies[0]!.body).body).toBe("verdict");
    await h.stop();
  }, 15000);

  it("(b2) a raw NO_REPLY then 'verdict' → posts 'verdict' and acks", async () => {
    const h = await start("anvil", "flint", { localSender: true });
    await h.deliver("NO_REPLY");
    await h.deliver("verdict");
    h.settle();
    await pollUntil(() => !!curRecord("anvil")?.ackedAt, 3000);
    expect(curRecord("anvil")?.ackedAt).toBeDefined();
    const replies = postedReplies("flint");
    expect(replies.length).toBe(1);
    expect(JSON.parse(replies[0]!.body).body).toBe("verdict");
    await h.stop();
  }, 15000);

  it("(b3) no finals at all → the yield path (deadline armed)", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const h = await start("anvil", "flint", { localSender: true });
    h.settle();
    await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "yielded", 2000);
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("yielded");
    expect(obligationFile("anvil", h.inboundId)?.deadlineAt).toBeTruthy();
    expect(curRecord("anvil")?.ackedAt).toBeUndefined();
    expect(curRecord("anvil")?.nackedAt).toBeUndefined();
    await h.stop();
  }, 15000);

  it("(b4) 'verdict' then a raw NO_REPLY with the receipt made ABSENT → NOT empty-final-text (posted-without-receipt → yield)", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    const h = await start("anvil", "flint", { localSender: true });
    const flintNew = resolve(tempMailDir, "flint", "new");
    // The receipt dir is UNREADABLE: the reply write lands (write+execute) but
    // the scan cannot list it, so the receipt is absent.
    chmodSync(flintNew, 0o333);
    try {
      await h.deliver("verdict");
      await h.deliver("NO_REPLY");
      h.settle();
      await new Promise((r) => setTimeout(r, 300));
      expect(obligationFile("anvil", h.inboundId)?.failure).not.toBe("empty-final-text");
      expect(obligationFile("anvil", h.inboundId)?.state).toBe("yielded");
      expect(curRecord("anvil")?.ackedAt).toBeUndefined();
    } finally {
      chmodSync(flintNew, 0o755);
    }
    // The write DID land (the reply is there once the dir is readable again).
    expect(postedReplies("flint").length).toBe(1);
    await h.stop();
  }, 15000);
});

describe("cli#398 T4 — an unrelated quarantined file does not poison later non-posting turns", () => {
  const outbox = (kind: "new" | "sent") => resolve(tempHome, ".tps", "outbox", kind);
  function seedMalformed(kind: "new" | "sent"): void {
    mkdirSync(outbox(kind), { recursive: true });
    writeFileSync(join(outbox(kind), `.malformed-${randomUUID()}.json`), "{ not json, quarantined");
  }

  it("(c) unrelated .malformed-* in the remote route + a turn that yields with no final → deadline ARMED, not receipt-malformed", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    seedMalformed("sent");
    const h = await start("anvil", "flint", { localSender: false, branchHost: true });
    h.settle(); // no final → yield
    await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "yielded", 2000);
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("yielded");
    expect(obligationFile("anvil", h.inboundId)?.deadlineAt).toBeTruthy();
    expect(obligationFile("anvil", h.inboundId)?.failure).toBeUndefined();
    expect(curRecord("anvil")?.nackedAt).toBeUndefined();
    await h.stop();
  }, 15000);

  it("(d) unrelated .malformed-* present + this turn posts a valid reply → found → ack", async () => {
    seedMalformed("sent");
    const h = await start("anvil", "flint", { localSender: false, branchHost: true });
    await h.deliver("verdict");
    h.settle();
    await pollUntil(() => !!curRecord("anvil")?.ackedAt, 3000);
    expect(obligationFile("anvil", h.inboundId)?.state).toBe("acked");
    await h.stop();
  }, 15000);

  it("(e) [cli#389 round 7] this turn posts, its own record is unreadable and NO valid receipt is visible → NOT failed, NOT nacked: the committed guard refuses the receipt-malformed determination and the deadline resolves it", async () => {
    process.env.TPS_OBLIGATION_DEADLINE_MS = "600000";
    seedMalformed("sent"); // the quarantined record the scan can see
    mkdirSync(outbox("new"), { recursive: true });
    chmodSync(outbox("new"), 0o333); // posted reply lands here but is not listable
    try {
      const h = await start("anvil", "flint", { localSender: false, branchHost: true });
      await h.deliver("verdict");
      h.settle();
      // cli#389 round 7 RETIRES the named failure cli#398 T4(e) recorded here.
      // The posted reply makes the turn COMMITTED, so the fail/nack verb refuses
      // the receipt-malformed determination: the obligation is not failed and the
      // inbound is not nacked. The evidence is unreadable, so the obligation
      // resolves at its DEADLINE, exactly like the wire route's missing receipt.
      const yielded = await pollUntil(() => obligationFile("anvil", h.inboundId)?.state === "yielded", 3000);
      expect(yielded).toBe(true);
      expect(obligationFile("anvil", h.inboundId)?.failure).toBeUndefined();
      expect(obligationFile("anvil", h.inboundId)?.deadlineAt).toBeTruthy();
      expect(curRecord("anvil")?.nackedAt).toBeUndefined();
      expect(curRecord("anvil")?.ackedAt).toBeUndefined();
      await h.stop();
    } finally {
      chmodSync(outbox("new"), 0o755);
    }
  }, 15000);
});
