/**
 * ops-31.1 — tps soul CLI tests
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// Mock FlairClient for soul tests

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

const SOUL_ENTRIES = [
  { id: "flint-role", agentId: "flint", key: "role", value: "Chief Strategy Officer" },
  { id: "flint-tone", agentId: "flint", key: "tone", value: "Methodical, strategic" },
];

function makeMockFetch(responses: Record<string, any>) {
  return async (url: string | URL, opts?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();
    for (const [pattern, body] of Object.entries(responses)) {
      if (urlStr.includes(pattern)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

describe("ops-31.1: tps soul show", () => {
  test("shows soul entries as key: value lines", async () => {
    globalThis.fetch = makeMockFetch({ "/Soul/": SOUL_ENTRIES }) as any;

    const { runSoul } = await import("../src/commands/soul.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => lines.push(args.join(" "));

    await runSoul({ action: "show", agentId: "flint", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    expect(lines.some((l) => l.includes("role:"))).toBe(true);
    expect(lines.some((l) => l.includes("Chief Strategy Officer"))).toBe(true);
  });

  test("shows empty message when no soul entries", async () => {
    globalThis.fetch = makeMockFetch({ "/Soul/": [] }) as any;

    const { runSoul } = await import("../src/commands/soul.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => lines.push(args.join(" "));

    await runSoul({ action: "show", agentId: "empty-agent", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;

    expect(lines.some((l) => l.includes("No soul entries"))).toBe(true);
  });

  test("--json outputs valid JSON array", async () => {
    globalThis.fetch = makeMockFetch({ "/Soul/": SOUL_ENTRIES }) as any;

    const { runSoul } = await import("../src/commands/soul.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => lines.push(args.join(" "));

    await runSoul({ action: "show", agentId: "flint", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH, json: true });
    console.log = origLog;

    const parsed = JSON.parse(lines[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].key).toBe("role");
  });
});

describe("ops-31.1: tps soul set", () => {
  test("sets soul from a file", async () => {
    const puts: any[] = [];
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      if (opts?.method === "PUT" && url.includes("/Soul/")) {
        puts.push(JSON.parse(opts.body as string));
      }
      return new Response("{}", { status: 200 });
    }) as any;

    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmpFile = "/tmp/soul-test-ops311.txt";
    writeFileSync(tmpFile, "role: Strategist\ntone: Bold\n", "utf-8");

    const { runSoul } = await import("../src/commands/soul.js");
    await runSoul({ action: "set", agentId: "flint", file: tmpFile, flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });

    unlinkSync(tmpFile);

    expect(puts.length).toBe(2);
    expect(puts.find((p) => p.key === "role")?.value).toBe("Strategist");
    expect(puts.find((p) => p.key === "tone")?.value).toBe("Bold");
  });

  test("exits with error for missing file", async () => {
    const { runSoul } = await import("../src/commands/soul.js");
    const origExit = process.exit;
    let exitCode: number | undefined;
    (process as any).exit = (code: number) => { exitCode = code; throw new Error("exit"); };

    try {
      await runSoul({ action: "set", agentId: "flint", file: "/nonexistent/soul.txt", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    } catch {}

    (process as any).exit = origExit;
    expect(exitCode).toBe(1);
  });
});

describe("ops-31.1: tps soul diff", () => {
  test("reports no differences when identical", async () => {
    globalThis.fetch = makeMockFetch({ "/Soul/": SOUL_ENTRIES }) as any;

    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmpFile = "/tmp/soul-diff-test.txt";
    writeFileSync(tmpFile, "role: Chief Strategy Officer\ntone: Methodical, strategic\n", "utf-8");

    const { runSoul } = await import("../src/commands/soul.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => lines.push(args.join(" "));

    await runSoul({ action: "diff", agentId: "flint", file: tmpFile, flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    console.log = origLog;
    unlinkSync(tmpFile);

    expect(lines.some((l) => l.includes("No differences"))).toBe(true);
  });
});
