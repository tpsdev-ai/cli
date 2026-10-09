import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
/**
 * cli#509 — tps memory governance:
 *   - archive / unarchive fail closed on a failed or incomplete read, then
 *     PATCH only the governance fields;
 *   - search signs as the operator (TPS_AGENT_ID) and carries the target agent
 *     as the search's agentId parameter;
 *   - approve / reject are unsupported (Flair has no by-id memory promotion).
 *
 * Flair's own contract is read from its resources (Memory.patch merges;
 * POST /PromoteMemoryCandidate acts on a candidate id).
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_KEY_PATH = join(tmpdir(), `tps-509-key-${process.pid}-${Math.random().toString(36).slice(2)}.pem`);
const FLAIR_URL = "http://127.0.0.1:19926";
const COMPLETE = { id: "agent-a-mem-1", agentId: "agent-a", content: "keep this", durability: "standard" };

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  writeFileSync(TEST_KEY_PATH, privateKey, { mode: 0o600 });
});
afterAll(() => {
  if (existsSync(TEST_KEY_PATH)) unlinkSync(TEST_KEY_PATH);
});

let _savedFetch: typeof globalThis.fetch;
const _savedAgentId = process.env.TPS_AGENT_ID;
beforeEach(() => { _savedFetch = globalThis.fetch; process.env.TPS_AGENT_ID = "operator"; });
afterEach(() => {
  patchShared(globalThis, "fetch", _savedFetch);
  if (_savedAgentId === undefined) delete process.env.TPS_AGENT_ID;
  else process.env.TPS_AGENT_ID = _savedAgentId;
});

interface Call { method?: string; url: string; body?: any; auth?: string }

/** Route the read through `read`; capture every write. */
function routeFetch(calls: Call[], read: () => Response) {
  patchShared(globalThis, "fetch", (async (url: string, opts?: RequestInit) => {
    if (opts?.method === "GET") return read();
    calls.push({ method: opts?.method, url, body: opts?.body ? JSON.parse(opts.body as string) : undefined, auth: (opts?.headers as any)?.Authorization });
    return new Response("{}", { status: 200 });
  }) as any);
}

describe("cli#509: archive / unarchive fail closed", () => {
  for (const status of [503, 404]) {
    test(`archive: a ${status} read sends no write and refuses`, async () => {
      const calls: Call[] = [];
      routeFetch(calls, () => new Response("nope", { status }));
      const { runMemory } = await import("../src/commands/memory.js");

      await expect(runMemory({ action: "archive", memoryId: "agent-a-mem-1", flairUrl: FLAIR_URL, keyPath: TEST_KEY_PATH }))
        .rejects.toThrow(/refusing to update memory agent-a-mem-1/);
      expect(calls).toEqual([]);
    });
  }

  test("archive: an empty read sends no write and refuses", async () => {
    const calls: Call[] = [];
    routeFetch(calls, () => new Response("{}", { status: 200 }));
    const { runMemory } = await import("../src/commands/memory.js");

    await expect(runMemory({ action: "archive", memoryId: "agent-a-mem-1", flairUrl: FLAIR_URL, keyPath: TEST_KEY_PATH }))
      .rejects.toThrow(/incomplete record/);
    expect(calls).toEqual([]);
  });

  test("archive: the happy path PATCHes only the governance fields", async () => {
    const calls: Call[] = [];
    routeFetch(calls, () => new Response(JSON.stringify(COMPLETE), { status: 200 }));
    const { runMemory } = await import("../src/commands/memory.js");

    await runMemory({ action: "archive", memoryId: "agent-a-mem-1", flairUrl: FLAIR_URL, keyPath: TEST_KEY_PATH });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe(`${FLAIR_URL}/Memory/agent-a-mem-1`);
    expect(Object.keys(calls[0].body).sort()).toEqual(["archived", "archivedAt", "archivedBy"]);
    expect(calls[0].body).toMatchObject({ archived: true, archivedBy: "operator" });
  });

  test("unarchive: the happy path PATCHes only the governance fields", async () => {
    const calls: Call[] = [];
    routeFetch(calls, () => new Response(JSON.stringify(COMPLETE), { status: 200 }));
    const { runMemory } = await import("../src/commands/memory.js");

    await runMemory({ action: "unarchive", memoryId: "agent-a-mem-1", flairUrl: FLAIR_URL, keyPath: TEST_KEY_PATH });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(Object.keys(calls[0].body).sort()).toEqual(["archived", "archivedAt", "archivedBy"]);
    expect(calls[0].body).toMatchObject({ archived: false, archivedBy: null, archivedAt: null });
  });
});

describe("cli#509: search signs as the operator", () => {
  test("signs as TPS_AGENT_ID and carries the target as the agentId parameter", async () => {
    let seen: Call | undefined;
    patchShared(globalThis, "fetch", (async (url: string, opts?: RequestInit) => {
      seen = { method: opts?.method, url, body: JSON.parse(opts?.body as string), auth: (opts?.headers as any)?.Authorization };
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as any);
    const { runMemory } = await import("../src/commands/memory.js");

    await runMemory({ action: "search", agentId: "target-a", query: "hello", flairUrl: FLAIR_URL, keyPath: TEST_KEY_PATH });

    expect(seen?.url).toBe(`${FLAIR_URL}/SemanticSearch`);
    expect(seen?.body.agentId).toBe("target-a");
    expect(seen?.auth).toStartWith("TPS-Ed25519 operator:");
  });

  test("refuses when TPS_AGENT_ID is unset", async () => {
    delete process.env.TPS_AGENT_ID;
    const calls: Call[] = [];
    routeFetch(calls, () => new Response("{}", { status: 200 }));
    const { runMemory } = await import("../src/commands/memory.js");

    await expect(runMemory({ action: "search", agentId: "target-a", query: "hello", flairUrl: FLAIR_URL, keyPath: TEST_KEY_PATH }))
      .rejects.toThrow(/no memory operator id/);
    expect(calls).toEqual([]);
  });
});

describe("cli#509: approve / reject are unsupported", () => {
  for (const action of ["approve", "reject"] as const) {
    test(`${action} refuses by name and sends no write`, async () => {
      const calls: Call[] = [];
      routeFetch(calls, () => new Response(JSON.stringify(COMPLETE), { status: 200 }));
      const { runMemory } = await import("../src/commands/memory.js");

      await expect(runMemory({ action, memoryId: "agent-a-mem-1", flairUrl: FLAIR_URL, keyPath: TEST_KEY_PATH }))
        .rejects.toThrow(/no operation that sets a memory's promotion status by id/);
      expect(calls).toEqual([]);
    });
  }
});
