/**
 * dispatcher-reply.test.ts — the reply path (cli#338 + the reply-OBLIGATION
 * slices S0/S1).
 *
 * The dispatcher must post ONE signed final reply per inbound, and a LOCAL
 * recipient's reply must never go to the outbox while a REMOTE recipient's
 * reply must never be dropped (S0).
 *
 * Harness note: the previous version's mock returned immediately and invoked
 * the captured `deliver` by hand, which cannot express "the ack happens only
 * after the reply file exists". This version uses a fake channelRuntime whose
 * `dispatchReplyWithBufferedBlockDispatcher` does NOT resolve until the test
 * drives `deliver` and then calls `settle()` — so post-before-ack ordering is
 * observable (used by the S2 fixtures; S1 keeps the same harness).
 *
 * Fixtures here:
 *   F-S0a  local recipient (maildir) → exactly one signed file in the maildir,
 *          zero in the outbox.
 *   F-S0b  remote recipient (no maildir, no binding) → exactly one file in
 *          ~/.tps/outbox/new/ carrying the reply envelope AND X-TPS-InReplyTo;
 *          nothing in the maildir.
 *   F-S1a  outer `from` ≠ verified inner `from` → rejected before dispatch,
 *          dead-lettered, nothing posted.
 *   F-S1b  a progress mail from the agent after the inbound → the dispatcher
 *          final is STILL posted (no suppression).
 *   F-S2d  multiple final payloads → exactly one post.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, openSync, writeSync, closeSync, watch as fsWatch } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
// The REAL consumer: the branch relay drains the outbox with this exact
// function (packages/cli/src/commands/branch.ts imports it from the same
// module). Imported from the built CLI so we exercise the shipped artifact.
import { drainOutbox } from "../../../packages/cli/dist/src/utils/outbox.js";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import { signEnvelope, type Envelope, type ChainEntry } from "@tpsdev-ai/agent";

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
  logger: { info: (..._: any[]) => {}, warn: (..._: any[]) => {}, error: (..._: any[]) => {} },
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

/** Sign an envelope AS `from` (seed) and wrap it as a mail body. */
function buildSignedBody(from: string, to: string, body: string, seed: Buffer): string {
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: new Date().toISOString(), rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: new Date().toISOString(), rationale: `agent ${from} dispatches`, signature: null },
  ];
  const env = signEnvelope(
    { v: 1, from, to, body, messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString(), delegationChain: chain },
    { [from]: seed },
  );
  return JSON.stringify(env);
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("openclaw-tps-mail: dispatcher reply path (cli#338, S0/S1)", () => {
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

    writeFileSync(join(tempKeysDir, "anvil.key"), ANVIL_SEED);
    origKeysDir = process.env.TPS_TEST_KEYS_DIR;
    process.env.TPS_TEST_KEYS_DIR = tempKeysDir;

    origHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    abortController.abort();
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origKeysDir === undefined) delete process.env.TPS_TEST_KEYS_DIR; else process.env.TPS_TEST_KEYS_DIR = origKeysDir;
    for (const d of [tempMailDir, tempKeysDir, tempHome]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  /**
   * Start the plugin for one inbound and return a handle that exposes the
   * captured `deliver` callback plus `settle()`, which resolves the dispatch
   * promise. Nothing is acked until `settle()` is called, so ordering is
   * controllable.
   */
  async function startDispatcher(
    agentId: string,
    sender: string,
    opts: { localSender?: boolean; branchHost?: boolean; bodyFrom?: string; bodySeed?: Buffer; warnCalls?: string[] } = {},
  ) {
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: async () => ({
        async getAgent(name: string) {
          if (name === sender) return { publicKey: pubkeyFromSeed(FLINT_SEED) };
          if (name === "anvil") return { publicKey: pubkeyFromSeed(ANVIL_SEED) };
          return null;
        },
      }),
    }));

    if (opts.localSender) mkdirSync(resolve(tempMailDir, sender, "new"), { recursive: true });
    // cli#389: host TYPE decides locality. A branch relays non-bound recipients
    // to the outbox; the office delivers into a maildir. Fixtures default to the
    // office (a maildir recipient is local); an outbox expectation opts in to a
    // branch host.
    if (opts.branchHost) {
      mkdirSync(resolve(tempHome, ".tps", "identity"), { recursive: true });
      writeFileSync(resolve(tempHome, ".tps", "identity", "host.json"), "{}\n", "utf-8");
    }
    const newDir = resolve(tempMailDir, agentId, "new");
    mkdirSync(newDir, { recursive: true });

    const bodyFrom = opts.bodyFrom ?? sender;
    const seed = opts.bodySeed ?? FLINT_SEED;
    const signedBody = buildSignedBody(bodyFrom, agentId, "inbound payload", seed);
    const envelope = makeMailEnvelope(signedBody, { from: sender, to: agentId, id: `msg-${Date.now()}` });
    const filename = `2026-05-26T00-00-00-${envelope.id}.json`;
    writeFileSync(resolve(newDir, filename), JSON.stringify(envelope, null, 2), "utf-8");

    let dispatched: { dispatcherOptions: any } | null = null;
    let settleFn: (() => void) | null = null;

    const channelRuntime = {
      routing: { buildAgentSessionKey: (params: any) => `agent:${params.agentId}:tps-mail:default:${params.peer.id}` },
      reply: {
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }: any) => {
          dispatched = { dispatcherOptions };
          await new Promise<void>((res) => { settleFn = res; });
        },
      },
    };

    const cfg = { bindings: [{ agentId, match: { channel: "tps-mail", accountId: "default" } }] };
    const warnCalls = opts.warnCalls ?? [];
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
    await waitFor(() => dispatched !== null || existsSync(resolve(tempMailDir, agentId, "dlq")));

    return {
      dispatched,
      warnCalls,
      startPromise,
      deliver: (payload: any, info: any) => dispatched!.dispatcherOptions.deliver(payload, info),
      // cli#400: the runtime suppresses an empty/silent final BEFORE `deliver`
      // (onSkip); this drives that path.
      skip: (reason = "empty") => dispatched!.dispatcherOptions.onSkip?.({ text: "" }, { kind: "final", reason }),
      settle: () => settleFn?.(),
    };
  }

  it("F-S0a: a LOCAL recipient gets exactly one signed reply in its maildir, zero in the outbox", async () => {
    const h = await startDispatcher("anvil", "flint", { localSender: true });
    expect(h.dispatched).not.toBeNull();

    await h.deliver({ text: "intermediate narration" }, { kind: "block" });
    await h.deliver({ text: "final verdict" }, { kind: "final" });

    // cli#400: `deliver` only REMEMBERS the final; the post happens after the
    // dispatch resolves.
    h.settle();

    const flintNew = resolve(tempMailDir, "flint", "new");
    await waitFor(() => readdirSafe(flintNew).filter((f) => f.endsWith(".json")).length === 1, 2000);
    const files = readdirSafe(flintNew).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const mail = JSON.parse(readFileSync(resolve(flintNew, files[0]!), "utf-8"));
    expect(mail.from).toBe("anvil");
    expect(mail.to).toBe("flint");
    expect(mail.headers["X-TPS-InReplyTo"]).toBeDefined();
    const env: Envelope = JSON.parse(mail.body);
    expect(env.v).toBe(1);
    expect(typeof env.signature).toBe("string");
    expect(env.body).toBe("final verdict");

    const outboxNew = resolve(tempHome, ".tps", "outbox", "new");
    expect(readdirSafe(outboxNew).filter((f) => f.endsWith(".json")).length).toBe(0);

    abortController.abort();
    try { await h.startPromise; } catch { /* expected */ }
  }, 15000);

  it("F-S0b: a REMOTE recipient gets exactly one reply in the outbox with X-TPS-InReplyTo, nothing dropped", async () => {
    const h = await startDispatcher("anvil", "flint", { localSender: false, branchHost: true });
    expect(h.dispatched).not.toBeNull();

    await h.deliver({ text: "final verdict" }, { kind: "final" });

    // cli#400: the post happens after the dispatch resolves.
    h.settle();
    // Not dropped: the reply is in the outbox.
    const outboxNew = resolve(tempHome, ".tps", "outbox", "new");
    await waitFor(() => readdirSafe(outboxNew).filter((f) => f.endsWith(".json")).length === 1, 2000);
    const outFiles = readdirSafe(outboxNew).filter((f) => f.endsWith(".json"));
    expect(outFiles.length).toBe(1);

    const sent = JSON.parse(readFileSync(resolve(outboxNew, outFiles[0]!), "utf-8"));
    expect(sent.from).toBe("anvil");
    expect(sent.to).toBe("flint");
    expect(sent.headers["X-TPS-InReplyTo"]).toBeDefined();
    expect(sent.replyToId).toBeDefined();
    const env: Envelope = JSON.parse(sent.body);
    expect(env.body).toBe("final verdict");

    // And NOT in a local maildir.
    expect(existsSync(resolve(tempMailDir, "flint", "new"))).toBe(false);

    abortController.abort();
    try { await h.startPromise; } catch { /* expected */ }
  }, 15000);

  it("F-S1a: outer from ≠ verified inner from → rejected before dispatch, dead-lettered, nothing posted", async () => {
    // Wrapper claims `flint`; the signed envelope is actually from `anvil`.
    const h = await startDispatcher("anvil", "flint", { bodyFrom: "anvil", bodySeed: ANVIL_SEED });

    // No session, no ctx, no dispatch: the inbound never reaches the agent.
    expect(h.dispatched).toBeNull();

    // Dead-lettered with a reason sidecar (class invalid), not delivered.
    const dlq = resolve(tempMailDir, "anvil", "dlq");
    const dlqFiles = readdirSafe(dlq).filter((f) => f.endsWith(".json"));
    expect(dlqFiles.length).toBe(1);
    const reasons = readdirSafe(dlq).filter((f) => f.endsWith(".reason"));
    expect(reasons.length).toBe(1);
    expect(readFileSync(resolve(dlq, reasons[0]!), "utf-8")).toContain("wrapper/envelope from mismatch");

    // Nothing posted anywhere.
    expect(readdirSafe(resolve(tempMailDir, "flint", "new")).filter((f) => f.endsWith(".json")).length).toBe(0);
    expect(readdirSafe(resolve(tempHome, ".tps", "outbox", "new")).filter((f) => f.endsWith(".json")).length).toBe(0);

    abortController.abort();
    try { await h.startPromise; } catch { /* expected */ }
  }, 15000);

  it("F-S1b: a progress mail from the agent after the inbound does NOT suppress the dispatcher final", async () => {
    const h = await startDispatcher("anvil", "flint", { localSender: true });

    // The agent writes a progress note mid-turn (its own explicit send).
    const flintNew = resolve(tempMailDir, "flint", "new");
    const progress = {
      id: `msg-progress-${Date.now()}`,
      from: "anvil",
      to: "flint",
      body: buildSignedBody("anvil", "flint", "progress: starting", ANVIL_SEED),
      timestamp: new Date().toISOString(),
      headers: { "X-TPS-Trust": "agent" },
      deliveryAttempts: 0,
    };
    writeFileSync(resolve(flintNew, `2026-05-26T00-00-01-${progress.id}.json`), JSON.stringify(progress, null, 2), "utf-8");

    await h.deliver({ text: "final verdict" }, { kind: "final" });

    // cli#400: the post happens after the dispatch resolves.
    h.settle();
    await waitFor(() => readdirSafe(flintNew).filter((f) => f.endsWith(".json")).length === 2, 2000);
    // The progress note stands AND the dispatcher final is posted (no suppression).
    const files = readdirSafe(flintNew).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(2);
    const bodies = files.map((f) => JSON.parse(readFileSync(resolve(flintNew, f), "utf-8")).body);
    expect(bodies.some((b) => JSON.parse(b).body === "final verdict")).toBe(true);
    expect(bodies.some((b) => JSON.parse(b).body === "progress: starting")).toBe(true);

    abortController.abort();
    try { await h.startPromise; } catch { /* expected */ }
  }, 15000);

  it("F-S2d: multiple final payloads produce exactly one post", async () => {
    const h = await startDispatcher("anvil", "flint", { localSender: true });

    await h.deliver({ text: "final one" }, { kind: "final" });
    await h.deliver({ text: "final two" }, { kind: "final" });
    await h.deliver({ text: "final three" }, { kind: "final" });

    // cli#400: exactly ONE post, and it is the turn's LAST real final (the old
    // code kept the FIRST and posted "final one").
    h.settle();
    const flintNew = resolve(tempMailDir, "flint", "new");
    await waitFor(() => readdirSafe(flintNew).filter((f) => f.endsWith(".json")).length === 1, 2000);

    const files = readdirSafe(flintNew).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const posted = JSON.parse(readFileSync(resolve(flintNew, files[0]!), "utf-8"));
    expect(JSON.parse(posted.body).body).toBe("final three"); // the LAST one

    abortController.abort();
    try { await h.startPromise; } catch { /* expected */ }
  }, 15000);

  // ── atomic outbox write, driven through the REAL consumer ─────────────────
  //
  // The property that matters is not "the final name is never changed in
  // place" — that is an inotify shape and does not hold on every platform — it
  // is "a concurrent drain never observes a half-written record". The REAL
  // consumer is drainOutbox(): the branch relay (branch.ts:409) watches
  // ~/.tps/outbox/new and calls it on every directory event, and it quarantines
  // (never retries) a non-dot `.json` it cannot JSON.parse — so a torn read is a
  // permanently LOST reply.
  //
  //   POSITIVE: the FIXED writer (writeOutboxFile, staged to a dot temp then
  //             renamed), driven through the production shape — a real
  //             fs.watch → drainOutbox() relay loop. Every record survives,
  //             zero quarantines. This loop must stay green.
  //   NEGATIVE CONTROL: the PRE-FIX shape reprised as a test-only writer — a
  //             MULTI-SYSCALL in-place write straight to the FINAL name
  //             (open → 64 KiB writeSync chunks → close). It invokes the REAL
  //             consumer drainOutbox() between chunks, i.e. at the instant the
  //             record is GUARANTEED incomplete, so the tear is deterministic:
  //             no watch event, no yield, no timing — it holds on macOS and
  //             Linux alike.
  //
  // A single synchronous writeFileSync, however large, is effectively atomic
  // against an in-process reader and never tears — which is why the negative
  // control is multi-syscall AND drives the drain itself rather than racing a
  // watcher. The relay loop for the POSITIVE case mirrors branch.ts:409 exactly
  // (a real fs.watch on outbox/new → drainOutbox() on each event); HOME is
  // redirected per-test, and every wait has an explicit deadline.

  /** The real relay, exactly as branch.ts:409 runs it. Collects delivered items. */
  function startRelay(newDir: string) {
    mkdirSync(newDir, { recursive: true });
    const delivered: any[] = [];
    const drainOnce = () => { for (const item of drainOutbox()) delivered.push(item); };
    const watcher = fsWatch(newDir, drainOnce);
    return {
      delivered,
      /** The relay's own action, callable directly for a bounded settle. */
      drainOnce,
      close: () => { try { watcher.close(); } catch { /* already closed */ } },
    };
  }

  /**
   * The negative control's writer — the PRE-FIX shape: a MULTI-SYSCALL write
   * straight to the final name (open → 64 KiB chunks → close). `onMidChunk`
   * runs after each chunk, when the final name holds only a PREFIX of the
   * record; the test passes drainOutbox() so the REAL consumer reads it
   * incomplete. Deterministic: no yield and no watch event are involved.
   */
  function tornWriteInPlace(target: string, content: string, onMidChunk: () => void): void {
    const buf = Buffer.from(content, "utf-8");
    const CHUNK = 64 * 1024;
    const fd = openSync(target, "w");
    try {
      for (let off = 0; off < buf.length; off += CHUNK) {
        writeSync(fd, buf, off, Math.min(CHUNK, buf.length - off), off);
        onMidChunk(); // the file IS incomplete here — the real consumer drains NOW
      }
    } finally {
      closeSync(fd);
    }
  }

  /** A body big enough that a chunked write has several yield points to tear on. */
  const BIG_BODY = "x".repeat(256 * 1024);

  function outboxDirs() {
    return {
      newDir: resolve(tempHome, ".tps", "outbox", "new"),
      sentDir: resolve(tempHome, ".tps", "outbox", "sent"),
    };
  }

  function sentInventory(sentDir: string) {
    const names = readdirSafe(sentDir);
    return {
      good: names.filter((f) => f.endsWith(".json") && !f.startsWith(".")),
      malformed: names.filter((f) => f.startsWith(".malformed-")),
    };
  }

  it("S0 relay (POSITIVE): every record the FIXED writer emits survives the real drainOutbox relay", async () => {
    // cli#389: a branch host relays a non-bound recipient to the outbox.
    mkdirSync(resolve(tempHome, ".tps", "identity"), { recursive: true });
    writeFileSync(resolve(tempHome, ".tps", "identity", "host.json"), "{}\n", "utf-8");
    const { newDir, sentDir } = outboxDirs();
    const relay = startRelay(newDir);

    // On Linux, also record raw directory events (supplementary ONLY — the
    // drainOutbox evidence below is what the test relies on; this pins the
    // inotify shape where it holds and is skipped elsewhere).
    const events: string[] = [];
    const eventWatcher = fsWatch(newDir, (_t, f) => { if (f) events.push(`${_t}:${f}`); });

    // The FIXED writer: writeOutboxFile, reached through the plugin's real
    // outbound adapter (a REMOTE recipient routes the record to the outbox).
    const cfg = {
      channels: { "tps-mail": { accounts: { default: { mailDir: tempMailDir, enabled: true } } } },
      bindings: [{ agentId: "anvil", match: { channel: "tps-mail", accountId: "default" } }],
    };
    const N = 20;

    try {
      for (let i = 0; i < N; i++) {
        const res: any = await capturedPlugin.outbound.sendText({
          cfg,
          accountId: "default",
          to: "flint",                       // no maildir, not bound → remote
          text: `${i}:${BIG_BODY}`,          // ≥256 KiB per record
          identity: { agentId: "anvil" },
        });
        expect(res.ok).toBe(true);
        expect(res.details.route).toBe("outbox");
      }

      // Settle before read: wait (bounded), close the watchers, run the relay's
      // drain once more synchronously, and only THEN inventory.
      await waitFor(() => sentInventory(sentDir).good.length === N, 15000);
      try { eventWatcher.close(); } catch { /* already closed */ }
      relay.close();
      relay.drainOnce();

      const { good, malformed } = sentInventory(sentDir);
      expect(good.length).toBe(N);              // all delivered, parsed intact
      expect(malformed.length).toBe(0);         // zero quarantines
      expect(relay.delivered.length).toBe(N);
      for (const item of relay.delivered) {
        expect(item.to).toBe("flint");
        expect(item.from).toBe("anvil");
        expect(item.body.length).toBeGreaterThanOrEqual(256 * 1024);
      }

      if (process.platform === "linux") {
        // Supplementary, Linux-only: the final name appeared via rename and was
        // never written in place (no `change:` on a non-dot `.json`).
        const isFinalJson = (n: string) => n.endsWith(".json") && !n.startsWith(".");
        expect(events.some((e) => e.startsWith("rename:") && isFinalJson(e.slice("rename:".length)))).toBe(true);
        expect(events.filter((e) => e.startsWith("change:") && isFinalJson(e.slice("change:".length)))).toEqual([]);
      }
    } finally {
      try { eventWatcher.close(); } catch { /* already closed */ }
      relay.close();
    }
  }, 30000);

  it("S0 relay (NEGATIVE CONTROL — pre-fix torn writer): the fixture CAN fail; an in-place chunked write is quarantined", () => {
    const { newDir, sentDir } = outboxDirs();
    mkdirSync(newDir, { recursive: true });

    // Capture the consumer's own quarantine log line.
    const errLines: string[] = [];
    const origErr = console.error;
    console.error = (...args: any[]) => { errLines.push(args.map(String).join(" ")); };

    const N = 4;
    try {
      for (let i = 0; i < N; i++) {
        const id = randomUUID();
        const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.json`;
        const record = JSON.stringify(
          { id, to: "flint", from: "anvil", body: `${i}:${BIG_BODY}`, timestamp: new Date().toISOString() },
          null,
          2,
        );
        // PRE-FIX shape: multi-syscall in-place write to the FINAL name, with the
        // REAL consumer draining between chunks — the record is guaranteed
        // incomplete at that instant, so the tear needs no timing at all.
        tornWriteInPlace(resolve(newDir, filename), record, () => { drainOutbox(); });
      }
      drainOutbox(); // settle before read
    } finally {
      console.error = origErr;
    }

    const { good, malformed } = sentInventory(sentDir);
    // The mechanism is real: the consumer read a record mid-write and
    // quarantined it with no retry, logging its own line…
    expect(malformed.length).toBeGreaterThanOrEqual(1);
    expect(errLines.some((l) => l.includes("failed to parse") && l.includes("quarantining"))).toBe(true);
    // …so the delivered set comes up short — the reply would have been LOST.
    expect(good.length).toBeLessThan(N);
    expect(good.length + malformed.length).toBeLessThanOrEqual(N);
  }, 20000);

  it("S0 positive control: the final outbox file parses, keeps replyToId + headers, no dot file remains", async () => {
    const outboxNew = resolve(tempHome, ".tps", "outbox", "new");
    const h = await startDispatcher("anvil", "flint", { localSender: false, branchHost: true });

    await h.deliver({ text: "final verdict" }, { kind: "final" });

    // cli#400: the post happens after the dispatch resolves.
    h.settle();
    await waitFor(() => readdirSafe(outboxNew).filter((f) => f.endsWith(".json") && !f.startsWith(".")).length === 1, 2000);
    const names = readdirSafe(outboxNew);
    const json = names.filter((f) => f.endsWith(".json") && !f.startsWith("."));
    expect(json.length).toBe(1);
    // No staging temp survives the rename.
    expect(names.filter((f) => f.startsWith(".")).length).toBe(0);

    const record = JSON.parse(readFileSync(resolve(outboxNew, json[0]!), "utf-8"));
    expect(record.to).toBe("flint");
    expect(record.from).toBe("anvil");
    expect(record.replyToId).toBeDefined();
    expect(record.headers["X-TPS-InReplyTo"]).toBeDefined();
    const env: Envelope = JSON.parse(record.body);
    expect(env.body).toBe("final verdict");

    abortController.abort();
    try { await h.startPromise; } catch { /* expected */ }
  }, 10000);
});
