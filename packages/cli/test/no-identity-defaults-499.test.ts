// cli#499 — branch and memory resolve the operator identity from configuration
// and refuse by name when none is set. The branch hostname fragment and the
// memory "admin" literal fallbacks are gone.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeHandlerAction } from "../src/commands/branch.js";
import { runMemory } from "../src/commands/memory.js";

const savedAgentId = process.env.TPS_AGENT_ID;
const savedFetch = globalThis.fetch;

const TEST_KEY_PATH = join(tmpdir(), `tps-499-key-${process.pid}-${Math.random().toString(36).slice(2)}.pem`);
beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(TEST_KEY_PATH, privateKey, { mode: 0o600 });
});
afterAll(() => {
  if (existsSync(TEST_KEY_PATH)) unlinkSync(TEST_KEY_PATH);
});

beforeEach(() => {
  delete process.env.TPS_AGENT_ID;
  globalThis.fetch = savedFetch;
});
afterEach(() => {
  if (savedAgentId === undefined) delete process.env.TPS_AGENT_ID;
  else process.env.TPS_AGENT_ID = savedAgentId;
  globalThis.fetch = savedFetch;
});

describe("cli#499 — branch identity", () => {
  test("mail routing refuses when no identity is configured", () => {
    expect(() =>
      routeHandlerAction(
        { type: "drop" },
        { id: "m", from: "kern", to: "logical-alias", body: "x" },
        () => {},
      ),
    ).toThrow(/no branch agent id/);
  });

  test("mail routing works with a configured identity", () => {
    process.env.TPS_AGENT_ID = "local-agent";
    expect(
      routeHandlerAction(
        { type: "drop" },
        { id: "m", from: "kern", to: "logical-alias", body: "x" },
        () => {},
      ),
    ).toEqual({ kind: "drop" });
  });
});

describe("cli#499 — memory operator identity", () => {
  test("refuses by name when no operator identity is configured", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(
      runMemory({ action: "archive", memoryId: "m1", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH }),
    ).rejects.toThrow(/no memory operator id/);
  });

  test("resolves the operator from TPS_AGENT_ID", async () => {
    process.env.TPS_AGENT_ID = "kern";
    globalThis.fetch = (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      await runMemory({ action: "review", agentId: "flint", flairUrl: "http://127.0.0.1:19926", keyPath: TEST_KEY_PATH });
    } finally {
      console.log = orig;
    }
    expect(lines.some((l) => l.includes("No memories pending review for flint."))).toBe(true);
  });
});
