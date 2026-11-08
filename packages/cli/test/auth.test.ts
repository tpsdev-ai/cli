import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

afterEach(() => { mock.restore(); });

describe("tps auth", () => {
  let root: string;
  let logs: string[];
  let oldHome: string | undefined;
  let oldLog: (...args: any[]) => void;
  let oldFetch: typeof fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-auth-test-"));
    oldHome = process.env.HOME;
    process.env.HOME = root;

    oldFetch = globalThis.fetch;
    logs = [];
    oldLog = console.log;
    patchShared(console, "log", (...args: any[]) => logs.push(args.join(" ")));
  });

  afterEach(() => {
    patchShared(globalThis, "fetch", oldFetch);
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

  describe("OpenAI token refresh", () => {
    const credentials = {
      provider: "openai", accessToken: "old-access", refreshToken: "old-refresh",
      expiresAt: 1, clientId: "fixture-client", scopes: "fixture-scope",
    };
    let store: string;
    let codex: string;

    beforeEach(async () => {
      codex = join(root, "codex-home", "auth.json");
      mkdirSync(join(root, "codex-home"));
      patchShared(process.env, "CODEX_HOME", join(root, "codex-home"));
      writeFileSync(codex, JSON.stringify({ ...credentials, metadata: { keep: true } }));
      const { runAuth } = await import("../src/commands/auth.js");
      await runAuth({ action: "login", provider: "openai" });
      store = join(root, ".tps", "auth", "openai.json");
    });

    function respond(body: unknown, status = 200) {
      patchShared(globalThis, "fetch", (async (url, init) => {
        expect(String(url)).toBe("https://auth.openai.com/oauth/token");
        expect(init?.method).toBe("POST");
        expect(Object.fromEntries(new URLSearchParams(init?.body as URLSearchParams))).toEqual({
          grant_type: "refresh_token", client_id: "fixture-client", refresh_token: "old-refresh",
        });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch);
    }

    test("saves rotated OpenAI credentials to the provider store and flat Codex file", async () => {
      const previousUmask = process.umask(0o022);
      try {
        respond({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 });
        const before = Date.now();
        const { refreshOpenAIToken } = await import("../src/commands/auth.js");
        const refreshed = await refreshOpenAIToken(credentials);
        const saved = JSON.parse(readFileSync(store, "utf8"));
        expect(saved).toEqual(refreshed);
        expect(saved).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
        expect(saved.expiresAt).toBeGreaterThanOrEqual(before + 7200_000);
        expect(saved.expiresAt).toBeLessThanOrEqual(Date.now() + 7200_000);
        expect(JSON.parse(readFileSync(codex, "utf8"))).toEqual({
          ...credentials, metadata: { keep: true },
          accessToken: saved.accessToken, refreshToken: saved.refreshToken, expiresAt: saved.expiresAt,
        });
        expect(statSync(store).mode & 0o777).toBe(0o600);
        expect(statSync(join(root, ".tps", "auth")).mode & 0o777).toBe(0o700);
        expect(logs.join("\n")).not.toContain("new-access");
        expect(logs.join("\n")).not.toContain("new-refresh");
      } finally {
        process.umask(previousUmask);
      }
    });

    test("saves rotated OpenAI credentials to the provider store and nested Codex file", async () => {
      const original = {
        auth_mode: "chatgpt", last_refresh: "2020-01-01T00:00:00.000Z", expires_at: 1,
        tokens: {
          access_token: "old-access", refresh_token: "old-refresh",
          account_id: "fixture-client", id_token: "fixture-id", extra: { keep: true },
        },
        metadata: { keep: true },
      };
      writeFileSync(codex, JSON.stringify(original));
      const { runAuth, refreshOpenAIToken } = await import("../src/commands/auth.js");
      await runAuth({ action: "login", provider: "openai" });
      const imported = JSON.parse(readFileSync(store, "utf8"));
      expect(imported).toMatchObject({ accessToken: "old-access", refreshToken: "old-refresh", clientId: "fixture-client", expiresAt: 1 });
      respond({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 });
      const before = Date.now();
      const refreshed = await refreshOpenAIToken(imported);
      expect(JSON.parse(readFileSync(store, "utf8"))).toEqual(refreshed);
      const synced = JSON.parse(readFileSync(codex, "utf8"));
      expect(synced).toEqual({
        ...original,
        tokens: { ...original.tokens, access_token: "new-access", refresh_token: "new-refresh" },
        expires_at: refreshed.expiresAt, last_refresh: synced.last_refresh,
      });
      expect(Date.parse(synced.last_refresh)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(synced.last_refresh)).toBeLessThanOrEqual(Date.now());
      await runAuth({ action: "login", provider: "openai" });
      expect(JSON.parse(readFileSync(store, "utf8"))).toMatchObject({
        accessToken: "new-access", refreshToken: "new-refresh", expiresAt: refreshed.expiresAt,
      });
    });

    for (const [shape, original] of [
      ["tokenless object", { auth_mode: "apikey" }],
      ["array tokens", { auth_mode: "chatgpt", tokens: [] }],
      ["nested access token alone", { tokens: { access_token: "old-access" } }],
      ["nested refresh token alone", { tokens: { refresh_token: "old-refresh" } }],
      ["accessToken alone", { accessToken: "old-access" }],
      ["access_token alone", { access_token: "old-access" }],
      ["refreshToken alone", { refreshToken: "old-refresh" }],
      ["refresh_token alone", { refresh_token: "old-refresh" }],
    ] as const) {
      test(`skips a Codex file with ${shape} and warns after saving TPS credentials`, async () => {
        const warnings: string[] = [];
        patchShared(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
        writeFileSync(codex, JSON.stringify(original));
        const codexBefore = readFileSync(codex);
        respond({ access_token: "new-access", refresh_token: "new-refresh" });
        const { refreshOpenAIToken } = await import("../src/commands/auth.js");
        const refreshed = await refreshOpenAIToken(credentials);
        expect(JSON.parse(readFileSync(store, "utf8"))).toEqual(refreshed);
        expect(refreshed).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("CodexSyncWarning:");
        expect(warnings[0]).toContain(codex);
        expect(readFileSync(codex)).toEqual(codexBefore);
      });
    }

    for (const [shape, partial] of [
      ["tokenless", { auth_mode: "apikey" }],
      ["partial flat", { accessToken: "old-access" }],
      ["partial nested", { tokens: { access_token: "old-access" } }],
    ] as const) {
      test(`skips a ${shape} first Codex candidate and updates a later nested file`, async () => {
        const warnings: string[] = [];
        patchShared(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
        writeFileSync(codex, JSON.stringify(partial));
        const codexBefore = readFileSync(codex);
        const later = join(root, ".config", "codex", "auth.json");
        mkdirSync(join(root, ".config", "codex"), { recursive: true });
        const original = {
          tokens: { access_token: "old-access", refresh_token: "old-refresh", account_id: "fixture-client" },
          metadata: { keep: true },
        };
        writeFileSync(later, JSON.stringify(original));
        respond({ access_token: "new-access", refresh_token: "new-refresh" });
        const { refreshOpenAIToken, runAuth } = await import("../src/commands/auth.js");
        await runAuth({ action: "login", provider: "openai" });
        expect(JSON.parse(readFileSync(store, "utf8"))).toMatchObject({
          accessToken: "old-access", refreshToken: "old-refresh",
        });
        const refreshed = await refreshOpenAIToken(credentials);
        expect(JSON.parse(readFileSync(store, "utf8"))).toEqual(refreshed);
        expect(readFileSync(codex)).toEqual(codexBefore);
        expect(JSON.parse(readFileSync(later, "utf8"))).toEqual({
          ...original, tokens: { ...original.tokens, access_token: "new-access", refresh_token: "new-refresh" },
        });
        expect(warnings).toHaveLength(0);
      });
    }

    for (const failure of ["absent", "descriptor write"]) {
      test(`keeps refreshed TPS credentials with ${failure} Codex file`, async () => {
        const previousUmask = process.umask(0o022);
        try {
          const warnings: string[] = [];
          patchShared(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
          if (failure === "absent") rmSync(codex);
          const later = join(root, ".config", "codex", "auth.json");
          if (failure === "descriptor write") {
            mkdirSync(join(root, ".config", "codex"), { recursive: true });
            writeFileSync(later, JSON.stringify(credentials));
          }
          const laterBefore = existsSync(later) ? readFileSync(later) : undefined;
          let temporary: string | undefined;
          let descriptor: number | undefined;
          let failDescriptorWrite = true;
          const open = fs.openSync;
          const write = fs.writeFileSync;
          const opening = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
            const fd = open(path, flags, mode);
            if (String(path).startsWith(`${codex}.`)) {
              temporary = String(path);
              descriptor = fd;
            }
            return fd;
          });
          const writing = spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => {
            if (failure === "descriptor write" && path === descriptor && failDescriptorWrite) {
              failDescriptorWrite = false;
              write(path, "partial");
              throw new Error("fixture write failure: new-access new-refresh");
            }
            return write(path, data, options);
          });
          const codexBefore = existsSync(codex) ? readFileSync(codex) : undefined;
          respond({ access_token: "new-access", refresh_token: "new-refresh" });
          const { refreshOpenAIToken } = await import("../src/commands/auth.js");
          let refreshed;
          try {
            refreshed = await refreshOpenAIToken(credentials);
          } finally {
            writing.mockRestore();
            opening.mockRestore();
          }
          if (failure === "descriptor write") {
            expect(temporary).toBeDefined();
            expect(existsSync(temporary!)).toBe(false);
            expect(() => fs.fstatSync(descriptor!)).toThrow();
            expect(readdirSync(join(root, "codex-home"))).toEqual(["auth.json"]);
          }
          expect(JSON.parse(readFileSync(store, "utf8"))).toEqual(refreshed);
          expect(refreshed).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
          expect(existsSync(codex) ? readFileSync(codex) : undefined).toEqual(codexBefore);
          expect(existsSync(later) ? readFileSync(later) : undefined).toEqual(laterBefore);
          expect(warnings).toHaveLength(failure === "absent" ? 0 : 1);
          if (failure !== "absent") {
            expect(warnings[0]).toContain("CodexSyncWarning:");
            expect(warnings[0]).toContain(codex);
          }
          for (const token of ["old-access", "old-refresh", "new-access", "new-refresh"]) {
            expect([...warnings, ...logs].join("\n")).not.toContain(token);
          }
        } finally {
          process.umask(previousUmask);
        }
      });
    }

    const permissionProbe = mkdtempSync(join(tmpdir(), "codex-readonly-probe-"));
    let readOnlyEnforced = false;
    try {
      chmodSync(permissionProbe, 0o500);
      try {
        writeFileSync(join(permissionProbe, "probe"), "probe", { flag: "wx" });
      } catch (error) {
        if (!["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        readOnlyEnforced = true;
      }
    } finally {
      chmodSync(permissionProbe, 0o700);
      rmSync(permissionProbe, { recursive: true, force: true });
    }

    test.skipIf(!readOnlyEnforced)("warns on the reader's unwritable Codex file without updating a later candidate", async () => {
      const warnings: string[] = [];
      patchShared(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
      const later = join(root, ".config", "codex", "auth.json");
      mkdirSync(join(root, ".config", "codex"), { recursive: true });
      writeFileSync(later, JSON.stringify({ ...credentials, accessToken: "later-access", refreshToken: "later-refresh" }));
      const firstBefore = readFileSync(codex);
      const laterBefore = readFileSync(later);
      const { refreshOpenAIToken, runAuth } = await import("../src/commands/auth.js");
      await runAuth({ action: "login", provider: "openai" });
      expect(JSON.parse(readFileSync(store, "utf8"))).toMatchObject({ accessToken: "old-access", refreshToken: "old-refresh" });
      respond({ access_token: "new-access", refresh_token: "new-refresh" });
      chmodSync(join(root, "codex-home"), 0o500);
      try {
        const refreshed = await refreshOpenAIToken(credentials);
        expect(JSON.parse(readFileSync(store, "utf8"))).toEqual(refreshed);
        expect(refreshed).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
        expect(readFileSync(codex)).toEqual(firstBefore);
        expect(readFileSync(later)).toEqual(laterBefore);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("CodexSyncWarning:");
        expect(warnings[0]).toContain(codex);
        expect(warnings[0]).not.toContain(later);
        for (const token of ["old-access", "old-refresh", "new-access", "new-refresh"]) {
          expect([...warnings, ...logs].join("\n")).not.toContain(token);
        }
      } finally {
        chmodSync(join(root, "codex-home"), 0o700);
      }
    });

    for (const refusal of [undefined, "EISDIR", "EINVAL", "EPERM"]) {
      test(`fsyncs credential parent directories and tolerates directory refusal: ${refusal ?? "none"}`, async () => {
        const directories: string[] = [];
        const syncedDirectories: number[] = [];
        const descriptors: number[] = [];
        const open = fs.openSync;
        const sync = fs.fsyncSync;
        const opening = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
          const fd = open(path, flags, mode);
          if (fs.fstatSync(fd).isDirectory()) {
            expect(flags).toBe("r");
            directories.push(String(path));
            descriptors.push(fd);
          }
          return fd;
        });
        const syncing = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
          if (fs.fstatSync(fd).isDirectory()) {
            syncedDirectories.push(fd);
            if (refusal) throw Object.assign(new Error("directory fsync refused"), { code: refusal });
          }
          return sync(fd);
        });
        const warnings: string[] = [];
        patchShared(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
        respond({ access_token: "new-access", refresh_token: "new-refresh" });
        const { refreshOpenAIToken } = await import("../src/commands/auth.js");
        try {
          await refreshOpenAIToken(credentials);
        } finally {
          syncing.mockRestore();
          opening.mockRestore();
        }
        expect(directories).toEqual([join(root, ".tps", "auth"), join(root, "codex-home")]);
        expect(syncedDirectories).toEqual(descriptors);
        for (const fd of descriptors) expect(() => fs.fstatSync(fd)).toThrow();
        expect(JSON.parse(readFileSync(store, "utf8"))).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
        expect(JSON.parse(readFileSync(codex, "utf8"))).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
        expect(warnings).toHaveLength(0);
      });
    }

    for (const kind of ["readable file", "symlink"]) {
      test(`leaves the old fixed Codex temporary path unchanged: ${kind}`, async () => {
        const previousUmask = process.umask(0o022);
        try {
          const warnings: string[] = [];
          patchShared(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
          const fixed = `${codex}.tmp`;
          const protectedFile = kind === "symlink" ? join(root, "symlink-target") : fixed;
          writeFileSync(protectedFile, "keep this content", { mode: 0o644 });
          if (kind === "symlink") symlinkSync(protectedFile, fixed);
          chmodSync(codex, 0o644);
          respond({ access_token: "new-access", refresh_token: "new-refresh" });
          const { refreshOpenAIToken } = await import("../src/commands/auth.js");
          await refreshOpenAIToken(credentials);
          expect(readFileSync(protectedFile, "utf8")).toBe("keep this content");
          expect(JSON.parse(readFileSync(codex, "utf8"))).toMatchObject({
            accessToken: "new-access", refreshToken: "new-refresh",
          });
          expect(statSync(codex).mode & 0o777).toBe(0o600);
          expect(readdirSync(join(root, "codex-home")).sort()).toEqual(["auth.json", "auth.json.tmp"]);
          expect(warnings).toHaveLength(0);
        } finally {
          process.umask(previousUmask);
        }
      });
    }

    test("keeps the stored refresh token when the response omits refresh_token", async () => {
      respond({ access_token: "new-access", expires_in: 3600 });
      const { refreshOpenAIToken } = await import("../src/commands/auth.js");
      const refreshed = await refreshOpenAIToken(credentials);
      expect(JSON.parse(readFileSync(store, "utf8"))).toEqual(refreshed);
      expect(refreshed.refreshToken).toBe("old-refresh");
      expect(JSON.parse(readFileSync(codex, "utf8"))).toMatchObject({
        accessToken: "new-access", refreshToken: "old-refresh", expiresAt: refreshed.expiresAt,
      });
    });

    test("replaces the provider file with mode 0600", async () => {
      const previousUmask = process.umask(0o022);
      try {
        const previous = join(root, "previous.json");
        linkSync(store, previous);
        const bytes = readFileSync(previous);
        chmodSync(store, 0o644);
        respond({ access_token: "new-access", refresh_token: "new-refresh" });
        const { refreshOpenAIToken } = await import("../src/commands/auth.js");
        await refreshOpenAIToken(credentials);
        expect(statSync(store).mode & 0o777).toBe(0o600);
        expect(readFileSync(previous)).toEqual(bytes);
        expect(readdirSync(join(root, ".tps", "auth"))).toEqual(["openai.json"]);
      } finally {
        process.umask(previousUmask);
      }
    });

    for (const failure of ["500", "network", "malformed JSON", "missing access_token", "non-string access_token", "non-string refresh_token", "null refresh_token", "negative expires_in", "non-finite expires_in", "non-string expires_in"]) {
      test(`leaves credential files unchanged on ${failure}`, async () => {
        const previousUmask = process.umask(0o022);
        try {
          const storeBefore = readFileSync(store);
          const codexBefore = readFileSync(codex);
          if (failure === "500") {
            respond({ access_token: "error-access", refresh_token: "error-refresh" }, 500);
          } else if (failure === "network") {
            patchShared(globalThis, "fetch", (async () => { throw new Error("fixture network failure"); }) as typeof fetch);
          } else if (failure === "malformed JSON") {
            patchShared(globalThis, "fetch", (async () => new Response('{"access_token":"error-access","refresh_token":"error-refresh",')) as typeof fetch);
          } else if (failure === "non-finite expires_in") {
            patchShared(globalThis, "fetch", (async () => new Response('{"access_token":"error-access","refresh_token":"error-refresh","expires_in":1e400}')) as typeof fetch);
          } else if (failure === "non-string refresh_token" || failure === "null refresh_token") {
            respond({ access_token: "error-access", refresh_token: failure === "null refresh_token" ? null : 123 });
          } else if (failure === "negative expires_in" || failure === "non-string expires_in") {
            respond({ access_token: "error-access", refresh_token: "error-refresh", expires_in: failure === "negative expires_in" ? -1 : "3600" });
          } else {
            respond({ refresh_token: "error-refresh", ...(failure === "non-string access_token" ? { access_token: 123 } : {}) });
          }
          const { refreshOpenAIToken } = await import("../src/commands/auth.js");
          if (failure === "malformed JSON") {
            await expect(refreshOpenAIToken(credentials)).rejects.toThrow("OpenAI token refresh returned invalid JSON");
          } else {
            await expect(refreshOpenAIToken(credentials)).rejects.toThrow();
          }
          expect(readFileSync(store)).toEqual(storeBefore);
          expect(readFileSync(codex)).toEqual(codexBefore);
          expect(statSync(store).mode & 0o777).toBe(0o600);
          expect(logs.join("\n")).not.toContain("error-access");
          expect(logs.join("\n")).not.toContain("error-refresh");
        } finally {
          process.umask(previousUmask);
        }
      });
    }
  });

});
