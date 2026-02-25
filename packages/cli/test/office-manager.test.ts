import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  loadWorkspaceManifest,
  runOfficeManager,
  OFFICE_READY_MARKER,
  WorkspaceManifestSchema,
} from "../src/commands/office-manager.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const FAKE_NONO_BIN_DIR = join(import.meta.dir, "fakes/nono/bin");

describe("WorkspaceManifestSchema", () => {
  test("parses a minimal manifest with no tools", () => {
    const manifest = WorkspaceManifestSchema.parse({ name: "test-office" });
    expect(manifest.name).toBe("test-office");
    expect(manifest.tools.apk).toEqual([]);
    expect(manifest.tools.npm).toEqual([]);
    expect(manifest.tools.curl).toEqual([]);
  });

  test("parses a full manifest with all tool types", () => {
    const manifest = WorkspaceManifestSchema.parse({
      name: "dev-office",
      tools: {
        apk: ["git", "curl"],
        npm: ["gh", { name: "@anthropic-ai/claude-code", version: "1.0.0" }],
        curl: [{ url: "https://example.com/bin", dest: "/usr/local/bin/foo" }],
      },
    });
    expect(manifest.tools.apk).toEqual(["git", "curl"]);
    expect(manifest.tools.npm).toHaveLength(2);
    expect(manifest.tools.curl[0]!.chmod).toBe("755");
  });

  test("rejects manifest without name", () => {
    expect(() => WorkspaceManifestSchema.parse({ tools: {} })).toThrow();
  });

  test("rejects curl entry with invalid URL", () => {
    expect(() =>
      WorkspaceManifestSchema.parse({
        name: "test",
        tools: { curl: [{ url: "not-a-url", dest: "/tmp/x" }] },
      })
    ).toThrow();
  });
});

describe("loadWorkspaceManifest", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-om-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null when no manifest file exists", () => {
    expect(loadWorkspaceManifest(tmpDir)).toBeNull();
  });

  test("loads workspace-manifest.json", () => {
    writeFileSync(
      join(tmpDir, "workspace-manifest.json"),
      JSON.stringify({ name: "test", tools: { apk: ["git"] } })
    );
    const manifest = loadWorkspaceManifest(tmpDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.tools.apk).toEqual(["git"]);
  });

  test("loads workspace-manifest.yaml", () => {
    writeFileSync(
      join(tmpDir, "workspace-manifest.yaml"),
      "name: yaml-office\ntools:\n  apk:\n    - jq\n"
    );
    const manifest = loadWorkspaceManifest(tmpDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.name).toBe("yaml-office");
  });

  test("prefers .json over .yaml when both exist", () => {
    writeFileSync(join(tmpDir, "workspace-manifest.json"), JSON.stringify({ name: "json-version" }));
    writeFileSync(join(tmpDir, "workspace-manifest.yaml"), "name: yaml-version\n");
    const manifest = loadWorkspaceManifest(tmpDir);
    expect(manifest!.name).toBe("json-version");
  });
});

describe("runOfficeManager (dry-run)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-om-run-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns true and writes .office-ready when no manifest exists", async () => {
    const ok = await runOfficeManager(tmpDir, { dryRun: false });
    expect(ok).toBe(true);
    expect(existsSync(join(tmpDir, OFFICE_READY_MARKER))).toBe(true);
  });

  test("dry-run does not write .office-ready", async () => {
    writeFileSync(
      join(tmpDir, "workspace-manifest.json"),
      JSON.stringify({ name: "test", tools: { apk: [], npm: [] } })
    );
    const ok = await runOfficeManager(tmpDir, { dryRun: true });
    expect(ok).toBe(true);
    expect(existsSync(join(tmpDir, OFFICE_READY_MARKER))).toBe(false);
  });

  test("dry-run succeeds even with uninstallable packages listed", async () => {
    writeFileSync(
      join(tmpDir, "workspace-manifest.json"),
      JSON.stringify({ name: "test", tools: { apk: ["some-apk-pkg"], npm: ["some-npm-pkg"] } })
    );
    // In dry-run mode, no actual installation happens so it should succeed
    const ok = await runOfficeManager(tmpDir, { dryRun: true });
    expect(ok).toBe(true);
  });

  test(".office-ready contains a timestamp", async () => {
    await runOfficeManager(tmpDir, { dryRun: false });
    const content = readFileSync(join(tmpDir, OFFICE_READY_MARKER), "utf-8").trim();
    // Should be a valid ISO timestamp
    expect(new Date(content).getTime()).toBeGreaterThan(0);
  });
});

describe("tps office setup CLI integration", () => {
  let tempRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-setup-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempRoot;
    process.env.TPS_VAULT_KEY = "test-passphrase";
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    delete process.env.TPS_VAULT_KEY;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync("bun", [TPS_BIN, ...args], {
      encoding: "utf-8",
      cwd: tempRoot,
      env: {
        ...process.env,
        PATH: `${FAKE_NONO_BIN_DIR}:${process.env.PATH}`,
        TPS_OFFICE_SKIP_RELAY: "1",
        TPS_OFFICE_SKIP_VM: "1",
        ...env,
      },
    });
  }

  test("setup with no manifest marks office ready", () => {
    // First create the workspace via office start
    const start = run(["office", "start", "test-agent"]);
    expect(start.status).toBe(0);

    const setup = run(["office", "setup", "test-agent"]);
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("Office ready");

    const ws = join(tempRoot, ".tps", "branch-office", "test-agent");
    expect(existsSync(join(ws, OFFICE_READY_MARKER))).toBe(true);
  });

  test("setup --dry-run does not write .office-ready", () => {
    const start = run(["office", "start", "test-agent"]);
    expect(start.status).toBe(0);

    const ws = join(tempRoot, ".tps", "branch-office", "test-agent");
    // Write a manifest so dry-run has something to log
    writeFileSync(
      join(ws, "workspace-manifest.json"),
      JSON.stringify({ name: "test", tools: { apk: ["git"] } })
    );

    const setup = run(["office", "setup", "test-agent", "--dry-run"]);
    expect(setup.status).toBe(0);
    expect(existsSync(join(ws, OFFICE_READY_MARKER))).toBe(false);
  });
});
