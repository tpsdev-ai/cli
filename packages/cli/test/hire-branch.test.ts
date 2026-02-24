import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

describe("hire --branch", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tps-hire-branch-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync("bun", [TPS_BIN, ...args], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tempHome,
        ...env,
      },
    });
  }

  test("--branch defaults workspace to ~/.tps/branch-office/<id>/workspace", () => {
    const r = run(["hire", "developer", "--name", "BranchA", "--branch"]);
    expect(r.status).toBe(0);

    const ws = join(tempHome, ".tps", "branch-office", "brancha", "workspace");
    expect(existsSync(join(ws, "SOUL.md"))).toBe(true);
    expect(existsSync(join(tempHome, ".tps", "branch-office", "brancha", ".openclaw", "openclaw.json"))).toBe(true);
  });

  test("--branch with explicit workspace outside branch root is rejected", () => {
    const r = run(["hire", "developer", "--branch", "--workspace", join(tempHome, "outside")]);
    expect(r.status).not.toBe(0);
    expect((r.stdout || "") + (r.stderr || "")).toContain("~/.tps/branch-office/");
  });

  test("--branch skips nono re-exec even if nono is available", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "tps-fake-bin-"));
    const fakeNono = join(fakeBin, "nono");
    const log = join(fakeBin, "nono.log");
    const script = `#!/bin/sh\necho called >> \"${log}\"\nexit 0\n`;
    writeFileSync(fakeNono, script, { mode: 0o755 });

    const r = run(["hire", "developer", "--branch", "--name", "BranchB"], {
      PATH: `${fakeBin}:${process.env.PATH}`,
    });
    expect(r.status).toBe(0);
    expect(existsSync(log)).toBe(false);

    rmSync(fakeBin, { recursive: true, force: true });
  });

  test("--branch writes sandbox openclaw.json fragment", () => {
    const r = run(["hire", "developer", "--name", "BranchC", "--branch"]);
    expect(r.status).toBe(0);

    const cfgPath = join(tempHome, ".tps", "branch-office", "branchc", ".openclaw", "openclaw.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(Array.isArray(cfg.agents.list)).toBe(true);
    expect(cfg.agents.list[0].id).toBe("branchc");
  });
});
