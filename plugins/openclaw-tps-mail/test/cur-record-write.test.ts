/**
 * cur-record-write.test.ts — cli#492.
 *
 * After a DURABLE terminal transition (acked/failed) the plugin stamps the cur/
 * record (`ackedAt` / `nackedAt`). The old `patchMailFile` swallowed a failed
 * write, so the on-disk record and the plugin's view could diverge with no
 * diagnostic.
 *
 * These tests inject a write failure (the cur/ DIRECTORY is made unwritable, so
 * the atomic stamp's temp file cannot be created) and assert:
 *   (a) a diagnostic naming the message id, the record path and the error code;
 *   (b) a bounded in-process retry fixes a transient failure without a restart;
 *   (c) a persistent failure stops after the bound and the next account start
 *       re-stamps the record;
 *   (d) stopping the account cancels pending retries.
 * A further test pins the successful path as unchanged.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import { signEnvelope, type ChainEntry } from "@tpsdev-ai/agent";

import { hashes } from "@noble/ed25519";
hashes.sha512 = (m: Uint8Array) => new Uint8Array(createHash("sha512").update(m).digest());

const FLINT_SEED = Buffer.alloc(32, 0x01);
const ANVIL_SEED = Buffer.alloc(32, 0x02);
const pubkeyFromSeed = (s: Buffer): Buffer => Buffer.from(ed.getPublicKey(new Uint8Array(s)));

import pluginModule, { setStampRetryDelaysForTests } from "../src/index.js";

let capturedPlugin: any;
const mockApi: any = {
  registerChannel: ({ plugin }: { plugin: any }) => { capturedPlugin = plugin; },
  registerAgentEventSubscription: () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};
pluginModule.register(mockApi);

let mailDir: string;
let keysDir: string;
let home: string;
let origHome: string | undefined;
let origKeys: string | undefined;
let prevDelays: number[];

beforeEach(() => {
  mailDir = mkdtempSync(join(tmpdir(), "tps-492-mail-"));
  keysDir = mkdtempSync(join(tmpdir(), "tps-492-keys-"));
  home = mkdtempSync(join(tmpdir(), "tps-492-home-"));
  writeFileSync(join(keysDir, "anvil.key"), ANVIL_SEED);
  writeFileSync(join(keysDir, "flint.key"), FLINT_SEED);
  prevDelays = setStampRetryDelaysForTests([100, 100, 100]);
  origHome = process.env.HOME; process.env.HOME = home;
  origKeys = process.env.TPS_TEST_KEYS_DIR; process.env.TPS_TEST_KEYS_DIR = keysDir;
  mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
    createMailVerifyClient: async () => ({
      async getAgent(name: string) {
        if (name === "flint") return { publicKey: pubkeyFromSeed(FLINT_SEED) };
        if (name === "anvil") return { publicKey: pubkeyFromSeed(ANVIL_SEED) };
        return null;
      },
    }),
  }));
});

afterEach(() => {
  setStampRetryDelaysForTests(prevDelays);
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origKeys === undefined) delete process.env.TPS_TEST_KEYS_DIR; else process.env.TPS_TEST_KEYS_DIR = origKeys;
  for (const d of [mailDir, keysDir, home]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(pred: () => boolean, ms = 4000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (pred()) return true; await sleep(10); }
  return pred();
}

function signedBody(from: string, to: string, body: string, seed: Buffer): string {
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: new Date().toISOString(), rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: new Date().toISOString(), rationale: `agent ${from}`, signature: null },
  ];
  return JSON.stringify(signEnvelope(
    { v: 1, from, to, body, messageId: `env-${Math.random().toString(36).slice(2, 10)}`, timestamp: new Date().toISOString(), delegationChain: chain },
    { [from]: seed },
  ));
}

/** The anvil cur/ record (promote() names it for the inbound id). */
function readCur(): { path: string; record: any } | null {
  const dir = resolve(mailDir, "anvil", "cur");
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const p = join(dir, n);
    try { return { path: p, record: JSON.parse(readFileSync(p, "utf-8")) }; } catch { /* torn */ }
  }
  return null;
}
function obligation(id: string): any | null {
  try { return JSON.parse(readFileSync(resolve(mailDir, "anvil", ".obligations", `${id}.json`), "utf-8")); } catch { return null; }
}

interface Boot {
  inboundId: string;
  logs: string[];
  dispatch: () => any;
  deliver: (text: string) => Promise<void>;
  skip: (reason?: string) => void;
  settle: () => void;
  stop: () => Promise<void>;
}

/** Start one account. `withInbound` writes a new inbound so a turn is dispatched. */
async function boot(withInbound: boolean): Promise<Boot> {
  mkdirSync(resolve(mailDir, "flint", "new"), { recursive: true });
  mkdirSync(resolve(mailDir, "anvil", "new"), { recursive: true });
  const inboundId = `msg-${Math.random().toString(36).slice(2, 10)}`;
  if (withInbound) {
    writeFileSync(resolve(mailDir, "anvil", "new", `2026-05-26T00-00-00-${inboundId}.json`), JSON.stringify({
      id: inboundId, from: "flint", to: "anvil", body: signedBody("flint", "anvil", "inbound", FLINT_SEED),
      timestamp: new Date().toISOString(), headers: { "X-TPS-Trust": "agent", "X-TPS-Surface": "tps-mail" }, deliveryAttempts: 0,
    }, null, 2), "utf-8");
  }
  let dispatchedArgs: any = null;
  let settleFn: (() => void) | null = null;
  const controller = new AbortController();
  const logs: string[] = [];
  const channelRuntime = {
    routing: { buildAgentSessionKey: (p: any) => `agent:${p.agentId}:tps-mail:default:${p.peer.id}` },
    reply: {
      finalizeInboundContext: async (c: any) => ({ ...c, CommandAuthorized: false }),
      dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
        dispatchedArgs = args;
        await new Promise<void>((res) => { settleFn = res; });
        return { failedCounts: 0 };
      },
    },
  };
  const cfg = { bindings: [{ agentId: "anvil", match: { channel: "tps-mail", accountId: "default" } }] };
  const ctx = {
    account: { accountId: "default", mailDir, enabled: true },
    cfg,
    log: { info: (m: string) => logs.push(String(m)), warn: (m: string) => logs.push(String(m)), error: (m: string) => logs.push(String(m)) },
    channelRuntime,
    abortSignal: controller.signal,
  };
  const startPromise = capturedPlugin.gateway.startAccount(ctx);
  return {
    inboundId, logs,
    dispatch: () => dispatchedArgs,
    deliver: async (text: string) => { await dispatchedArgs.dispatcherOptions.deliver({ text }, { kind: "final" }); },
    skip: (reason = "empty") => dispatchedArgs.dispatcherOptions.onSkip?.({ text: "" }, { kind: "final", reason }),
    settle: () => settleFn?.(),
    stop: async () => { controller.abort(); try { await startPromise; } catch { /* aborted */ } },
  };
}

const failedLogs = (h: Boot, tag: string) => h.logs.filter((m) => m.includes(tag) && m.includes(h.inboundId));

/** Make the cur/ record and directory unwritable so the stamp write fails with EACCES. */
function breakCur(path: string): () => void {
  const curDir = resolve(mailDir, "anvil", "cur");
  chmodSync(path, 0o444);
  chmodSync(curDir, 0o555);
  return () => { chmodSync(curDir, 0o755); chmodSync(path, 0o644); };
}

describe("cli#492 — a failed cur/ stamp write is surfaced and retried", () => {
  for (const kind of ["ack", "nack"] as const) {
    const stampKey = kind === "ack" ? "ackedAt" : "nackedAt";
    const state = kind === "ack" ? "acked" : "failed";
    const finish = (h: Boot) => {
      if (kind === "ack") return h.deliver("verdict").then(() => h.settle());
      h.skip("empty"); // an empty/silent final → the named failure path
      h.settle();
      return Promise.resolve();
    };

    it(`${kind}: a transient failed ${stampKey} write is logged by id/path/code and fixed by the in-process retry, no restart`, async () => {
      const h = await boot(true);
      expect(await pollUntil(() => h.dispatch() !== null, 4000), "dispatch started").toBe(true);
      const cur = readCur();
      expect(cur, "the inbound was promoted to cur/").not.toBeNull();
      const restore = breakCur(cur!.path);
      let restored = false;
      try {
        await finish(h);
        expect(await pollUntil(() => obligation(h.inboundId)?.state === state, 4000), "the terminal transition is durable").toBe(true);
        expect(readCur()?.record?.[stampKey], "the stamp did NOT land").toBeUndefined();
        expect(
          await pollUntil(
            () => failedLogs(h, `${kind}-stamp-failed`).some((m) => m.includes(cur!.path) && m.includes("EACCES")),
            4000,
          ),
          "the failed write is logged by id, path and code",
        ).toBe(true);
      } finally {
        restore();
        restored = true;
      }
      expect(restored).toBe(true);
      expect(await pollUntil(() => !!readCur()?.record?.[stampKey], 4000), "the in-process retry stamped the record").toBe(true);
      expect(obligation(h.inboundId)?.state).toBe(state);
      await h.stop();
    }, 20000);

    it(`${kind}: a persistent failure stops after the bound and the next account start re-stamps the record`, async () => {
      const h = await boot(true);
      expect(await pollUntil(() => h.dispatch() !== null, 4000), "dispatch started").toBe(true);
      const cur = readCur();
      expect(cur, "the inbound was promoted to cur/").not.toBeNull();
      const restore = breakCur(cur!.path);
      try {
        await finish(h);
        // initial attempt + 3 retries = 4 logged failures, then no more.
        expect(await pollUntil(() => failedLogs(h, `${kind}-stamp-failed`).length >= 4, 4000), "initial attempt + 3 retries").toBe(true);
        await sleep(400);
        const logged = failedLogs(h, `${kind}-stamp-failed`);
        expect(logged.length, "no attempt beyond the bound").toBe(4);
        expect(logged[3]).toContain("no retries left");
        expect(readCur()?.record?.[stampKey]).toBeUndefined();
      } finally {
        restore();
      }
      await sleep(300);
      expect(readCur()?.record?.[stampKey], "nothing retries after the bound").toBeUndefined();
      await h.stop();

      // NEXT ACCOUNT START: the durable terminal state is re-stamped onto the record.
      const h2 = await boot(false);
      expect(await pollUntil(() => !!readCur()?.record?.[stampKey], 4000), "re-stamped at the next account start").toBe(true);
      if (kind === "ack") expect(readCur()?.record?.read).toBe(true);
      expect(obligation(h.inboundId)?.state).toBe(state);
      await h2.stop();
    }, 20000);

    it(`${kind}: stopping the account cancels the pending stamp retries`, async () => {
      setStampRetryDelaysForTests([300, 300, 300]);
      const h = await boot(true);
      expect(await pollUntil(() => h.dispatch() !== null, 4000), "dispatch started").toBe(true);
      const cur = readCur();
      expect(cur, "the inbound was promoted to cur/").not.toBeNull();
      const restore = breakCur(cur!.path);
      try {
        await finish(h);
        expect(await pollUntil(() => failedLogs(h, `${kind}-stamp-failed`).length >= 1, 4000), "first failure logged").toBe(true);
        await h.stop();
      } finally {
        restore();
      }
      const before = failedLogs(h, `${kind}-stamp-failed`).length;
      await sleep(1200);
      expect(failedLogs(h, `${kind}-stamp-failed`).length, "no retry ran after stop").toBe(before);
      expect(readCur()?.record?.[stampKey], "the cancelled retry never stamped").toBeUndefined();
    }, 20000);
  }

  it("the successful write path is unchanged: a normal ack stamps ackedAt with no diagnostic", async () => {
    const h = await boot(true);
    expect(await pollUntil(() => h.dispatch() !== null, 4000), "dispatch started").toBe(true);
    await h.deliver("verdict");
    h.settle();
    expect(await pollUntil(() => !!readCur()?.record?.ackedAt, 4000)).toBe(true);
    expect(readCur()?.record?.read).toBe(true);
    expect(h.logs.some((m) => m.includes("ack-stamp-failed"))).toBe(false);
    await h.stop();
  }, 15000);
});
