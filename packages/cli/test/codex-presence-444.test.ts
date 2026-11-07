import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
// cli#444 — the codex runtime records liveness on Flair's Presence resource and
// NEVER writes the agent's own Agent row: in Flair `Agent.status` is the
// principal's lifecycle state, so a value other than `active` deactivates the
// agent.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { generateKeyPairSync, verify as edVerify } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as childProcess from "node:child_process";
import * as runtimeMail from "../src/utils/runtime-mail.js";
import { buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";
import { sendMessage } from "../src/utils/mail.js";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEARTBEAT_INTERVAL_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  publishRuntimePresence,
  resolveRuntimeKeyPath,
  runCodexRuntime,
  shutdownHandler,
  shutdownPresenceBeat,
  startPresenceHeartbeat,
} from "../src/utils/codex-runtime.js";
import { FlairClient } from "../src/utils/flair-client.js";
import { startTaskLoop } from "../src/utils/flair-task-loop.js";
import { startReviewTriggerLoop } from "../src/utils/pr-review-trigger.js";
import { homeDir } from "../src/utils/home.js";
import type { WorkspaceProvider } from "../src/utils/workspace-provider.js";

afterEach(() => { mock.restore(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The review-trigger loop's pre-seeded cursor, so its polls are identifiable. */
const REVIEW_CURSOR_POSITION = "2026-01-01T00:00:00.000Z";

/** Count reads carrying the seeded review cursor. */
function reviewTriggerPolls(http: string[]): number {
  return http.filter((c) => {
    const q = c.indexOf("?");
    if (!c.startsWith("GET /OrgEventCatchup/testbot?") || q === -1) return false;
    return new URLSearchParams(c.slice(q + 1)).get("after") === `${REVIEW_CURSOR_POSITION}\t`;
  }).length;
}

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
 * handler. The signal listeners this run added are removed.
 */
async function driveRuntime(
  signal: "SIGTERM" | "SIGINT",
  afterShutdown?: (http: string[]) => Promise<void>,
  opts: {
    reviewTrigger?: { reviewers: string[]; repo: string };
    signalDuringPreflight?: boolean;
    secondSignal?: "SIGTERM" | "SIGINT";
    preflightError?: Error;
    lateMail?: "poll" | "preparation";
    observeMailAfterExit?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), `cli444-rt-${signal}-`));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const mailRoot = join(dir, "mail");
  // A pre-seeded cursor makes the review-trigger loop's reads distinguishable
  // from the task loop's, both of which read /OrgEventCatchup/testbot.
  if (opts.reviewTrigger) {
    const cursorDir = join(homeDir(), ".tps", "cursors");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, "testbot-review-trigger-task-loop.json"),
      JSON.stringify({ position: `${REVIEW_CURSOR_POSITION}\t`, updatedAt: new Date().toISOString() }),
    );
  }
  const keyPath = join(dir, "testbot.key");
  writeFileSync(keyPath, keySeed().seed);

  const savedPoll = runtimeMail.pollRuntimeMail;
  let mailPolls = 0;
  let releaseMail: (() => void) | undefined;
  let releaseLoop: (() => void) | undefined;
  let releasePreparation: (() => void) | undefined;
  let prepared = 0;
  let resets = 0;
  const state = { ref: "fixture", timestamp: new Date().toISOString(), provider: "test" };
  const workspaceProvider: WorkspaceProvider = {
    type: "test",
    snapshot: async () => {
      prepared++;
      if (opts.lateMail === "preparation") await new Promise<void>((resolve) => { releasePreparation = resolve; });
      return state;
    },
    reset: async () => { resets++; },
    checkpoint: async () => state,
    diff: async () => ({ summary: "" }),
    baseline: async () => state,
  };
  const taskGit = opts.lateMail ? spyOn(childProcess, "spawnSync").mockImplementation(() => ({ status: 1, stdout: "", stderr: "fixture" }) as never) : undefined;
  const taskSpawn = opts.lateMail ? spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("unexpected task launch"); }) : undefined;
  const pollSpy = spyOn(runtimeMail, "pollRuntimeMail").mockImplementation(async (cfg) => {
    mailPolls++;
    const messages = await savedPoll(cfg);
    if (opts.lateMail === "poll" && messages.length) await new Promise<void>((resolve) => { releaseMail = resolve; });
    return messages;
  });
  const savedFetch = globalThis.fetch;
  const savedExit = process.exit;
  const savedSetTimeout = globalThis.setTimeout;
  const savedRead = FlairClient.prototype.getEventsSince;
  const savedPing = FlairClient.prototype.ping;
  const savedMailDir = process.env.TPS_MAIL_DIR;
  const savedSigterm = process.listeners("SIGTERM");
  const savedSigint = process.listeners("SIGINT");
  const http: string[] = [];
  const presenceBodies: string[] = [];
  let exitCode: number | undefined;
  let exits = 0;
  let drains = 0;
  const signalResults: boolean[] = [];
  let rejected: Error | undefined;
  let runtimeFinished = false;
  let ticked = false;
  let successfulReads = 0;
  let releasePreflight: (() => void) | undefined;
  let releaseFinalBeat: (() => void) | undefined;
  const inboxCur = join(mailRoot, "testbot", "cur");

  process.env.TPS_MAIL_DIR = mailRoot;
  if (opts.lateMail) {
    const seeds = { "agent-a": Buffer.alloc(32, 0x57) };
    const envelope = buildSignedEnvelope("agent-a", "testbot", "fixture task", seeds, { trust: "internal" });
    sendMessage("testbot", JSON.stringify(envelope), "agent-a");
  }
  if (opts.preflightError) {
    patchShared(FlairClient.prototype, "ping", async () => {
      await new Promise<void>((resolve) => { releasePreflight = resolve; });
      throw opts.preflightError;
    });
  }
  patchShared(FlairClient.prototype, "getEventsSince", async function (...args) {
    if (opts.lateMail && resets === 1) await new Promise<void>((resolve) => { releaseLoop = resolve; });
    const read = await savedRead.apply(this, args);
    if (read.status === "ok") successfulReads++;
    return read;
  });
  patchShared(globalThis, "fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    http.push(`${method} ${path}`);
    if (method === "POST" && path === "/Presence") {
      const body = String(init?.body ?? "");
      presenceBodies.push(body);
      if (opts.preflightError && body.includes('"idle"')) {
        await new Promise<void>((resolve) => { releaseFinalBeat = resolve; });
      }
    }
    expect(new URL(url).origin).toBe("http://127.0.0.1:9931");
    if (path === "/Agent/agent-a") {
      return Response.json({ id: "agent-a", publicKey: pubkeyFromSeed(Buffer.alloc(32, 0x57)).toString("base64") });
    }
    if (path.startsWith("/WorkspaceState")) return Response.json([]);
    if (path === "/Health") {
      if (opts.signalDuringPreflight) await new Promise<void>((resolve) => { releasePreflight = resolve; });
      return new Response("ok", { status: 200 });
    }
    if (method === "GET" && path.startsWith("/OrgEventCatchup")) {
      const after = new URL(url).searchParams.get("after") ?? new URL(url).searchParams.get("since");
      return Response.json({ events: [], nextAfter: after, hasMore: false });
    }
    if (method === "GET" && path.startsWith("/Soul")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 204 });
  }) as typeof globalThis.fetch);
  patchShared(process, "exit", ((code?: number) => {
    exitCode = code;
    exits++;
  }) as never);

  try {
    runCodexRuntime({
      agentId: "testbot",
      workspace,
      mailDir: join(mailRoot, "testbot"),
      flairUrl: "http://127.0.0.1:9931",
      flairKeyPath: keyPath,
      supervisorId: "agent-supervisor",
      reviewTrigger: opts.reviewTrigger,
      workspaceProvider: opts.lateMail ? workspaceProvider : undefined,
    }).then(() => { runtimeFinished = true; }).catch((e: Error) => {
      rejected = e;
    });

    await waitFor(() => presenceBodies.length >= 1, 5000); // startup beat
    if (opts.signalDuringPreflight) {
      await waitFor(() => releasePreflight !== undefined);
    } else if (opts.lateMail) {
      await waitFor(() => releaseLoop !== undefined && (opts.lateMail === "poll" ? releaseMail !== undefined : releasePreparation !== undefined));
      taskGit!.mockClear();
    } else {
      await waitFor(() => existsSync(inboxCur), 5000); // one mail tick
      ticked = true;
      await waitFor(() => successfulReads >= (opts.reviewTrigger ? 2 : 1));
    }
    const countDrainTimeout = ((...args: Parameters<typeof setTimeout>) => {
      if (args[1] === SHUTDOWN_DRAIN_TIMEOUT_MS) drains++;
      return savedSetTimeout(...args);
    }) as typeof setTimeout;
    patchShared(globalThis, "setTimeout", countDrainTimeout);
    signalResults.push(process.emit(signal));
    patchShared(globalThis, "setTimeout", savedSetTimeout);
    if (opts.lateMail) {
      expect(exits, "shutdown is still draining the task-loop read").toBe(0);
      releaseMail?.();
      releasePreparation?.();
      await sleep(30);
      expect(taskGit!.mock.calls, "late mail does not reach workspace sync").toHaveLength(0);
      expect(taskSpawn!.mock.calls, "late mail does not launch Codex").toHaveLength(0);
      expect(prepared).toBe(opts.lateMail === "poll" ? 0 : 1);
      expect(resets, "no reset after the boot reset").toBe(1);
      const records = readdirSync(inboxCur).filter((file) => file.endsWith(".json"));
      expect(records, "late mail stays unacknowledged in cur").toHaveLength(1);
      expect(JSON.parse(readFileSync(join(inboxCur, records[0]!), "utf8")).body).toBe("fixture task");
      releaseLoop?.();
    }
    if (opts.preflightError) {
      await waitFor(() => releaseFinalBeat !== undefined);
      releasePreflight?.();
      await sleep(0);
    }
    if (opts.secondSignal) {
      patchShared(globalThis, "setTimeout", countDrainTimeout);
      signalResults.push(process.emit(opts.secondSignal));
      patchShared(globalThis, "setTimeout", savedSetTimeout);
    }
    if (opts.preflightError) {
      expect(signalResults, "both signals reach a registered listener during the final beat").toEqual([true, true]);
      expect(rejected, "runtime rejection waits for the final beat").toBeUndefined();
      expect(exits).toBe(0);
      releaseFinalBeat?.();
    }
    releasePreflight?.();
    await waitFor(() => exitCode !== undefined, 5000); // signal handler ran
    await waitFor(() => presenceBodies.some((b) => b.includes("idle")), 5000);
    if (opts.preflightError) {
      await waitFor(() => rejected !== undefined);
    } else if (opts.signalDuringPreflight) {
      await waitFor(() => runtimeFinished || http.some((c) => c.startsWith("GET /OrgEventCatchup")));
    }
    expect(process.listenerCount("SIGTERM")).toBe(savedSigterm.length);
    expect(process.listenerCount("SIGINT")).toBe(savedSigint.length);
    if (opts.observeMailAfterExit) {
      const pollsAtExit = mailPolls;
      expect(pollsAtExit).toBeGreaterThan(0);
      process.env.TPS_MAIL_DIR = join(dir, "later-mail");
      await sleep(5500);
      expect(mailPolls, "mail polls stop after shutdown").toBe(pollsAtExit);
      expect(existsSync(join(dir, "later-mail"))).toBe(false);
    }
    if (afterShutdown) await afterShutdown(http);
  } finally {
    releaseMail?.();
    releasePreparation?.();
    releaseLoop?.();
    pollSpy.mockRestore();
    taskGit?.mockRestore();
    taskSpawn?.mockRestore();
    releasePreflight?.();
    releaseFinalBeat?.();
    if (releaseFinalBeat) await waitFor(() => exitCode !== undefined);
    patchShared(globalThis, "fetch", savedFetch);
    patchShared(process, "exit", savedExit);
    patchShared(globalThis, "setTimeout", savedSetTimeout);
    patchShared(FlairClient.prototype, "getEventsSince", savedRead);
    patchShared(FlairClient.prototype, "ping", savedPing);
    if (savedMailDir === undefined) delete process.env.TPS_MAIL_DIR;
    else process.env.TPS_MAIL_DIR = savedMailDir;
    for (const l of process.listeners("SIGTERM")) if (!savedSigterm.includes(l)) process.off("SIGTERM", l);
    for (const l of process.listeners("SIGINT")) if (!savedSigint.includes(l)) process.off("SIGINT", l);
  }

  return { http, presenceBodies, exitCode, exits, drains, signalResults, rejected, ticked, successfulReads };
}

async function withLoopClient(
  agentId: string,
  respond: (url: URL) => Promise<Response>,
  run: (client: FlairClient, reads: string[]) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cli781-loops-"));
  const keyPath = join(dir, "agent.key");
  writeFileSync(keyPath, keySeed().seed);
  const client = new FlairClient({ baseUrl: "http://127.0.0.1:9", agentId, keyPath });
  const read = client.getEventsSince.bind(client);
  const reads: string[] = [];
  client.getEventsSince = async (...args) => {
    const result = await read(...args);
    reads.push(result.status);
    return result;
  };
  const savedFetch = globalThis.fetch;
  patchShared(globalThis, "fetch", (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("http://127.0.0.1:9");
    expect(url.pathname).toBe(`/OrgEventCatchup/${agentId}`);
    return respond(url);
  }) as typeof fetch);
  try {
    await run(client, reads);
  } finally {
    patchShared(globalThis, "fetch", savedFetch);
    rmSync(dir, { recursive: true, force: true });
  }
}

function shutdownEvent(id: string, kind: string, agentId: string) {
  const createdAt = new Date().toISOString();
  return {
    id, kind, authorId: agentId, targetIds: [agentId], summary: "fixture",
    detail: "https://github.com/example/repo/pull/1", createdAt,
    position: `${createdAt}\t${id}`,
  };
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
    "resolves the locally resolved agent key when the config omits flair.keyPath",
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
      patchShared(console, "warn", ((msg?: unknown) => {
        warnings.push(String(msg ?? ""));
      }) as typeof console.warn);
      try {
        await publishRuntimePresence(client as never, "testbot");
        await shutdownPresenceBeat(client as never, "testbot", 100);
      } finally {
        patchShared(console, "warn", realWarn);
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
    "cleans up Presence heartbeat and signal listeners when startup rejects",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "cli444-startup-"));
      const workspace = join(dir, "workspace");
      mkdirSync(workspace);
      const keyPath = join(dir, "testbot.key");
      writeFileSync(keyPath, keySeed().seed);
      const startupError = new Error("workspace reset failed");
      const state = { ref: "fixture", timestamp: new Date().toISOString(), provider: "test" };
      const workspaceProvider: WorkspaceProvider = {
        type: "test",
        snapshot: async () => state,
        reset: async () => { throw startupError; },
        checkpoint: async () => state,
        diff: async () => ({ summary: "" }),
        baseline: async () => state,
      };
      const savedFetch = globalThis.fetch;
      const savedSetInterval = globalThis.setInterval;
      const savedMailDir = process.env.TPS_MAIL_DIR;
      const savedSigterm = process.listeners("SIGTERM");
      const savedSigint = process.listeners("SIGINT");
      const sigtermCount = process.listenerCount("SIGTERM");
      const sigintCount = process.listenerCount("SIGINT");
      const presenceBodies: string[] = [];
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

      process.env.TPS_MAIL_DIR = join(dir, "mail");
      patchShared(globalThis, "fetch", (async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, "");
        if (init?.method === "POST" && path === "/Presence") presenceBodies.push(String(init.body ?? ""));
        if (path === "/Health") return new Response("ok", { status: 200 });
        if (path.startsWith("/OrgEventCatchup")) {
          return Response.json({ events: [], nextAfter: new URL(String(input)).searchParams.get("after") ?? new URL(String(input)).searchParams.get("since"), hasMore: false });
        }
        if (init?.method === "GET" && path.startsWith("/Soul")) {
          return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("", { status: 204 });
      }) as typeof globalThis.fetch);
      patchShared(globalThis, "setInterval", ((...args: Parameters<typeof setInterval>) => {
        if (args[1] === HEARTBEAT_INTERVAL_MS) {
          args[1] = 20;
          heartbeatTimer = savedSetInterval(...args);
          return heartbeatTimer;
        }
        return savedSetInterval(...args);
      }) as typeof setInterval);

      try {
        await expect(runCodexRuntime({
          agentId: "testbot",
          workspace,
          mailDir: join(dir, "mail", "testbot"),
          flairUrl: "http://127.0.0.1:9931",
          flairKeyPath: keyPath,
          workspaceProvider,
        })).rejects.toBe(startupError);
        await waitFor(() => presenceBodies.length >= 1, 1000);
        expect(process.listenerCount("SIGTERM")).toBe(sigtermCount);
        expect(process.listenerCount("SIGINT")).toBe(sigintCount);
        const beatsAtRejection = presenceBodies.length;
        await sleep(80);
        expect(presenceBodies.length).toBe(beatsAtRejection);
      } finally {
        patchShared(globalThis, "fetch", savedFetch);
        patchShared(globalThis, "setInterval", savedSetInterval);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (savedMailDir === undefined) delete process.env.TPS_MAIL_DIR;
        else process.env.TPS_MAIL_DIR = savedMailDir;
        for (const l of process.listeners("SIGTERM")) if (!savedSigterm.includes(l)) process.off("SIGTERM", l);
        for (const l of process.listeners("SIGINT")) if (!savedSigint.includes(l)) process.off("SIGINT", l);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it.each(["poll", "preparation"] as const)("mail held in %s at SIGTERM stays unacknowledged without workspace sync or task launch", async (lateMail) => {
    const r = await driveRuntime("SIGTERM", undefined, { lateMail });
    expect(r.rejected).toBeUndefined();
    expect(r.exitCode).toBe(0);
  }, 15_000);

  it("mail polling stops after shutdown when process.exit returns", async () => {
    const r = await driveRuntime("SIGTERM", undefined, { observeMailAfterExit: true });
    expect(r.rejected).toBeUndefined();
    expect(r.exitCode).toBe(0);
  }, 15_000);

  it(
    "runCodexRuntime beats at startup, ticks the mailbox, and beats idle on SIGTERM — never writing /Agent/<id>",
    async () => {
      const r = await driveRuntime("SIGTERM");
      expect(r.rejected).toBeUndefined();
      expect(r.successfulReads).toBeGreaterThanOrEqual(1);
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
    "runCodexRuntime sends no task-loop read during the observation after SIGTERM",
    async () => {
      let catchUpsAtExit = 0;
      const r = await driveRuntime("SIGTERM", async (http) => {
        const catchUps = () => http.filter((c) => c.startsWith("GET /OrgEventCatchup")).length;
        catchUpsAtExit = catchUps();
        expect(catchUpsAtExit, "the task loop polled before shutdown").toBeGreaterThanOrEqual(1);
        // Longer than the task loop's poll interval, so a stopped loop issues
        // no further read while a running one would.
        await sleep(11_000);
        expect(catchUps(), "no catch-up request after shutdown").toBe(catchUpsAtExit);
      });
      expect(r.rejected).toBeUndefined();
      expect(r.successfulReads).toBeGreaterThanOrEqual(1);
      expect(r.exitCode, "the SIGTERM handler exited").toBe(0);
    },
    40_000,
  );

  it(
    "runCodexRuntime sends no seeded-cursor read during the observation after SIGTERM",
    async () => {
      let pollsAtExit = 0;
      const r = await driveRuntime("SIGTERM", async (http) => {
        pollsAtExit = reviewTriggerPolls(http);
        expect(pollsAtExit, "the review-trigger loop polled before shutdown").toBeGreaterThanOrEqual(1);
        // Longer than the review-trigger loop's poll interval, so a stopped loop
        // issues no further read while a running one would.
        await sleep(11_000);
        expect(reviewTriggerPolls(http), "no review-trigger poll after shutdown").toBe(pollsAtExit);
      }, { reviewTrigger: { reviewers: ["reviewer-1"], repo: "example/repo" } });
      expect(r.rejected).toBeUndefined();
      expect(r.successfulReads).toBeGreaterThanOrEqual(1);
      expect(r.exitCode, "the SIGTERM handler exited").toBe(0);
    },
    40_000,
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
  it("a signal during preflight prevents loop reads", async () => {
    const r = await driveRuntime("SIGTERM", undefined, {
      signalDuringPreflight: true,
      reviewTrigger: { reviewers: ["reviewer-1"], repo: "example/repo" },
    });
    expect(r.rejected).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(r.http.filter((c) => c.startsWith("GET /OrgEventCatchup"))).toEqual([]);
  }, 10_000);

  it("a preflight rejection retains the signal guard until the final beat settles", async () => {
    const preflightError = new Error("preflight failed");
    const r = await driveRuntime("SIGTERM", undefined, {
      signalDuringPreflight: true,
      secondSignal: "SIGTERM",
      preflightError,
    });
    expect(r.rejected).toBe(preflightError);
    expect(r.drains).toBe(1);
    expect(r.presenceBodies.filter((b) => b.includes('"idle"'))).toHaveLength(1);
    expect(r.exits).toBe(1);
    expect(r.exitCode).toBe(0);
  }, 10_000);

  for (const [first, second] of [
    ["SIGINT", "SIGINT"],
    ["SIGTERM", "SIGTERM"],
    ["SIGINT", "SIGTERM"],
  ] as const) {
    it(`${first} then ${second} drains, beats, and exits once`, async () => {
      const r = await driveRuntime(first, undefined, { secondSignal: second });
      expect(r.signalResults, "both signals reach a registered listener").toEqual([true, true]);
      expect(r.rejected).toBeUndefined();
      expect(r.drains).toBe(1);
      expect(r.presenceBodies.filter((b) => b.includes('"idle"'))).toHaveLength(1);
      expect(r.exits).toBe(1);
      expect(r.exitCode).toBe(0);
    }, 10_000);
  }

  it("bounds a pending read and handler together, stops both loops, and sends the final beat", async () => {
    const agentId = "agent-drain";
    const task = shutdownEvent("task-a", "task.assigned", agentId);
    const nextTask = { ...task, id: "task-b", position: `${task.createdAt}\ttask-b` };
    let requests = 0;
    let releaseHandler: (() => void) | undefined;
    let handled = 0;
    await withLoopClient(agentId, async () => {
      requests++;
      if (requests === 1) return Response.json({ events: [task, nextTask], nextAfter: nextTask.position, hasMore: false });
      return new Promise<Response>(() => {});
    }, async (client, reads) => {
      const taskLoop = startTaskLoop(client, agentId, async () => {
        handled++;
        if (handled === 1) await new Promise<void>((resolve) => { releaseHandler = resolve; });
      }, { pollIntervalMs: 20 });
      const reviewLoop = startReviewTriggerLoop(client, agentId, { reviewers: ["reviewer-1"], repo: "example/repo" }, { pollIntervalMs: 20 });
      const stopped: string[] = [];
      const { calls, client: presence } = fakeClient();
      let exited = false;
      const onSignal = shutdownHandler(presence as never, agentId, () => {}, () => { exited = true; }, 80, [
        () => { stopped.push("task"); return taskLoop.stop(); },
        () => { throw new Error("stop failed"); },
        () => Promise.reject(new Error("stop rejected")),
        () => { stopped.push("review"); return reviewLoop.stop(); },
      ], 200);
      try {
        await waitFor(() => requests === 2 && releaseHandler !== undefined);
        expect(reads).toEqual(["ok"]);
        const started = performance.now();
        onSignal();
        expect(stopped, "both stops called before waiting for either").toEqual(["task", "review"]);
        await waitFor(() => exited, 350);
        expect(performance.now() - started).toBeLessThan(350);
        expect(calls).toEqual(["PRESENCE idle"]);
        releaseHandler?.();
        await taskLoop.stop();
        await sleep(60);
        expect(handled, "no next handler after stop").toBe(1);
        expect(requests, "no further read after stop").toBe(2);
      } finally {
        releaseHandler?.();
        void taskLoop.stop();
        void reviewLoop.stop();
      }
    });
  }, 5000);

  it("valid pages delivered after SIGTERM dispatch no task or review request", async () => {
    const agentId = "agent-late";
    const release: Array<() => void> = [];
    let handled = 0;
    let reviewRequests = 0;
    await withLoopClient(agentId, async () => {
      const kind = release.length === 0 ? "task.assigned" : "pr.opened";
      await new Promise<void>((resolve) => { release.push(resolve); });
      const event = shutdownEvent("event-a", kind, agentId);
      return Response.json({ events: [event], nextAfter: event.position, hasMore: false });
    }, async (client, reads) => {
      const taskLoop = startTaskLoop(client, agentId, async () => { handled++; }, { pollIntervalMs: 20 });
      const reviewLoop = startReviewTriggerLoop(client, agentId, { reviewers: ["reviewer-1"], repo: "example/repo" }, {
        pollIntervalMs: 20,
        deps: { spawnSyncImpl: (() => { reviewRequests++; return { status: 0, stdout: "", stderr: "" }; }) as never },
      });
      const { calls, client: presence } = fakeClient();
      let exited = false;
      const onSignal = shutdownHandler(presence as never, agentId, () => {}, () => { exited = true; }, 80, [taskLoop.stop, reviewLoop.stop], 80);
      process.once("SIGTERM", onSignal);
      try {
        await waitFor(() => release.length === 2);
        process.emit("SIGTERM");
        for (const resolve of release) resolve();
        await waitFor(() => exited);
        expect(reads).toEqual(["ok", "ok"]);
        expect({ tasks: handled, reviewRequests }, "late pages must not dispatch").toEqual({ tasks: 0, reviewRequests: 0 });
        expect(calls).toEqual(["PRESENCE idle"]);
      } finally {
        for (const resolve of release) resolve();
        await Promise.all([taskLoop.stop(), reviewLoop.stop()]);
        process.off("SIGTERM", onSignal);
      }
    });
  }, 5000);

});
