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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, watch as fsWatch } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    opts: { localSender?: boolean; bodyFrom?: string; bodySeed?: Buffer; warnCalls?: string[] } = {},
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
      settle: () => settleFn?.(),
    };
  }

  it("F-S0a: a LOCAL recipient gets exactly one signed reply in its maildir, zero in the outbox", async () => {
    const h = await startDispatcher("anvil", "flint", { localSender: true });
    expect(h.dispatched).not.toBeNull();

    await h.deliver({ text: "intermediate narration" }, { kind: "block" });
    await h.deliver({ text: "final verdict" }, { kind: "final" });

    const flintNew = resolve(tempMailDir, "flint", "new");
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

    h.settle();
    abortController.abort();
    try { await h.startPromise; } catch { /* expected */ }
  });

  it("F-S0b: a REMOTE recipient gets exactly one reply in the outbox with X-TPS-InReplyTo, nothing dropped", async () => {
    const h = await startDispatcher("anvil", "flint", { localSender: false });
    expect(h.dispatched).not.toBeNull();

    await h.deliver({ text: "final verdict" }, { kind: "final" });

    // Not dropped: the reply is in the outbox.
    const outboxNew = resolve(tempHome, ".tps", "outbox", "new");
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

    h.settle();
    abortController.abort();
    try { await h.startPromise; } catch { /* expected */ }
  });

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
  });

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

    // The progress note stands AND the dispatcher final is posted (no suppression).
    const files = readdirSafe(flintNew).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(2);
    const bodies = files.map((f) => JSON.parse(readFileSync(resolve(flintNew, f), "utf-8")).body);
    expect(bodies.some((b) => JSON.parse(b).body === "final verdict")).toBe(true);
    expect(bodies.some((b) => JSON.parse(b).body === "progress: starting")).toBe(true);

    h.settle();
    abortController.abort();
    try { await h.startPromise; } catch { /* expected */ }
  });

  it("F-S2d: multiple final payloads produce exactly one post", async () => {
    const h = await startDispatcher("anvil", "flint", { localSender: true });

    await h.deliver({ text: "final one" }, { kind: "final" });
    await h.deliver({ text: "final two" }, { kind: "final" });

    const files = readdirSafe(resolve(tempMailDir, "flint", "new")).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    h.settle();
    abortController.abort();
    try { await h.startPromise; } catch { /* expected */ }
  });

  // ── atomic outbox write (the branch relay drains on every dir event) ──────
  //
  // writeOutboxFile stages to a DOT-PREFIXED temp in the same directory and
  // renames into place. The relay (`branch.ts`) watches outbox/new and calls
  // drainOutbox() on EVERY directory event — including the create event that
  // precedes the bytes — and drainOutbox() quarantines (never retries) a
  // non-dot `.json` that fails JSON.parse. A record written straight to its
  // final name can therefore be read mid-write and LOST. The reader below runs
  // in a SEPARATE process because the write is synchronous and a JS loop in the
  // same process cannot interleave with it.

  /** Spawn a reader that JSON.parses every non-dot `.json` in `dir` for `ms`. */
  function startReader(dir: string, ms: number) {
    const script = join(tmpdir(), `tps-outbox-reader-${randomUUID()}.mjs`);
    writeFileSync(
      script,
      [
        'import { readdirSync, readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        "const deadline = Date.now() + Number(process.argv[3]);",
        "let reads = 0; const bad = []; let sawDot = 0;",
        "while (Date.now() < deadline) {",
        "  let files = [];",
        "  try { files = readdirSync(dir); } catch {}",
        "  for (const f of files) { if (!f.endsWith(\".json\")) continue;",
        "    if (f.startsWith(\".\")) { sawDot = 1; continue; }",
        '    try { JSON.parse(readFileSync(join(dir, f), "utf-8")); reads++; }',
        "    catch { bad.push(f); } }",
        "}",
        'console.log("READS=" + reads + " BAD=" + JSON.stringify(bad) + " DOT=" + sawDot);',
      ].join("\n"),
      "utf-8",
    );
    const child = spawn(process.execPath, [script, dir, String(ms)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    let done = false;
    const exited = new Promise<void>((res) => { child.on("exit", () => { done = true; res(); }); });
    return {
      exited,
      out: () => out,
      stop: async () => {
        if (!done) {
          // Deadline: never leave the reader (or its child) hanging.
          await Promise.race([exited, new Promise((r) => setTimeout(r, 6000))]);
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
        }
        try { rmSync(script, { force: true }); } catch { /* best effort */ }
      },
    };
  }

  it("S0 atomic outbox write: a concurrent reader NEVER sees a torn file, and the final name is never written in place", async () => {
    const outboxNew = resolve(tempHome, ".tps", "outbox", "new");
    mkdirSync(outboxNew, { recursive: true });
    const h = await startDispatcher("anvil", "flint", { localSender: false });
    expect(h.dispatched).not.toBeNull();

    // (i) reader processes: a 32 MiB record is written in chunks, so pollers
    // make a torn read observable if it is possible at all.
    const readers = [startReader(outboxNew, 4000), startReader(outboxNew, 4000), startReader(outboxNew, 4000)];
    // (ii) a directory watcher: the DETERMINISTIC check. An in-place write to
    // the final name emits a `change` event for it; staging to a dot temp and
    // renaming never does (the `change` events land on the temp, and the final
    // name appears only via `rename`). That is exactly the property that makes
    // a concurrent drain unable to read a half-written non-dot record.
    const events: string[] = [];
    const watcher = fsWatch(outboxNew, (_t, f) => { if (f) events.push(`${_t}:${f}`); });
    const isFinalJson = (name: string) => name.endsWith(".json") && !name.startsWith(".");
    try {
      await new Promise((r) => setTimeout(r, 150)); // let the pollers/watcher start
      const big = "x".repeat(32 * 1024 * 1024);
      await h.deliver({ text: big }, { kind: "final" });
      await new Promise((r) => setTimeout(r, 250)); // let watcher events flush
      watcher.close();
      for (const rd of readers) await rd.stop();

      const outs = readers.map((rd) => rd.out());
      for (const out of outs) expect(out).toMatch(/READS=[1-9][0-9]*/); // observed the file
      for (const out of outs) expect(out).toContain("BAD=[]"); // never unparseable

      // The final record appeared (via rename)…
      expect(events.some((e) => e.startsWith("rename:") && isFinalJson(e.slice("rename:".length)))).toBe(true);
      // …and was NEVER changed in place (no `change:` on a non-dot .json).
      const inPlace = events.filter((e) => e.startsWith("change:") && isFinalJson(e.slice("change:".length)));
      expect(inPlace).toEqual([]);
    } finally {
      try { watcher.close(); } catch { /* already closed */ }
      for (const rd of readers) await rd.stop();
      h.settle();
      abortController.abort();
      try { await h.startPromise; } catch { /* expected */ }
    }
  });

  it("S0 positive control: the final outbox file parses, keeps replyToId + headers, no dot file remains", async () => {
    const outboxNew = resolve(tempHome, ".tps", "outbox", "new");
    const h = await startDispatcher("anvil", "flint", { localSender: false });

    await h.deliver({ text: "final verdict" }, { kind: "final" });

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

    h.settle();
    abortController.abort();
    try { await h.startPromise; } catch { /* expected */ }
  });
});
