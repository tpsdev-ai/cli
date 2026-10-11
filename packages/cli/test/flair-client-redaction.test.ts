/**
 * cli#597 — redact credential material from the CLI's Flair client errors.
 *
 * A local server echoes the request's credential back — as body text, in a
 * response header, and in a JSON field — for an error status, and a mocked
 * transport failure rejects with request details in its message and cause. The entry
 * points that surface errors (`request`, `registerAgent`,
 * `readStoredPublicKey`) are driven through both, and the test asserts the
 * credential is absent from the thrown error's message and cause chain and from
 * the console output it captures.
 *
 * Names are neutral (`agent-a`, `operator-a`); each server is stopped in a
 * finally.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatchShared } from "./helpers/patch-shared.js";
import { writeKeyFile } from "./helpers/stub-flair.js";
import { FlairClient } from "../src/utils/flair-client.js";

const patchShared = createPatchShared();

const SEED = Buffer.alloc(32, 0x7a);
const OPERATOR = "operator-a:op-pass-4f9c";
const OPERATOR_B64 = Buffer.from(OPERATOR).toString("base64");

// ─── Output capture ─────────────────────────────────────────────────────────

let logs: string[];
let restores: Array<() => void>;
let home: string;

beforeEach(() => {
  logs = [];
  restores = [];
  home = mkdtempSync(join(tmpdir(), "flair-redaction-"));
  const toLog = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  const write = (chunk: string) => {
    logs.push(String(chunk));
    return true;
  };
  restores.push(patchShared(console, "log", toLog as typeof console.log));
  restores.push(patchShared(console, "error", toLog as typeof console.error));
  restores.push(patchShared(console, "warn", toLog as typeof console.warn));
  restores.push(patchShared(console, "info", toLog as typeof console.info));
  restores.push(patchShared(process.stdout, "write", write as typeof process.stdout.write));
  restores.push(patchShared(process.stderr, "write", write as typeof process.stderr.write));
});

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  rmSync(home, { recursive: true, force: true });
});

// ─── Echoing server and mocked transport failure ────────────────────────────

/** Echoes the caller's credential into a body, a response header, and (for a Basic credential) its decoded value. */
function startEchoFlair(shape: "text" | "json") {
  let lastAuth = "";
  const echoed = (auth: string) => {
    if (!auth.startsWith("Basic ")) return auth;
    return `${auth} / ${Buffer.from(auth.slice(6), "base64").toString("utf-8")}`;
  };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const auth = req.headers.get("Authorization") ?? "";
      lastAuth = auth;
      const headers = { "X-Echo-Authorization": auth };
      const value = echoed(auth);
      if (shape === "json") {
        return Response.json({ error: "refused", authorization: value }, { status: 500, headers });
      }
      return new Response(`refused: Authorization=${value}`, { status: 500, headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    lastAuth: () => lastAuth,
    stop: () => server.stop(true),
  };
}

/** Replace fetch with one that fails, carrying the request's credential in the message and the cause. */
function installThrowingFetch(): { restore: () => void; seen: () => string } {
  let seen = "";
  const restore = patchShared(
    globalThis,
    "fetch",
    (async (_input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen = headers.Authorization ?? "";
      const err = new Error(`transport failed: Authorization=${seen}`);
      err.cause = new Error(`cause carries Authorization=${seen}`);
      throw err;
    }) as typeof globalThis.fetch,
  );
  return { restore, seen: () => seen };
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("the client was expected to throw");
}

/** The messages of an error and its `cause` chain (up to eight links). */
function errorChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; current != null && i < 8; i++) {
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join("\n");
}

function expectNoLeak(err: unknown, secrets: string[]): void {
  const output = logs.join("\n");
  const chain = errorChain(err);
  for (const secret of secrets) {
    expect(output, `console/stderr output carried ${secret}`).not.toContain(secret);
    expect(chain, `thrown error chain carried ${secret}`).not.toContain(secret);
  }
}

// ─── Entry points that surface errors ───────────────────────────────────────

interface EntryPoint {
  name: string;
  client: (url: string) => FlairClient;
  run: (client: FlairClient) => Promise<unknown>;
  /** The credential values a request by this entry point carries. */
  secrets: (auth: string) => string[];
}

const clientFor = (url: string) =>
  new FlairClient({ baseUrl: url, agentId: "agent-a", keyPath: writeKeyFile(home, "agent-a", SEED) });

const ENTRY_POINTS: EntryPoint[] = [
  {
    name: "request (signed)",
    client: clientFor,
    run: (client) => client.getMemory("mem-1"),
    secrets: (auth) => [auth],
  },
  {
    name: "registerAgent (operator)",
    client: clientFor,
    run: (client) => client.registerAgent("agent-a", "public-key", OPERATOR),
    secrets: (auth) => [auth, OPERATOR_B64, OPERATOR],
  },
  {
    name: "readStoredPublicKey (operator)",
    client: clientFor,
    run: (client) => client.readStoredPublicKey("agent-a", OPERATOR),
    secrets: (auth) => [auth, OPERATOR_B64, OPERATOR],
  },
];

describe("cli#597: the Flair client redacts the request's credential from error output", () => {
  for (const entry of ENTRY_POINTS) {
    test(`${entry.name}: redacts a credential echoed in an error body`, async () => {
      const echo = startEchoFlair("text");
      try {
        const err = await caught(() => entry.run(entry.client(echo.url)));
        const message = (err as Error).message;
        expect(message).toContain("refused");
        expectNoLeak(err, entry.secrets(echo.lastAuth()));
        expect(message).toContain("[REDACTED]");
      } finally {
        echo.stop();
      }
    });

    test(`${entry.name}: redacts a credential echoed in a JSON body`, async () => {
      const echo = startEchoFlair("json");
      try {
        const err = await caught(() => entry.run(entry.client(echo.url)));
        expect((err as Error).message).toContain("refused");
        expectNoLeak(err, entry.secrets(echo.lastAuth()));
      } finally {
        echo.stop();
      }
    });

    test(`${entry.name}: redacts a credential from a transport failure`, async () => {
      const thrown = installThrowingFetch();
      try {
        const err = await caught(() => entry.run(entry.client("http://flair.test")));
        expect((err as Error).message).toContain("transport");
        expectNoLeak(err, entry.secrets(thrown.seen()));
      } finally {
        thrown.restore();
      }
    });
  }
});
