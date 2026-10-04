import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import { signEnvelope, type ChainEntry } from "@tpsdev-ai/agent";

import { hashes } from "@noble/ed25519";
hashes.sha512 = (m: Uint8Array) => new Uint8Array(createHash("sha512").update(m).digest());

const realFs = { ...fs };
let removeOnTerminal: { path: string; state: string } | undefined;
let stampError: Error | undefined;
let obligationReadFailure: string | undefined;
let obligationReads = 0;
let failObligationReads = Infinity;
mock.module("node:fs", () => ({
  ...realFs,
  readFileSync: (...args: any[]) => {
    if (args[0] === obligationReadFailure && ++obligationReads <= failObligationReads) {
      throw Object.assign(new Error("injected obligation read failure"), { code: "EACCES" });
    }
    return (realFs.readFileSync as any)(...args);
  },
  openSync: (...args: any[]) => {
    if (stampError && String(args[0]).includes(".ack-")) throw stampError;
    return (realFs.openSync as any)(...args);
  },
  writeFileSync: (...args: any[]) => {
    const result = (realFs.writeFileSync as any)(...args);
    if (removeOnTerminal && String(args[0]).includes(".obligations/") && typeof args[1] === "string") {
      if (JSON.parse(args[1]).state === removeOnTerminal.state) {
        realFs.unlinkSync(removeOnTerminal.path);
        removeOnTerminal = undefined;
      }
    }
    return result;
  },
}));

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
  removeOnTerminal = undefined;
  stampError = undefined;
  obligationReadFailure = undefined;
  obligationReads = 0;
  failObligationReads = Infinity;
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

    it(`${kind}: a missing record is reported after the durable transition`, async () => {
      const h = await boot(true);
      try {
        expect(await pollUntil(() => h.dispatch() !== null)).toBe(true);
        const cur = readCur()!;
        removeOnTerminal = { path: cur.path, state };
        await finish(h);
        expect(await pollUntil(() => failedLogs(h, `${kind}-stamp-failed`).length > 0)).toBe(true);
        expect(failedLogs(h, `${kind}-stamp-failed`)[0]).toContain(`actor=anvil state=${state} path=${cur.path} code=ENOENT`);
        expect(failedLogs(h, `${kind}-stamp-failed`)[0]).toContain("inspect the missing cur record; obligation retained");
        expect(obligation(h.inboundId)?.state).toBe(state);
        await sleep(400);
        expect(failedLogs(h, `${kind}-stamp-failed`).length).toBe(1);
        expect(realFs.existsSync(cur.path)).toBe(false);
      } finally {
        await h.stop();
      }
    }, 15000);

    it(`${kind}: an exception without a code is reported and remains retryable`, async () => {
      const h = await boot(true);
      try {
        expect(await pollUntil(() => h.dispatch() !== null)).toBe(true);
        stampError = new Error("injected stamp failure");
        await finish(h);
        expect(await pollUntil(() => failedLogs(h, `${kind}-stamp-failed`).length > 0)).toBe(true);
        const diagnostic = failedLogs(h, `${kind}-stamp-failed`)[0];
        expect(diagnostic).toContain(`actor=anvil state=${state}`);
        expect(diagnostic).toContain("code=WRITE_FAILED");
        expect(diagnostic).toContain("retry 1");
        stampError = undefined;
        expect(await pollUntil(() => !!readCur()?.record?.[stampKey])).toBe(true);
        expect(obligation(h.inboundId)?.state).toBe(state);
      } finally {
        stampError = undefined;
        await h.stop();
      }
    }, 15000);

    it(`${kind}: stopping the account cancels the pending stamp retries`, async () => {
      setStampRetryDelaysForTests([731, 731, 731]);
      const realSetTimeout = globalThis.setTimeout;
      let scheduled = 0;
      let fired = 0;
      const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, delay: number, ...args: any[]) => {
        if (delay !== 731) return realSetTimeout(fn, delay, ...args);
        scheduled++;
        return realSetTimeout(() => { fired++; fn(...args); }, delay);
      }) as typeof setTimeout);
      const h = await boot(true);
      expect(await pollUntil(() => h.dispatch() !== null, 4000), "dispatch started").toBe(true);
      const cur = readCur();
      expect(cur, "the inbound was promoted to cur/").not.toBeNull();
      const restore = breakCur(cur!.path);
      try {
        await finish(h);
        expect(await pollUntil(() => failedLogs(h, `${kind}-stamp-failed`).length >= 1, 4000), "first failure logged").toBe(true);
        expect(scheduled).toBe(1);
        await h.stop();
      } finally {
        restore();
      }
      const before = failedLogs(h, `${kind}-stamp-failed`).length;
      try {
        await sleep(1200);
        expect(fired, "the pending timer callback never runs after stop").toBe(0);
      } finally {
        timerSpy.mockRestore();
      }
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

for (const failReads of [Infinity, 1]) {
  it(`startup retains an unreadable terminal obligation without redispatch (failed reads: ${failReads})`, async () => {
    const first = await boot(true);
    expect(await pollUntil(() => first.dispatch() !== null)).toBe(true);
    await first.deliver("verdict");
    first.settle();
    expect(await pollUntil(() => !!readCur()?.record?.ackedAt)).toBe(true);
    await first.stop();
    const cur = readCur()!;
    delete cur.record.ackedAt;
    realFs.writeFileSync(cur.path, JSON.stringify(cur.record));
    const path = resolve(mailDir, "anvil", ".obligations", `${first.inboundId}.json`);
    const terminal = JSON.parse(realFs.readFileSync(path, "utf8"));
    terminal.lastTransitionAt = new Date(0).toISOString();
    realFs.writeFileSync(path, JSON.stringify(terminal));
    const bytes = realFs.readFileSync(path, "utf8");
    obligationReadFailure = path;
    failObligationReads = failReads;
    const second = await boot(false);
    try {
      expect(await pollUntil(() => second.logs.some((m) => m.includes(path) && m.includes("code=EACCES")))).toBe(true);
      await sleep(300);
      expect(second.dispatch()).toBeNull();
      expect(second.logs.some((m) => m.includes(`delivering ${first.inboundId} `))).toBe(false);
      expect(realFs.readFileSync(path, "utf8")).toBe(bytes);
      expect(realFs.existsSync(cur.path)).toBe(true);
      expect(JSON.parse(realFs.readFileSync(cur.path, "utf8")).ackedAt).toBeUndefined();
      expect(second.logs.some((m) => m.includes("actor=anvil state=unknown") && m.includes(path) && m.includes("restore readable records and restart the account"))).toBe(true);
    } finally {
      await second.stop();
      obligationReadFailure = undefined;
    }
    const third = await boot(false);
    try {
      expect(await pollUntil(() => !!readCur()?.record?.ackedAt)).toBe(true);
      expect(third.dispatch()).toBeNull();

    } finally {
      await third.stop();
    }
  }, 15000);
}
