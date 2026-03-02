/**
 * ops-31.2 — tps memory reflect + consolidate CLI tests
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let _savedFetch: typeof globalThis.fetch;
const TEST_KEY_PATH = join(tmpdir(), `tps-test-learn-${process.pid}.pem`);

beforeAll(() => {
  _savedFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(TEST_KEY_PATH, privateKey, { mode: 0o600 });
});

afterAll(() => {
  globalThis.fetch = _savedFetch;
  if (existsSync(TEST_KEY_PATH)) unlinkSync(TEST_KEY_PATH);
});

const REFLECT_RESPONSE = {
  memories: [
    { id: "m1", agentId: "flint", content: "Never use bare gh commands", createdAt: "2026-03-01T10:00:00Z", durability: "standard", tags: ["git", "ci"] },
    { id: "m2", agentId: "flint", content: "PR conflicts happen when reviewers push to author branches", createdAt: "2026-03-01T12:00:00Z", durability: "standard", tags: ["git"] },
  ],
  prompt: "# Memory Reflection — flint\nFocus: lessons_learned\n...",
  suggestedTags: ["git", "ci"],
  count: 2,
};

const CONSOLIDATE_RESPONSE = {
  candidates: [
    { memory: { id: "m3", agentId: "flint", content: "Ed25519 everywhere", durability: "persistent", createdAt: "2026-01-01T00:00:00Z", retrievalCount: 8 }, suggestion: "promote", reason: "Retrieved 8 times — strong promotion candidate" },
    { memory: { id: "m4", agentId: "flint", content: "Old transport decision", durability: "persistent", createdAt: "2025-12-01T00:00:00Z", retrievalCount: 0 }, suggestion: "archive", reason: "Never retrieved, 90 days old" },
  ],
  prompt: "# Memory Consolidation Review — flint\n...",
};

describe("ops-31.2: tps memory reflect", () => {
  test("calls MemoryReflect and prints prompt + memories", async () => {
    let capturedBody: any;
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      if (String(url).includes("/MemoryReflect")) {
        capturedBody = JSON.parse(opts?.body as string);
        return new Response(JSON.stringify(REFLECT_RESPONSE), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as any;

    const { runMemoryLearn } = await import("../src/commands/memory-learn.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => lines.push(a.join(" "));

    await runMemoryLearn({ action: "reflect", agentId: "flint", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    expect(capturedBody.agentId).toBe("flint");
    expect(capturedBody.focus).toBe("lessons_learned");
    const output = lines.join("\n");
    expect(output).toContain("Memory Reflection");
    expect(output).toContain("m1");
    expect(output).toContain("m2");
  });

  test("--focus flag is forwarded", async () => {
    let capturedBody: any;
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      if (String(url).includes("/MemoryReflect")) {
        capturedBody = JSON.parse(opts?.body as string);
        return new Response(JSON.stringify({ ...REFLECT_RESPONSE, count: 0, memories: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as any;

    const { runMemoryLearn } = await import("../src/commands/memory-learn.js");
    await runMemoryLearn({ action: "reflect", agentId: "flint", focus: "patterns", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });

    expect(capturedBody.focus).toBe("patterns");
  });

  test("--json outputs valid JSON", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/MemoryReflect")) return new Response(JSON.stringify(REFLECT_RESPONSE), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as any;

    const { runMemoryLearn } = await import("../src/commands/memory-learn.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => lines.push(a.join(" "));

    await runMemoryLearn({ action: "reflect", agentId: "flint", json: true, flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    const parsed = JSON.parse(lines[0]);
    expect(parsed.count).toBe(2);
    expect(Array.isArray(parsed.memories)).toBe(true);
  });
});

describe("ops-31.2: tps memory consolidate", () => {
  test("calls MemoryConsolidate and prints candidates", async () => {
    let capturedBody: any;
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      if (String(url).includes("/MemoryConsolidate")) {
        capturedBody = JSON.parse(opts?.body as string);
        return new Response(JSON.stringify(CONSOLIDATE_RESPONSE), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as any;

    const { runMemoryLearn } = await import("../src/commands/memory-learn.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => lines.push(a.join(" "));

    await runMemoryLearn({ action: "consolidate", agentId: "flint", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    expect(capturedBody.agentId).toBe("flint");
    expect(capturedBody.scope).toBe("persistent");
    const output = lines.join("\n");
    expect(output).toContain("PROMOTE");
    expect(output).toContain("ARCHIVE");
    expect(output).toContain("m3");
    expect(output).toContain("m4");
  });

  test("--older-than forwarded to API", async () => {
    let capturedBody: any;
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      if (String(url).includes("/MemoryConsolidate")) {
        capturedBody = JSON.parse(opts?.body as string);
        return new Response(JSON.stringify({ candidates: [], prompt: "" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as any;

    const { runMemoryLearn } = await import("../src/commands/memory-learn.js");
    await runMemoryLearn({ action: "consolidate", agentId: "flint", olderThan: "7d", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });

    expect(capturedBody.olderThan).toBe("7d");
  });

  test("--json outputs valid JSON", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/MemoryConsolidate")) return new Response(JSON.stringify(CONSOLIDATE_RESPONSE), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as any;

    const { runMemoryLearn } = await import("../src/commands/memory-learn.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => lines.push(a.join(" "));

    await runMemoryLearn({ action: "consolidate", agentId: "flint", json: true, flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    const parsed = JSON.parse(lines[0]);
    expect(Array.isArray(parsed.candidates)).toBe(true);
    expect(parsed.candidates[0].suggestion).toBe("promote");
  });
});
