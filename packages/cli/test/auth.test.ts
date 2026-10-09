import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    patchShared(console, "log", (...args: any[]) => logs.push(args.join(" ")));
  });

  afterEach(() => {
    patchShared(console, "log", oldLog);
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
    patchShared(globalThis, "fetch", (async () => new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 }), { status: 200 })) as any);

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
    patchShared(globalThis, "fetch", originalFetch);
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
    patchShared(globalThis, "fetch", (async () => new Response(JSON.stringify({ access_token: "g-new", expires_in: 3600 }), { status: 200 })) as any);

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
    patchShared(globalThis, "fetch", originalFetch);
  });

  // cli#430: the tests above import a fresh copy of auth.ts per test with
  // `?x=${Date.now()}`. Two tests that import within the same millisecond get
  // ONE module instance. auth.ts used to fix ~/.tps/auth at import time, so the
  // second test's revoke looked in the first test's (deleted) home and left its
  // own file behind. This case imports one instance under one HOME and uses it
  // under another, so it does not depend on timing.
  test("one module instance follows the HOME in effect at each call (revoke and status)", async () => {
    const mod = await import("../src/commands/auth.js?one-instance-two-homes");
    const other = mkdtempSync(join(tmpdir(), "tps-auth-test-other-"));
    const creds = JSON.stringify({
      provider: "anthropic",
      refreshToken: "r1",
      accessToken: "a1",
      expiresAt: Date.now() + 60 * 60 * 1000,
      clientId: "id",
      scopes: "scope",
    });
    try {
      // `other` first: the module was imported under `root` (or an earlier
      // HOME), so an import-time path would never point at `other`.
      for (const home of [other, root]) {
        process.env.HOME = home;
        const file = join(home, ".tps", "auth", "anthropic.json");
        mkdirSync(join(home, ".tps", "auth"), { recursive: true });

        writeFileSync(file, creds);
        await mod.runAuth({ action: "revoke", provider: "anthropic" });
        expect(existsSync(file)).toBe(false);

        writeFileSync(file, creds);
        logs.length = 0;
        mod.showStatus();
        expect(logs.join("\n")).toContain("expires in");
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

});
