import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { createMailVerifyClient } from "../src/utils/mail-verify.js";
import { startFetchFlair } from "./helpers/fetch-flair.js";
import { verifyEnvelope } from "@tpsdev-ai/agent";
import { defaultMailSender, handleTransition, startPollLoop, pollOnce, checkReminders, type PulseState, type PulseConfig, type PrInstance } from "../src/commands/pulse.js";

test("pulse notification delivers an envelope signed by pulse", async () => {
  const home = mkdtempSync(join(tmpdir(), "pulse-signature-"));
  const saved = Object.fromEntries(["HOME", "TPS_MAIL_DIR", "TPS_TEST_KEYS_DIR"].map((k) => [k, process.env[k]]));
  const seed = Buffer.alloc(32, 0x65);
  const publicKey = Buffer.from(ed.getPublicKey(seed));
  const flair = startFetchFlair({ pulse: seed });
  try {
    process.env.HOME = home;
    process.env.TPS_MAIL_DIR = join(home, "mail");
    process.env.TPS_TEST_KEYS_DIR = join(home, "keys");
    mkdirSync(process.env.TPS_TEST_KEYS_DIR);
    writeFileSync(join(process.env.TPS_TEST_KEYS_DIR, "pulse.key"), seed);
    writeFileSync(join(process.env.TPS_TEST_KEYS_DIR, "flint.key"), Buffer.alloc(32, 0x66));
    const config = { ghAgent: "flint", mergeAuthority: "recipient", author: "recipient", reviewers: [] } as unknown as PulseConfig;
    const instance = { state: "reviewing", history: [], prNumber: 42, title: "Signature test", repo: "example/repo" } as unknown as PrInstance;
    handleTransition("pr:example/repo#42", instance, "approved", config, defaultMailSender);
    const dir = join(process.env.TPS_MAIL_DIR, "recipient", "new");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    const envelope = JSON.parse(record.body);
    expect(record.from).toBe("pulse");
    expect(envelope.from).toBe("pulse");
    expect(envelope.to).toBe("recipient");
    expect(await verifyEnvelope(envelope, await createMailVerifyClient("pulse", { flairUrl: flair.url,
      flairKeyPath: join(process.env.TPS_TEST_KEYS_DIR, "pulse.key") }))).toEqual({ ok: true });
    expect(await verifyEnvelope({ ...envelope, from: "flint" }, { getAgent: async () => ({ publicKey }) })).toMatchObject({ ok: false });
  } finally {
    flair.stop();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
});


describe("pulse signing identity preflight", () => {
  let root: string;
  let saved: Record<string, string | undefined>;
  let previousFetch: typeof fetch;
  let fetchCalls: string[];
  const seed = Buffer.alloc(32, 0x75);
  const config: PulseConfig = { repos: ["example/repo"], reviewers: [], ghAgent: "github",
    author: "author", mergeAuthority: "merger", pollIntervalMs: 1000, remindAfterMs: 1000,
    pruneAfterDays: 7, flairUrl: "http://flair.test" };
  beforeEach(() => {
    saved = Object.fromEntries(["HOME", "TPS_TEST_KEYS_DIR", "TPS_MAIL_DIR"].map(k => [k, process.env[k]]));
    root = mkdtempSync(join(tmpdir(), "pulse-preflight-"));
    process.env.HOME = root;
    delete process.env.TPS_TEST_KEYS_DIR;
    process.env.TPS_MAIL_DIR = join(root, "mail");
    mkdirSync(join(root, ".tps", "identity"), { recursive: true });
    writeFileSync(join(root, ".tps", "identity", "github.key"), Buffer.alloc(32, 0x76));
    previousFetch = globalThis.fetch;
    fetchCalls = [];
    globalThis.fetch = (async (url, init) => {
      fetchCalls.push(String(url));
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>).Authorization).toMatch(/^TPS-Ed25519 pulse:/);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  });
  function state(): PulseState {
    return { version: 1, lastPollAt: "", instances: {
      old: { state: "merged", lastTransitionAt: new Date(0).toISOString(), history: [] } as unknown as PrInstance,
    } };
  }
  async function refuses(expected: RegExp, dryRun = false) {
    const current = state();
    const before = structuredClone(current);
    let calls = 0;
    await expect(startPollLoop(config, current, {
      dryRun,
      runner: () => { calls++; throw new Error("must not poll"); },
      publisher: async () => { calls++; },
      sender: () => { calls++; },
      setIntervalFn: (() => { calls++; }) as typeof setInterval,
    })).rejects.toThrow(expected);
    expect(calls).toBe(0);
    expect(current).toEqual(before);
    expect(existsSync(join(root, ".tps", "pulse"))).toBe(false);
    expect(existsSync(join(root, "mail"))).toBe(false);
  }
  test("missing pulse key refuses before polling, pruning, timers or writes", async () => {
    await refuses(/pulse: signing identity refused: missing pulse signing key.*tps agent create --id pulse/);
    await refuses(/pulse.*tps agent create --id pulse/, true);
    expect(fetchCalls).toEqual([]);
    const current = state();
    const before = structuredClone(current);
    expect(() => pollOnce(config, current, () => { throw new Error("must not poll"); })).toThrow(/pulse.*tps agent create --id pulse/);
    expect(() => handleTransition("old", current.instances.old!, "approved", config, defaultMailSender)).toThrow(/pulse.*tps agent create --id pulse/);
    expect(() => checkReminders(current, config, defaultMailSender, {})).toThrow(/pulse.*tps agent create --id pulse/);
    expect(current).toEqual(before);
  });
  for (const directory of [[".flair", "keys"], [".tps", "identity"]]) {
    test(`unregistered pulse refuses with real key resolution at ${directory.join("/")}`, async () => {
      const dir = join(root, ...directory);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pulse.key"), seed);
      await refuses(/pulse: Flair identity refused: pulse is not registered in Flair.*tps agent create --id pulse/);
      expect(fetchCalls).toEqual(["http://flair.test/Agent/pulse"]);
    });
  }
  test("a registered matching pulse key permits the first poll", async () => {
    writeFileSync(join(root, ".tps", "identity", "pulse.key"), seed);
    globalThis.fetch = (async () => Response.json({ id: "pulse", name: "pulse", publicKey: Buffer.from(ed.getPublicKey(seed)).toString("base64") })) as typeof fetch;
    let polls = 0;
    const callbacks: Array<() => void> = [];
    const running = startPollLoop(config, { version: 1, lastPollAt: "", instances: {} }, {
      runner: () => { polls++; return { status: 0, stdout: "[]", stderr: "" } as any; },
      setIntervalFn: ((fn: () => void) => { callbacks.push(fn); return callbacks.length; }) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });
    for (let i = 0; i < 20 && callbacks.length === 0; i++) await Promise.resolve();
    expect(polls).toBe(1);
    expect(callbacks).toHaveLength(2);
    process.emit("SIGTERM");
    await running;
  });
  test("a mismatched registered key refuses before polling", async () => {
    writeFileSync(join(root, ".tps", "identity", "pulse.key"), seed);
    globalThis.fetch = (async () => Response.json({ id: "pulse", publicKey: Buffer.from(ed.getPublicKey(Buffer.alloc(32, 0x77))).toString("base64") })) as typeof fetch;
    await refuses(/pulse.*does not match.*tps agent create --id pulse/);
  });
});
