/**
 * ops-31.1 — tps memory CLI tests
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";


import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll } from "bun:test";

const TEST_KEY_PATH = join(tmpdir(), `tps-test-key-${process.pid}-${Math.random().toString(36).slice(2)}.pem`);

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(TEST_KEY_PATH, privateKey, { mode: 0o600 });
});

afterAll(() => {
  if (existsSync(TEST_KEY_PATH)) unlinkSync(TEST_KEY_PATH);
});
let _savedFetch: typeof globalThis.fetch;
beforeEach(() => { _savedFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = _savedFetch; });

const PENDING_MEMORIES = [
  { id: "flint-lesson-042", agentId: "flint", content: "Never run bare gh commands", promotionStatus: "pending", durability: "standard", createdAt: "2026-03-01T10:00:00Z", archived: false },
  { id: "flint-pattern-018", agentId: "flint", content: "Anvil needs small explicit specs", promotionStatus: "pending", durability: "standard", createdAt: "2026-02-28T09:00:00Z", archived: false },
];

function mockFetch(handler: (url: string, opts?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = handler as any;
}

describe("ops-31.1: tps memory review", () => {
  test("lists pending memories", async () => {
    mockFetch(async (url) => {
      if (url.includes("/Memory/")) return new Response(JSON.stringify(PENDING_MEMORIES), { status: 200 });
      return new Response("[]", { status: 200 });
    });

    const { runMemory } = await import("../src/commands/memory.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => lines.push(a.join(" "));

    await runMemory({ action: "review", agentId: "flint", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    expect(lines.some((l) => l.includes("flint-lesson-042"))).toBe(true);
    expect(lines.some((l) => l.includes("flint-pattern-018"))).toBe(true);
  });

  test("shows empty message when nothing pending", async () => {
    mockFetch(async () => new Response(JSON.stringify([{ id: "m1", content: "x", promotionStatus: "approved", archived: false }]), { status: 200 }));

    const { runMemory } = await import("../src/commands/memory.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => lines.push(a.join(" "));

    await runMemory({ action: "review", agentId: "flint", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    expect(lines.some((l) => l.includes("No memories pending"))).toBe(true);
  });
});

describe("ops-31.1: tps memory approve", () => {
  test("sends PUT with promotionStatus=approved", async () => {
    let captured: any;
    mockFetch(async (url, opts) => {
      if (opts?.method === "PUT") captured = JSON.parse(opts.body as string);
      return new Response("{}", { status: 200 });
    });

    const { runMemory } = await import("../src/commands/memory.js");
    await runMemory({ action: "approve", memoryId: "flint-lesson-042", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });

    expect(captured.promotionStatus).toBe("approved");
    expect(captured.id).toBe("flint-lesson-042");
  });
});

describe("ops-31.1: tps memory reject", () => {
  test("sends PUT with promotionStatus=rejected", async () => {
    let captured: any;
    mockFetch(async (url, opts) => {
      if (opts?.method === "PUT") captured = JSON.parse(opts.body as string);
      return new Response("{}", { status: 200 });
    });

    const { runMemory } = await import("../src/commands/memory.js");
    await runMemory({ action: "reject", memoryId: "flint-pattern-018", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });

    expect(captured.promotionStatus).toBe("rejected");
  });
});

describe("ops-31.1: tps memory archive / unarchive", () => {
  test("archive sends archived=true", async () => {
    let captured: any;
    mockFetch(async (url, opts) => {
      if (opts?.method === "PUT") captured = JSON.parse(opts.body as string);
      return new Response("{}", { status: 200 });
    });

    const { runMemory } = await import("../src/commands/memory.js");
    await runMemory({ action: "archive", memoryId: "flint-lesson-042", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });

    expect(captured.archived).toBe(true);
  });

  test("unarchive sends archived=false", async () => {
    let captured: any;
    mockFetch(async (url, opts) => {
      if (opts?.method === "PUT") captured = JSON.parse(opts.body as string);
      return new Response("{}", { status: 200 });
    });

    const { runMemory } = await import("../src/commands/memory.js");
    await runMemory({ action: "unarchive", memoryId: "flint-lesson-042", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });

    expect(captured.archived).toBe(false);
  });
});

describe("ops-31.1: tps memory purge", () => {
  test("sends DELETE request", async () => {
    let method: string | undefined;
    mockFetch(async (url, opts) => {
      method = opts?.method;
      return new Response("{}", { status: 204 });
    });

    const { runMemory } = await import("../src/commands/memory.js");
    await runMemory({ action: "purge", memoryId: "flint-lesson-042", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });

    expect(method).toBe("DELETE");
  });
});

describe("ops-31.1: tps memory list", () => {
  test("filters out archived by default", async () => {
    const all = [
      { id: "m1", content: "visible", archived: false, durability: "standard", createdAt: "2026-01-01" },
      { id: "m2", content: "hidden", archived: true, durability: "standard", createdAt: "2026-01-01" },
    ];
    mockFetch(async () => new Response(JSON.stringify(all), { status: 200 }));

    const { runMemory } = await import("../src/commands/memory.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => lines.push(a.join(" "));

    await runMemory({ action: "list", agentId: "flint", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    const output = lines.join("\n");
    expect(output).toContain("m1");
    expect(output).not.toContain("m2");
  });

  test("--include-archived shows all", async () => {
    const all = [
      { id: "m1", content: "visible", archived: false, durability: "standard", createdAt: "2026-01-01" },
      { id: "m2", content: "hidden", archived: true, durability: "standard", createdAt: "2026-01-01" },
    ];
    mockFetch(async () => new Response(JSON.stringify(all), { status: 200 }));

    const { runMemory } = await import("../src/commands/memory.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => lines.push(a.join(" "));

    await runMemory({ action: "list", agentId: "flint", includeArchived: true, flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    const output = lines.join("\n");
    expect(output).toContain("m1");
    expect(output).toContain("m2");
  });
});

describe("ops-31.1: tps memory show", () => {
  test("displays full memory record", async () => {
    const mem = { id: "flint-lesson-042", agentId: "flint", content: "Never run bare gh commands", durability: "permanent", promotionStatus: "approved", archived: false, createdAt: "2026-03-01T10:00:00Z", promotedBy: "flint", promotedAt: "2026-03-02T00:00:00Z" };
    mockFetch(async () => new Response(JSON.stringify(mem), { status: 200 }));

    const { runMemory } = await import("../src/commands/memory.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => lines.push(a.join(" "));

    await runMemory({ action: "show", memoryId: "flint-lesson-042", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    const output = lines.join("\n");
    expect(output).toContain("flint-lesson-042");
    expect(output).toContain("permanent");
    expect(output).toContain("Never run bare gh commands");
  });
});

describe("ops-31.1: tps memory search", () => {
  test("calls MemorySearch and prints results", async () => {
    mockFetch(async (url, opts) => {
      if (url.includes("/MemoryQuery")) {
        return new Response(JSON.stringify({ results: [{ id: "m1", content: "gh commands lesson", _score: 0.91 }] }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });

    const { runMemory } = await import("../src/commands/memory.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => lines.push(a.join(" "));

    await runMemory({ action: "search", agentId: "flint", query: "gh commands", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    expect(lines.some((l) => l.includes("0.910"))).toBe(true);
    expect(lines.some((l) => l.includes("gh commands lesson"))).toBe(true);
  });
});
