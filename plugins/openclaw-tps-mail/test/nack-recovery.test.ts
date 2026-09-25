/**
 * nack-recovery.test.ts — cli#389 round 12, item 1 (CodeRabbit, Major).
 *
 * Startup used to AWAIT each owed-nack retry in turn, and connecting to an
 * unreachable remote branch has no application-level timeout — so one dead
 * branch could stall recovery for this agent and every later one. The retry now
 * runs IN THE BACKGROUND, not awaited on the startup path, each under an overall
 * timeout (the connection AND the existing ACK wait) that closes the transport
 * on expiry and logs BY NAME.
 *
 * The wire transport is mocked so "a connect that never resolves" is exactly
 * reproducible. The mock DELEGATES to the real relay unless the hang toggle is
 * on, so nothing else in the suite observes a behaviour change.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";import { tmpdir } from "node:os";

// The REAL relay module is captured with a STATIC import (the locality suite's
// pattern) and spread eagerly; the mock only replaces `deliverToRemoteBranch`,
// and only when `relay.hang` is set.
import * as realRelay from "@tpsdev-ai/cli/utils/relay";
const realRelayExports = { ...realRelay };
const relay = {
  hang: false,
  deliver: [] as Array<{ branchId: string; msg: any }>,
};
mock.module("@tpsdev-ai/cli/utils/relay", () => ({
  ...realRelayExports,
  deliverToRemoteBranch: (branchId: string, msg: any, opts?: any) => {
    if (relay.hang) return new Promise<void>(() => {}); // connect never resolves
    relay.deliver.push({ branchId, msg });
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
  process.env.HOME = home;
  process.env.TPS_TEST_KEYS_DIR = keysDir;
  process.env.TPS_NACK_RETRY_TIMEOUT_MS = "1000";
});

afterEach(() => {
  try { controller.abort(); } catch { /* */ }
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origKeys === undefined) delete process.env.TPS_TEST_KEYS_DIR; else process.env.TPS_TEST_KEYS_DIR = origKeys;
  if (origTimeout === undefined) delete process.env.TPS_NACK_RETRY_TIMEOUT_MS; else process.env.TPS_NACK_RETRY_TIMEOUT_MS = origTimeout;
  for (const d of [mailDir, home, keysDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** The durable shape an owed nack leaves: a `failed` record with nackPending. */
function seedOwedNack(inboundId: string, reason: string): void {
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

    const { startPromise, warned, infos } = start();
    const t0 = Date.now();

    // Startup's LATER steps run while the retry is still in flight. The retention
    // sweep runs AFTER the retry loop, so its summary line is the proof that the
    // loop did not block the start.
    const swept = await pollUntil(() => infos.some((m) => m.includes("obligation retention: removed")), 1000);
    const elapsed = Date.now() - t0;
    expect(swept, "startup's later steps ran without awaiting the retry").toBe(true);
    expect(elapsed, "and did NOT wait for the retry's overall timeout").toBeLessThan(1000);

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
