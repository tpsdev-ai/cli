import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

const FAKE_DOCKER_BIN_DIR = join(import.meta.dir, "fakes/docker/bin");

describe("office command", () => {
  let tempRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-office-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempRoot;
    process.env.TPS_VAULT_KEY = "test-passphrase";
    // Ensure fake docker is executable (git permission might be lost in some CI/checkouts)
    const fakeDocker = join(FAKE_DOCKER_BIN_DIR, "docker");
    try {
      chmodSync(fakeDocker, 0o755);
    } catch {
      // ignore if not owned or read-only
    }
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    delete process.env.TPS_VAULT_KEY;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync("bun", [TPS_BIN, ...args], {
      encoding: "utf-8",
      cwd: tempRoot,
      env: {
        ...process.env,
        PATH: `${FAKE_DOCKER_BIN_DIR}:${process.env.PATH}`,
        TPS_OFFICE_SKIP_RELAY: "1",
        TPS_OFFICE_SKIP_VM: "1",
        ...env,
      },
    });
  }

  test("start creates branch-office dir structure and bootstrap script", () => {
    const r = run(["office", "start", "brancha"]);
    if (r.status !== 0) {
      console.error("Test failed stdout:", r.stdout);
      console.error("Test failed stderr:", r.stderr);
    }
    expect(r.status).toBe(0);

    const ws = join(tempRoot, ".tps", "branch-office", "brancha");
    expect(existsSync(join(ws, "mail", "inbox", "new"))).toBe(true);
    expect(existsSync(join(ws, "mail", "inbox", "cur"))).toBe(true);
    expect(existsSync(join(ws, "mail", "outbox", "new"))).toBe(true);
    expect(existsSync(join(ws, "mail", "outbox", "cur"))).toBe(true);
    expect(existsSync(join(ws, "bootstrap.sh"))).toBe(true);
    const bootstrap = readFileSync(join(ws, "bootstrap.sh"), "utf-8");
    expect(bootstrap).toContain("npm install -g openclaw");

    // ops-15.5: Check overwrite protection
    writeFileSync(join(ws, "bootstrap.sh"), "echo custom", { mode: 0o755 });
    const r2 = run(["office", "start", "brancha"]);
    expect(r2.status).toBe(0);
    const bootstrap2 = readFileSync(join(ws, "bootstrap.sh"), "utf-8");
    expect(bootstrap2).toBe("echo custom");
    expect(r2.stdout).toContain("Using existing bootstrap.sh");
  });

  test("start rejects invalid agent id", () => {
    const r = run(["office", "start", "../../etc/passwd"]);
    expect(r.status).not.toBe(0);
    expect((r.stdout || "") + (r.stderr || "")).toContain("Invalid agent id");
  });

  test("stop handles missing sandbox gracefully", () => {
    const r = run(["office", "stop", "brancha"]);
    expect(r.status).not.toBe(0);
    expect((r.stdout || "") + (r.stderr || "")).toContain("No sandbox found");
  });

  test("list handles no workspaces gracefully", () => {
    const r = run(["office", "list"]);
    expect(r.status).toBe(0);
    expect((r.stdout || "") + (r.stderr || "")).toContain("No branch-office workspaces found");
  });

  test("status handles missing sandbox gracefully", () => {
    const r = run(["office", "status", "brancha"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Sandbox: not running");
  });

  test("status shows paused message count when loop-detected messages exist", () => {
    const start = run(["office", "start", "brancha"]);
    expect(start.status).toBe(0);

    const pausedDir = join(tempRoot, ".tps", "branch-office", "brancha", "mail", "outbox", "paused");
    mkdirSync(pausedDir, { recursive: true });
    writeFileSync(join(pausedDir, "paused-1.json"), JSON.stringify({ to: "host", body: "loop" }), "utf-8");

    const status = run(["office", "status", "brancha"]);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("Paused messages (loop detected): 1");
    expect(status.stdout).toContain("Review:");
  });

  test("team members resolve to the shared team sandbox (ops-17)", () => {
    const teamRoot = join(tempRoot, ".tps", "branch-office", "team-x");
    mkdirSync(join(teamRoot, "workspace"), { recursive: true });
    writeFileSync(
      join(teamRoot, "team.json"),
      JSON.stringify({ members: ["dev-1", "dev-2"] }),
      "utf-8"
    );

    const start1 = run(["office", "start", "dev-1"]);
    expect(start1.status).toBe(0);
    expect(start1.stdout).toContain("Shared team sandbox: team-x");

    const start2 = run(["office", "start", "dev-2"]);
    expect(start2.status).toBe(0);
    expect(start2.stdout).toContain("Shared team sandbox: team-x");
  });
});
