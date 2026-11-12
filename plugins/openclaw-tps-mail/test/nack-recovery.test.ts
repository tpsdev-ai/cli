import { mailboxReplayStore } from "@tpsdev-ai/agent";
import { buildSignedEnvelope, pubkeyFromSeed } from "../../../packages/cli/test/helpers/stub-flair.js";
/**
 * nack-recovery.test.ts — cli#389 round 12, item 1 (CodeRabbit, Major).
 *
 * Startup used to AWAIT each owed-nack retry in turn, and connecting to an
 * unreachable remote branch has no application-level timeout — so one dead
 * branch could stall recovery for this agent and every later one. The retry now
 * runs IN THE BACKGROUND, not awaited on the startup path, with a connection
 * bound; the relay bounds the send above it and then waits the ACK window, and
 * the background backstop sits above that whole bound (cli#962 round 13). An
 * expired connection or send bound is logged BY NAME (`nack-retry-timeout`); an
 * expired ACK window rejects as delivery unconfirmed and is logged as
 * `could not deliver the nack`.
 *
 * The wire transport is mocked so "a connect that never resolves" is exactly
 * reproducible. The mock DELEGATES to the real relay unless the hang toggle is
 * on, so nothing else in the suite observes a behaviour change.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";import { tmpdir } from "node:os";

// The plugin's refusal path computes the backstop from the relay's own total;
// the accepted window's ceiling comes from the same module.
import { MAX_MAIL_ACK_TIMEOUT_MS } from "@tpsdev-ai/cli/utils/relay";

// The branch side of the wire, for the case that needs a REAL peer: a Noise IK
// listener that ACKs late. Imported from source (the plugin has no subpath for
// it), the way cur-record-write.test.ts imports the transport.
import { generateKeyPair, loadHostIdentity, registerBranch, saveKeyPair } from "../../../packages/cli/src/utils/identity.js";
import { listenForHost } from "../../../packages/cli/src/utils/noise-ik-transport.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER } from "../../../packages/cli/src/utils/wire-mail.js";

// The REAL relay module is captured with a STATIC import (the locality suite's
// pattern) and spread eagerly; the mock only replaces `deliverToRemoteBranch`,
// and only when `relay.hang` is set.
import * as realRelay from "@tpsdev-ai/cli/utils/relay";
const realRelayExports = { ...realRelay };
const relay = {
  hang: false,
  deliver: [] as Array<{ branchId: string; msg: any; opts?: any }>,
};
mock.module("@tpsdev-ai/cli/utils/relay", () => ({
  ...realRelayExports,
  deliverToRemoteBranch: (branchId: string, msg: any, opts?: any) => {
    if (relay.hang) return new Promise<void>(() => {}); // connect never resolves
    relay.deliver.push({ branchId, msg, opts });
    return (realRelayExports.deliverToRemoteBranch as any)(branchId, msg, opts);
  },
}));

const pluginModule = (await import("../src/index.js")).default;

let capturedPlugin: any;
const mockApi: any = {
  registerChannel: ({ plugin }: { plugin: any }) => { capturedPlugin = plugin; },
  registerAgentEventSubscription: () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};
pluginModule.register(mockApi);

const AGENT = "anvil";
const SENDER = "flint";
const KEY_SEED = Buffer.alloc(32, 0x02);

let mailDir: string;
let home: string;
let keysDir: string;
let controller: AbortController;
let origHome: string | undefined;
let origKeys: string | undefined;
let origTimeout: string | undefined;
let origAckTimeout: string | undefined;
let origVaultKey: string | undefined;

beforeEach(() => {
  mailDir = mkdtempSync(join(tmpdir(), "tps-nackrec-mail-"));
  home = mkdtempSync(join(tmpdir(), "tps-nackrec-home-"));
  keysDir = mkdtempSync(join(tmpdir(), "tps-nackrec-keys-"));
  controller = new AbortController();
  relay.hang = false;
  relay.deliver.length = 0;

  writeFileSync(join(keysDir, `${AGENT}.key`), KEY_SEED);

  origHome = process.env.HOME;
  origKeys = process.env.TPS_TEST_KEYS_DIR;
  origTimeout = process.env.TPS_NACK_RETRY_TIMEOUT_MS;
  origAckTimeout = process.env.TPS_MAIL_ACK_TIMEOUT_MS;
  // The relay's `loadHostIdentity` migrates host.seed into a vault, which needs
  // a passphrase; without one it exits the process (the CLI tests set the same).
  origVaultKey = process.env.TPS_VAULT_KEY;
  process.env.TPS_VAULT_KEY = "nack-recovery-test";
  process.env.HOME = home;
  process.env.TPS_TEST_KEYS_DIR = keysDir;
  process.env.TPS_NACK_RETRY_TIMEOUT_MS = "1000";
});

afterEach(() => {
  try { controller.abort(); } catch { /* */ }
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origKeys === undefined) delete process.env.TPS_TEST_KEYS_DIR; else process.env.TPS_TEST_KEYS_DIR = origKeys;
  if (origTimeout === undefined) delete process.env.TPS_NACK_RETRY_TIMEOUT_MS; else process.env.TPS_NACK_RETRY_TIMEOUT_MS = origTimeout;
  if (origAckTimeout === undefined) delete process.env.TPS_MAIL_ACK_TIMEOUT_MS; else process.env.TPS_MAIL_ACK_TIMEOUT_MS = origAckTimeout;
  if (origVaultKey === undefined) delete process.env.TPS_VAULT_KEY; else process.env.TPS_VAULT_KEY = origVaultKey;
  for (const d of [mailDir, home, keysDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** The durable shape an owed nack leaves: a `failed` record with nackPending. */
function seedOwedNack(
  inboundId: string,
  reason: string,
  opts: { senderKeyDelayMs?: number } = {},
): void {
  const seed = Buffer.alloc(32, 1);
  let delayPendingMs = opts.senderKeyDelayMs ?? 0;
  mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({ createMailVerifyClient: async () => ({
    getAgent: async (name: string) => {
      if (name === SENDER && delayPendingMs > 0) {
        const ms = delayPendingMs;
        delayPendingMs = 0;
        await new Promise((r) => setTimeout(r, ms));
      }
      return name === SENDER ? { publicKey: pubkeyFromSeed(seed) } : null;
    },
  }) }));
  const cur = resolve(mailDir, AGENT, "cur");
  mkdirSync(cur, { recursive: true });
  const envelope = buildSignedEnvelope(SENDER, AGENT, "inbound", { [SENDER]: seed });
  writeFileSync(resolve(cur, `${inboundId}.json`), JSON.stringify({ id: inboundId, from: SENDER, to: AGENT,
    body: envelope.body, timestamp: envelope.timestamp, read: false, envelopeId: envelope.messageId, envelope }));
  mailboxReplayStore(resolve(mailDir, AGENT)).recordConsumed(envelope.messageId);
  const dir = resolve(mailDir, AGENT, ".obligations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, `${inboundId}.json`),
    JSON.stringify(
      {
        obligationId: `ob-${inboundId}`,
        inboundId,
        inboundTimestamp: new Date().toISOString(),
        from: SENDER,
        to: AGENT,
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

/** Address the sender as its OWN branch id: off the office, that is remote-branch. */
function routeSenderRemote(branchId: string): void {
  const dir = resolve(home, ".tps", "branch-office", branchId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "remote.json"), JSON.stringify({ host: "127.0.0.1", port: 1, transport: "tcp" }), "utf-8");
}

function start(): { startPromise: Promise<any>; warned: string[]; infos: string[] } {
  const warned: string[] = [];
  const infos: string[] = [];
  const ctx = {
    account: { accountId: "default", mailDir, enabled: true },
    cfg: { bindings: [{ agentId: AGENT, match: { channel: "tps-mail", accountId: "default" } }] },
    log: { info: (m: string) => infos.push(String(m)), warn: (m: string) => warned.push(String(m)), error: () => {} },
    channelRuntime: {
      routing: { buildAgentSessionKey: (p: any) => `agent:${p.agentId}:tps-mail:default:${p.peer.id}` },
      reply: { finalizeInboundContext: async (c: any) => c, dispatchReplyWithBufferedBlockDispatcher: async () => {} },
    },
    abortSignal: controller.signal,
  };
  return { startPromise: capturedPlugin.gateway.startAccount(ctx), warned, infos };
}

async function pollUntil(pred: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

describe("cli#389 round 12 — an owed-nack retry is bounded and off the startup path", () => {
  it("R12-a: an owed nack to a branch whose connect never resolves does not delay startup, and times out by name", async () => {
    const inboundId = "msg-r12-hang";
    const reason = "receipt-malformed";
    seedOwedNack(inboundId, reason);
    routeSenderRemote(SENDER); // flint addressed as its own branch → remote-branch
    relay.hang = true; // the connection never resolves
    // A short connection bound and ACK window keep the retry's backstop (the
    // relay's whole bound for these windows — which includes the channel close
    // grace — plus NACK_RETRY_BACKSTOP_MS) inside this test's poll.
    process.env.TPS_NACK_RETRY_TIMEOUT_MS = "100";
    process.env.TPS_MAIL_ACK_TIMEOUT_MS = "200";

    const { startPromise, warned, infos } = start();
    const t0 = Date.now();

    // Startup's LATER steps run while the retry is still in flight. The retention
    // sweep runs AFTER the retry loop, so its summary line is the proof that the
    // loop did not block the start.
    const swept = await pollUntil(() => infos.some((m) => m.includes("obligation retention: removed")), 1000);
    const elapsed = Date.now() - t0;
    expect(swept, "startup's later steps ran without awaiting the retry").toBe(true);
    expect(elapsed, "and did NOT wait for the retry's backstop").toBeLessThan(1000);

    // …and the retry itself times out BY NAME.
    const timedOut = await pollUntil(
      () => warned.some((m) => m.includes("nack-retry-timeout") && m.includes(inboundId)),
      6000,
    );
    expect(timedOut, "the hung retry times out by name").toBe(true);
    expect(relay.deliver.length, "and nothing was handed to a route").toBe(0);

    controller.abort();
    try { await startPromise; } catch { /* aborted */ }
  }, 20000);
});

describe("cli#962 round 13 — the backstop sits above the relay's whole bound", () => {
  it("R13-a: an ACK after the old backstop but inside the relay's window settles the retry, with no timeout log", async () => {
    const inboundId = "msg-r13-late-ack";
    const reason = "receipt-malformed";
    seedOwedNack(inboundId, reason);
    routeSenderRemote(SENDER); // the sender is its own branch → remote-branch
    // A REAL branch on the wire: a Noise IK listener holding the host's public
    // key as its peer, which answers the deliver 2500 ms later.
    const hostKp = generateKeyPair();
    saveKeyPair(hostKp, resolve(home, ".tps", "identity"), "host");
    const branchKp = generateKeyPair();
    registerBranch(SENDER, branchKp.signing.publicKey, undefined, branchKp.encryption.publicKey);
    const ackDelayMs = 2500;
    const server = await listenForHost(branchKp, new Uint8Array(hostKp.encryption.publicKey), 0, (msg, channel) => {
      if (msg.type !== MSG_MAIL_DELIVER) return;
      const body = msg.body as { id: string };
      setTimeout(() => {
        void channel.send({ type: MSG_MAIL_ACK, seq: 0, ts: new Date().toISOString(), body: { id: body.id, accepted: true } });
      }, ackDelayMs);
    });
    writeFileSync(
      resolve(home, ".tps", "branch-office", SENDER, "remote.json"),
      JSON.stringify({ host: "127.0.0.1", port: server.port?.() ?? 0, transport: "tcp" }),
      "utf-8",
    );
    // A 100 ms connection bound and a 3000 ms ACK window: the ACK arrives at
    // 2500 ms, past the old backstop (100 + 2000) and inside the window.
    process.env.TPS_NACK_RETRY_TIMEOUT_MS = "100";
    process.env.TPS_MAIL_ACK_TIMEOUT_MS = "3000";
    try {
      const { startPromise, warned } = start();
      const delivered = await pollUntil(
        () => warned.some((m) => m.includes("nack delivered to") && m.includes(inboundId)),
        6000,
      );
      expect(delivered, "the late ACK settled the retry").toBe(true);
      expect(warned.filter((m) => m.includes("nack-retry-timeout"))).toEqual([]);
      // The windows the retry passed are the ones its backstop is computed from.
      expect(relay.deliver).toHaveLength(1);
      expect(relay.deliver[0]?.opts?.timeoutMs).toBe(100);
      expect(relay.deliver[0]?.opts?.ackTimeoutMs).toBe(3000);
      controller.abort();
      try { await startPromise; } catch { /* aborted */ }
    } finally {
      await server.close();
    }
  }, 20000);
});

/** Wait `ms`, then report whether a line matching `pred` appeared. */
async function quietFor(ms: number, warned: string[], pred: (m: string) => boolean): Promise<string[]> {
  await new Promise((r) => setTimeout(r, ms));
  return warned.filter(pred);
}

describe("cli#962 round 15 — a window the retry cannot hold", () => {
  it("R15-a: a malformed ACK window names the owed nack, startup still completes, and the debt stays", async () => {
    const inboundId = "msg-r15-bad-window";
    const reason = "receipt-malformed";
    seedOwedNack(inboundId, reason);
    routeSenderRemote(SENDER);
    process.env.TPS_MAIL_ACK_TIMEOUT_MS = "soon";

    const { startPromise, warned, infos } = start();

    // The post-loop retention sweep is the proof that the refusal did not fail
    // or stall the startup path.
    const swept = await pollUntil(() => infos.some((m) => m.includes("obligation retention: removed")), 2000);
    expect(swept, "startup's later steps ran").toBe(true);

    const named = await pollUntil(
      () => warned.some((m) => m.includes("nack-retry-config") && m.includes(inboundId) && m.includes(SENDER)),
      1000,
    );
    expect(named, "the refusal names the inbound id and the sender").toBe(true);
    expect(relay.deliver.length, "nothing was handed to a route").toBe(0);

    // No retry ran, so no timeout line may follow.
    expect(await quietFor(300, warned, (m) => m.includes("nack-retry-timeout"))).toEqual([]);

    const rec = JSON.parse(readFileSync(resolve(mailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8"));
    expect(rec.nackPending).toBe(true);
    expect(rec.nackSentAt).toBeUndefined();

    controller.abort();
    try { await startPromise; } catch { /* aborted */ }
  }, 20000);

  it("R15-b: a window whose backstop would overflow the timer limit is refused, never armed at 1 ms", async () => {
    const inboundId = "msg-r15-timer-overflow";
    seedOwedNack(inboundId, "receipt-malformed");
    routeSenderRemote(SENDER);
    // The largest accepted window with the default connection bound leaves the
    // relay's total one millisecond under the limit, so the backstop above it
    // cannot be a timer. A setTimeout past the limit fires after 1 ms.
    process.env.TPS_NACK_RETRY_TIMEOUT_MS = "20000";
    process.env.TPS_MAIL_ACK_TIMEOUT_MS = String(MAX_MAIL_ACK_TIMEOUT_MS);

    const { startPromise, warned, infos } = start();

    const swept = await pollUntil(() => infos.some((m) => m.includes("obligation retention: removed")), 2000);
    expect(swept, "startup's later steps ran").toBe(true);

    const named = await pollUntil(
      () => warned.some((m) => m.includes("nack-retry-config") && m.includes(inboundId)),
      1000,
    );
    expect(named, "the refusal names the inbound id").toBe(true);
    expect(relay.deliver.length, "nothing was handed to a route").toBe(0);
    expect(await quietFor(300, warned, (m) => m.includes("nack-retry-timeout"))).toEqual([]);

    controller.abort();
    try { await startPromise; } catch { /* aborted */ }
  }, 20000);
});

describe("cli#962 round 20 — a non-remote retry's backstop sits above its send bound", () => {
  it("R20-a: a local retry whose send settles after ~3 s logs no timeout and pays the nack", async () => {
    const inboundId = "msg-r20-slow-local";
    // The inbound's verification (inside the local send) takes 3 s: past the
    // old 2000 ms backstop, well inside the configured connection bound.
    seedOwedNack(inboundId, "receipt-malformed", { senderKeyDelayMs: 3000 });
    // The recipient's own maildir exists: off the office that is a local route.
    mkdirSync(resolve(mailDir, SENDER), { recursive: true });
    process.env.TPS_NACK_RETRY_TIMEOUT_MS = "20000";

    const { startPromise, warned, infos } = start();

    const swept = await pollUntil(() => infos.some((m) => m.includes("obligation retention: removed")), 2000);
    expect(swept, "startup's later steps ran").toBe(true);

    const delivered = await pollUntil(
      () => warned.some((m) => m.includes("nack delivered to") && m.includes(inboundId)),
      10_000,
    );
    expect(delivered, "the slow local retry settled and the nack was paid").toBe(true);
    expect(
      warned.filter((m) => m.includes("nack-retry-timeout")),
      "a send inside its bound logged no false timeout",
    ).toEqual([]);

    const rec = JSON.parse(readFileSync(resolve(mailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8"));
    expect(rec.nackSentAt, "the retry was paid").toBeTruthy();
    expect(rec.nackPending, "and the record no longer owes it").toBeFalsy();

    controller.abort();
    try { await startPromise; } catch { /* aborted */ }
  }, 20000);
});

describe("cli#962 round 18 — the ACK window is read only for a remote-branch retry", () => {
  it("R18-a: a malformed ACK window does not refuse an owed nack to a LOCAL sender", async () => {
    const inboundId = "msg-r18-local";
    seedOwedNack(inboundId, "receipt-malformed");
    // The recipient's own maildir exists: off the office that is a local route.
    mkdirSync(resolve(mailDir, SENDER), { recursive: true });
    process.env.TPS_MAIL_ACK_TIMEOUT_MS = "soon";

    const { startPromise, warned, infos } = start();

    const swept = await pollUntil(() => infos.some((m) => m.includes("obligation retention: removed")), 2000);
    expect(swept, "startup's later steps ran").toBe(true);

    const delivered = await pollUntil(
      () => warned.some((m) => m.includes("nack delivered to") && m.includes(inboundId)),
      3000,
    );
    expect(delivered, "the owed nack to a local sender was retried and delivered").toBe(true);
    expect(
      warned.filter((m) => m.includes("nack-retry-config")),
      "the malformed window did not refuse the local retry",
    ).toEqual([]);

    const rec = JSON.parse(readFileSync(resolve(mailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8"));
    expect(rec.nackSentAt, "the retry was paid").toBeTruthy();
    expect(rec.nackPending, "and the record no longer owes it").toBeFalsy();

    controller.abort();
    try { await startPromise; } catch { /* aborted */ }
  }, 20000);

  it("R18-b: a malformed ACK window still refuses an owed nack to a REMOTE-BRANCH sender", async () => {
    const inboundId = "msg-r18-remote";
    seedOwedNack(inboundId, "receipt-malformed");
    routeSenderRemote(SENDER); // the sender is its own branch → remote-branch
    process.env.TPS_MAIL_ACK_TIMEOUT_MS = "soon";

    const { startPromise, warned, infos } = start();

    const swept = await pollUntil(() => infos.some((m) => m.includes("obligation retention: removed")), 2000);
    expect(swept, "startup's later steps ran").toBe(true);

    const named = await pollUntil(
      () => warned.some((m) => m.includes("nack-retry-config") && m.includes(inboundId) && m.includes(SENDER)),
      1000,
    );
    expect(named, "the refusal names the inbound id and the sender").toBe(true);
    expect(warned.filter((m) => m.includes("nack delivered to")), "nothing was delivered").toEqual([]);
    expect(relay.deliver.length, "and nothing was handed to a route").toBe(0);

    const rec = JSON.parse(readFileSync(resolve(mailDir, AGENT, ".obligations", `${inboundId}.json`), "utf-8"));
    expect(rec.nackPending).toBe(true);
    expect(rec.nackSentAt).toBeUndefined();

    controller.abort();
    try { await startPromise; } catch { /* aborted */ }
  }, 20000);
});
