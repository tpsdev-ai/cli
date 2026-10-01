// cli#444 — the codex runtime records liveness on Flair's Presence resource and
// NEVER writes the agent's own Agent row: in Flair `Agent.status` is the
// principal's lifecycle state, so a value other than `active` deactivates the
// agent.
//
// These tests drive the PRODUCTION wiring — key resolution for a generated
// config, the heartbeat timer, and the signal handler — against a fake client
// that records every call it receives, so an Agent write in the Presence helpers
// or the signal handler makes a test fail.
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, verify as edVerify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishRuntimePresence,
  resolveRuntimeKeyPath,
  shutdownHandler,
  shutdownPresenceBeat,
  startPresenceHeartbeat,
} from "../src/utils/codex-runtime.js";
import { FlairClient } from "../src/utils/flair-client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake Flair client that records every call it receives. */
function fakeClient(opts: { presenceDelayMs?: number; presenceNever?: boolean } = {}) {
  const calls: string[] = [];
  const client = {
    async presence(activity?: string) {
      calls.push(`PRESENCE ${activity ?? "(liveness)"}`);
      if (opts.presenceNever) await new Promise<void>(() => {});
      else if (opts.presenceDelayMs) await new Promise((r) => setTimeout(r, opts.presenceDelayMs));
    },
    async request(method: string, path: string) {
      calls.push(`${method} ${path}`);
    },
  };
  const agentWrites = () => calls.filter((c) => /^(PATCH|PUT) \/Agent\//.test(c));
  return { calls, client, agentWrites };
}

/** A fresh Ed25519 key as a 32-byte seed, plus its public key. */
function keySeed(): { seed: Buffer; publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"] } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  return { seed, publicKey };
}

describe("codex runtime presence (cli#444)", () => {
  it(
    "resolves the agent's registered key when the config omits flair.keyPath",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "cli444-keys-"));
      const saved = process.env.TPS_TEST_KEYS_DIR;
      try {
        process.env.TPS_TEST_KEYS_DIR = dir;
        writeFileSync(join(dir, "testbot.key"), keySeed().seed);
        // A GENERATED config (as `tps agent create` writes it) omits flair.keyPath.
        expect(resolveRuntimeKeyPath("testbot", undefined)).toBe(join(dir, "testbot.key"));
        // An explicit path always wins.
        expect(resolveRuntimeKeyPath("testbot", "/custom/key")).toBe("/custom/key");
      } finally {
        if (saved === undefined) delete process.env.TPS_TEST_KEYS_DIR;
        else process.env.TPS_TEST_KEYS_DIR = saved;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it(
    "signs an AUTHENTICATED Presence request with the key resolved from a generated config",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "cli444-auth-"));
      const saved = process.env.TPS_TEST_KEYS_DIR;
      const { seed, publicKey } = keySeed();
      let authHeader = "";
      let target = "";
      const server = createServer((req, res) => {
        authHeader = req.headers.authorization ?? "";
        target = `${req.method} ${req.url}`;
        res.statusCode = 204;
        res.end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      try {
        process.env.TPS_TEST_KEYS_DIR = dir;
        writeFileSync(join(dir, "testbot.key"), seed);
        // The generated config omits flair.keyPath; the runtime resolves the key.
        const keyPath = resolveRuntimeKeyPath("testbot", undefined);
        const client = new FlairClient({ baseUrl: `http://127.0.0.1:${port}`, agentId: "testbot", keyPath });
        await client.presence("idle");

        expect(target).toBe("POST /Presence");
        const m = /^TPS-Ed25519 (testbot):(\d+):([0-9a-f-]+):(.+)$/.exec(authHeader);
        expect(m, `auth header: ${authHeader}`).not.toBeNull();
        // The signature covers "<agentId>:<ts>:<nonce>:<METHOD>:<path>".
        const payload = `${m?.[1]}:${m?.[2]}:${m?.[3]}:POST:/Presence`;
        const ok = edVerify(null, Buffer.from(payload), publicKey, Buffer.from(m?.[4] ?? "", "base64"));
        expect(ok, "the Presence request was signed by the agent's key").toBe(true);
      } finally {
        server.close();
        if (saved === undefined) delete process.env.TPS_TEST_KEYS_DIR;
        else process.env.TPS_TEST_KEYS_DIR = saved;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it(
    "beats at startup and on its own timer, independent of a long task, and never writes /Agent",
    async () => {
      const { calls, client, agentWrites } = fakeClient();
      const stop = startPresenceHeartbeat(client as never, "testbot", 20);
      try {
        // A "long task": the loop below is busy, and the timer alone keeps beating.
        await sleep(150);
      } finally {
        stop();
      }
      const beats = calls.filter((c) => c === "PRESENCE (liveness)").length;
      expect(beats, "startup beat plus timer beats").toBeGreaterThanOrEqual(5);
      expect(agentWrites()).toEqual([]);
    },
    10_000,
  );

  it(
    "awaits a DELAYED final beat before exiting, and never writes /Agent",
    async () => {
      const { calls, client, agentWrites } = fakeClient({ presenceDelayMs: 60 });
      let exitCode: number | undefined;
      let stopped = false;
      const onSignal = shutdownHandler(
        client as never,
        "testbot",
        () => { stopped = true; },
        (code) => { exitCode = code; },
        2000,
      );
      onSignal();
      expect(stopped, "the heartbeat timer was stopped").toBe(true);
      await sleep(20);
      expect(exitCode, "still waiting for the delayed beat").toBeUndefined();
      await sleep(140);
      expect(exitCode).toBe(0);
      expect(calls).toEqual(["PRESENCE idle"]);
      expect(agentWrites()).toEqual([]);
    },
    10_000,
  );

  it(
    "bounds the final beat when the request never settles",
    async () => {
      const { calls, client, agentWrites } = fakeClient({ presenceNever: true });
      let exitCode: number | undefined;
      const onSignal = shutdownHandler(client as never, "testbot", () => {}, (code) => { exitCode = code; }, 80);
      onSignal();
      await sleep(250);
      expect(exitCode).toBe(0); // the bound fired
      expect(calls).toEqual(["PRESENCE idle"]);
      expect(agentWrites()).toEqual([]);
    },
    10_000,
  );

  it(
    "a Presence failure only logs — it never throws and never falls back to /Agent",
    async () => {
      const calls: string[] = [];
      const client = {
        async presence(activity?: string) {
          calls.push(`PRESENCE ${activity ?? "(liveness)"}`);
          throw new Error("presence down");
        },
        async request(method: string, path: string) {
          calls.push(`${method} ${path}`);
        },
      };
      await publishRuntimePresence(client as never, "testbot");
      await shutdownPresenceBeat(client as never, "testbot", 100);
      // Both beats were attempted; neither fell back to an Agent write.
      expect(calls).toEqual(["PRESENCE (liveness)", "PRESENCE idle"]);
      expect(calls.some((c) => c.includes("/Agent/"))).toBe(false);
    },
    10_000,
  );

  it(
    "FlairClient.presence POSTs /Presence (and nothing on /Agent)",
    async () => {
      const client = new FlairClient({ baseUrl: "http://127.0.0.1:9", agentId: "testbot", keyPath: "/nonexistent" });
      const calls: string[] = [];
      // Spy the request the method builds; the signer/key path is exercised in
      // the client's own tests and in the authenticated request above.
      (client as unknown as { request: (m: string, p: string, b?: unknown) => Promise<unknown> }).request =
        async (method: string, path: string, body?: unknown) => {
          calls.push(`${method} ${path} ${JSON.stringify(body)}`);
          return undefined;
        };

      await client.presence("idle");
      expect(calls).toEqual(['POST /Presence {"activity":"idle"}']);

      await client.presence();
      expect(calls[1]).toBe("POST /Presence {}");
      expect(calls.some((c) => c.includes("/Agent/"))).toBe(false);
    },
    10_000,
  );
});
