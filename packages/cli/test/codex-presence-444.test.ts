// cli#444 — the codex runtime records liveness on Flair's Presence resource and
// NEVER writes the agent's own Agent row: in Flair `Agent.status` is the
// principal's lifecycle state, so a value other than `active` deactivates the
// agent.
//
// The first tests call the Presence helpers directly. The last two drive the
// REAL `runCodexRuntime` — startup, a mail tick, and a delivered SIGTERM/SIGINT
// — with the Flair client's `fetch` recorded, so an Agent write at the runtime's
// startup site or signal handler makes them fail.
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, verify as edVerify } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishRuntimePresence,
  resolveRuntimeKeyPath,
  runCodexRuntime,
  shutdownHandler,
  shutdownPresenceBeat,
  startPresenceHeartbeat,
} from "../src/utils/codex-runtime.js";
import { FlairClient } from "../src/utils/flair-client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bounded poll: resolve when `cond` is true, else throw at `timeoutMs`. */
async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 5): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(stepMs);
  }
}

/**
 * Drive the REAL `runCodexRuntime` — its startup, mail loop and signal handler —
 * with the Flair client's `fetch` recorded, the mailbox redirected to a temp
 * root, and `process.exit` captured so the test process survives the shutdown
 * handler. Bounded waits only; the runtime's loop keeps running after the signal
 * (bun ends the file) and the signal listeners this run added are removed.
 */
async function driveRuntime(signal: "SIGTERM" | "SIGINT") {
  const dir = mkdtempSync(join(tmpdir(), `cli444-rt-${signal}-`));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const mailRoot = join(dir, "mail");
  const keyPath = join(dir, "testbot.key");
  writeFileSync(keyPath, keySeed().seed);

  const savedFetch = globalThis.fetch;
  const savedExit = process.exit;
  const savedMailDir = process.env.TPS_MAIL_DIR;
  const savedSigterm = process.listeners("SIGTERM");
  const savedSigint = process.listeners("SIGINT");
  const http: string[] = [];
  const presenceBodies: string[] = [];
  let exitCode: number | undefined;
  let rejected: Error | undefined;
  let ticked = false;
  const inboxCur = join(mailRoot, "testbot", "cur");

  process.env.TPS_MAIL_DIR = mailRoot;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    http.push(`${method} ${path}`);
    if (method === "POST" && path === "/Presence") presenceBodies.push(String(init?.body ?? ""));
    if (path === "/Health") return new Response("ok", { status: 200 });
    if (method === "GET" && (path.startsWith("/Soul") || path.startsWith("/OrgEventCatchup"))) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 204 });
  }) as typeof globalThis.fetch;
  process.exit = ((code?: number) => {
    exitCode = code;
  }) as never;

  try {
    runCodexRuntime({
      agentId: "testbot",
      workspace,
      mailDir: join(mailRoot, "testbot"),
      flairUrl: "http://127.0.0.1:9931",
      flairKeyPath: keyPath,
      supervisorId: "flint",
    }).catch((e: Error) => {
      rejected = e;
    });

    await waitFor(() => presenceBodies.length >= 1, 5000); // startup beat
    await waitFor(() => existsSync(inboxCur), 5000); // one mail tick
    ticked = true;
    process.emit(signal);
    await waitFor(() => exitCode !== undefined, 5000); // signal handler ran
    await waitFor(() => presenceBodies.some((b) => b.includes("idle")), 5000);
  } finally {
    globalThis.fetch = savedFetch;
    process.exit = savedExit;
    if (savedMailDir === undefined) delete process.env.TPS_MAIL_DIR;
    else process.env.TPS_MAIL_DIR = savedMailDir;
    for (const l of process.listeners("SIGTERM")) if (!savedSigterm.includes(l)) process.off("SIGTERM", l);
    for (const l of process.listeners("SIGINT")) if (!savedSigint.includes(l)) process.off("SIGINT", l);
  }

  return { http, presenceBodies, exitCode, rejected, ticked };
}

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
    "signs an AUTHENTICATED Presence request with the key resolved when the config omits flair.keyPath",
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
    "beats at startup and on its own timer while the test sleeps, and never writes /Agent",
    async () => {
      const { calls, client, agentWrites } = fakeClient();
      const stop = startPresenceHeartbeat(client as never, "testbot", 20);
      try {
        // The test sleeps; the heartbeat timer alone keeps beating. No task runs.
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
      const warnings: string[] = [];
      const realWarn = console.warn;
      console.warn = ((msg?: unknown) => {
        warnings.push(String(msg ?? ""));
      }) as typeof console.warn;
      try {
        await publishRuntimePresence(client as never, "testbot");
        await shutdownPresenceBeat(client as never, "testbot", 100);
      } finally {
        console.warn = realWarn;
      }
      // Both beats were attempted; each LOGGED its failure and neither fell back
      // to an Agent write.
      expect(calls).toEqual(["PRESENCE (liveness)", "PRESENCE idle"]);
      expect(warnings.filter((w) => w.includes("presence heartbeat failed")).length).toBe(2);
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

  it(
    "runCodexRuntime beats at startup, ticks the mailbox, and beats idle on SIGTERM — never writing /Agent/<id>",
    async () => {
      const r = await driveRuntime("SIGTERM");
      expect(r.rejected).toBeUndefined();
      expect(r.exitCode, "the SIGTERM handler exited").toBe(0);
      // Startup beat (activity omitted), then the bounded final "idle" beat.
      expect(r.presenceBodies[0]).toBe("{}");
      expect(r.presenceBodies.some((b) => b.includes('"idle"'))).toBe(true);
      // The mail loop ran: checkMessages() created the inbox under the temp root.
      expect(r.ticked).toBe(true);
      expect(r.http.some((c) => /^(PATCH|PUT) \/Agent\/testbot$/.test(c))).toBe(false);
    },
    20_000,
  );

  it(
    "runCodexRuntime beats idle on SIGINT and never writes /Agent/<id>",
    async () => {
      const r = await driveRuntime("SIGINT");
      expect(r.rejected).toBeUndefined();
      expect(r.exitCode, "the SIGINT handler exited").toBe(0);
      expect(r.presenceBodies.some((b) => b.includes('"idle"'))).toBe(true);
      expect(r.http.some((c) => /^(PATCH|PUT) \/Agent\/testbot$/.test(c))).toBe(false);
    },
    20_000,
  );
});
