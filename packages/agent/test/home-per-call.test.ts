/**
 * home-per-call.test.ts — cli#439, agent package.
 *
 * `llm/provider.ts` built its auth-directory path once, when the module loaded.
 * This case imports the module and then uses it under a *different* HOME: the
 * credential it acts on must follow the HOME in effect at the call.
 *
 * Both homes are temp dirs; nothing here reads or writes a real home.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let homeA: string;
let homeB: string;
let startHome: string | undefined;

beforeAll(() => {
  startHome = process.env.HOME;
  homeA = mkdtempSync(join(tmpdir(), "tps-agent-home-a-"));
  homeB = mkdtempSync(join(tmpdir(), "tps-agent-home-b-"));
});

afterAll(() => {
  process.env.HOME = startHome;
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });
});

describe("cli#439: home-relative paths follow the HOME in effect at each call (agent)", () => {
  test("llm/provider.ts: the OAuth credential is read from the current HOME", async () => {
    process.env.HOME = homeA;
    const mod: any = await import("../src/llm/provider.js?home-per-call");
    process.env.HOME = homeB;

    const dir = join(homeB, ".tps", "auth");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "anthropic.json"),
      JSON.stringify({
        provider: "anthropic",
        refreshToken: "r",
        accessToken: "token-from-b",
        expiresAt: Date.now() + 3_600_000,
        clientId: "id",
        scopes: "s",
      }),
    );

    let sentKey: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      sentKey = (init?.headers as Record<string, string>)?.["x-api-key"];
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 2 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    try {
      const manager = new mod.ProviderManager({ provider: "anthropic", model: "claude-x", auth: "oauth" });
      const out = await manager.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });
      expect(out.content).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Not "configured": the credential B holds is the one that reached the API.
    expect(sentKey).toBe("token-from-b");
  }, 20_000);
});
