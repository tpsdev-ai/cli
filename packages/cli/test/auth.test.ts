import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("tps auth", () => {
  let root: string;
  let logs: string[];
  let oldHome: string | undefined;
  let oldLog: (...args: any[]) => void;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-auth-test-"));
    oldHome = process.env.HOME;
    process.env.HOME = root;

    logs = [];
    oldLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));
  });

  afterEach(() => {
    console.log = oldLog;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  });

  test("status shows 'not configured' when no auth files exist", async () => {
    const mod = await import(`../src/commands/auth.js?x=${Date.now()}`);
    mod.showStatus();
    expect(logs.join("\n")).toContain("anthropic");
    expect(logs.join("\n")).toContain("not configured");
  });

  test("status shows expiry for configured provider", async () => {
    const dir = join(root, ".tps", "auth");
    mkdirSync(dir, { recursive: true });
    const creds = {
      provider: "anthropic",
      refreshToken: "r1",
      accessToken: "a1",
      expiresAt: Date.now() + 60 * 60 * 1000,
      clientId: "id",
      scopes: "scope",
    };
    writeFileSync(join(dir, "anthropic.json"), JSON.stringify(creds));

    const mod = await import(`../src/commands/auth.js?x=${Date.now()}`);
    mod.showStatus();
    const out = logs.join("\n");
    expect(out).toContain("anthropic");
    expect(out).toContain("expires in");
  });

  test("revoke deletes credential file", async () => {
    const dir = join(root, ".tps", "auth");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "anthropic.json"), JSON.stringify({ provider: "anthropic" }));

    const mod = await import(`../src/commands/auth.js?x=${Date.now()}`);
    await mod.runAuth({ action: "revoke", provider: "anthropic" });
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "anthropic.json"))).toBe(false);
  });

  test("refresh updates access token", async () => {
    const mod = await import(`../src/commands/auth.js?x=${Date.now()}`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 }), { status: 200 })) as any;

    const refreshed = await mod.refreshAnthropicToken({
      provider: "anthropic",
      refreshToken: "r1",
      accessToken: "old",
      expiresAt: Date.now() - 1000,
      clientId: "id",
      scopes: "scope",
    });

    expect(refreshed.accessToken).toBe("new-token");
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
    globalThis.fetch = originalFetch;
  });

  test("status never shows token values", async () => {
    const dir = join(root, ".tps", "auth");
    mkdirSync(dir, { recursive: true });
    const token = "sk-ant-oat01-secret-token";
    writeFileSync(
      join(dir, "anthropic.json"),
      JSON.stringify({
        provider: "anthropic",
        refreshToken: "refresh-secret",
        accessToken: token,
        expiresAt: Date.now() + 3600_000,
        clientId: "id",
        scopes: "scope",
      })
    );

    const mod = await import(`../src/commands/auth.js?x=${Date.now()}`);
    mod.showStatus();
    const out = logs.join("\n");
    expect(out).not.toContain(token);
    expect(out).not.toContain("refresh-secret");
  });

  test("refresh google updates access token", async () => {
    const mod = await import(`../src/commands/auth.js?x=${Date.now()}`);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "g-new", expires_in: 3600 }), { status: 200 })) as any;

    const refreshed = await mod.refreshGoogleToken({
      provider: "google",
      refreshToken: "gr1",
      accessToken: "gold",
      expiresAt: Date.now() - 1000,
      clientId: "gid",
      scopes: "scope",
    });

    expect(refreshed.accessToken).toBe("g-new");
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
    globalThis.fetch = originalFetch;
  });

});
