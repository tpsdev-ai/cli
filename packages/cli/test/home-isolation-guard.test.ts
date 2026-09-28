/**
 * home-isolation-guard.test.ts — cli#430.
 *
 * Unit coverage for the two halves of the suite-level HOME guard:
 *   - scripts/test-home-guard.mjs — the real `~/.tps` before/after snapshot;
 *   - scripts/home-isolation-preload.ts — the launch-time precondition that
 *     aborts a run whose os.homedir() is outside the isolated test root.
 *
 * The end-to-end proof (a deliberately leaking test failing the run) is done in
 * the PR with a temporary probe, not committed here. The preload is exercised
 * directly by spawning bun with `--preload`, which is exactly how the launcher
 * loads it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { diffSnapshots, snapshotTps } from "../../../scripts/test-home-guard.mjs";

const PRELOAD = resolve(import.meta.dir, "../../../scripts/home-isolation-preload.ts");

describe("test-home-guard: real ~/.tps snapshot", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tps-guard-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("no change -> empty diff", () => {
    mkdirSync(join(home, ".tps", "identity"), { recursive: true });
    writeFileSync(join(home, ".tps", "identity", "a.key"), "seed");
    const before = snapshotTps(home);
    // A second snapshot of an untouched tree is identical.
    expect(diffSnapshots(before, snapshotTps(home))).toEqual([]);
  });

  test("a created .tps is a change", () => {
    const before = snapshotTps(home); // .tps does not exist yet
    mkdirSync(join(home, ".tps"), { recursive: true });
    const changed = diffSnapshots(before, snapshotTps(home));
    expect(changed).toContain(".tps created");
  });

  test("a new file under .tps is a change", () => {
    mkdirSync(join(home, ".tps", "identity"), { recursive: true });
    const before = snapshotTps(home);
    writeFileSync(join(home, ".tps", "identity", "key-test-ops36.key"), "seed");
    const changed = diffSnapshots(before, snapshotTps(home));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.some((p) => p.includes("key-test-ops36.key"))).toBe(true);
  });

  test("a size change to an existing file is a change", () => {
    mkdirSync(join(home, ".tps", "credentials"), { recursive: true });
    writeFileSync(join(home, ".tps", "credentials", "audit.log"), "row\n");
    const before = snapshotTps(home);
    writeFileSync(join(home, ".tps", "credentials", "audit.log"), "row\nrow2\n");
    const changed = diffSnapshots(before, snapshotTps(home));
    expect(changed.some((p) => p.includes("audit.log"))).toBe(true);
  });
});

describe("home-isolation-preload: launch-time precondition", () => {
  let dirs: string[];
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function mktmp(prefix: string): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(d);
    return d;
  }

  function runPreload(env: Record<string, string | undefined>): { status: number | null; stdout: string; stderr: string } {
    const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
    // An explicit `undefined` DELETES the variable (so "unset" is testable even
    // though the parent lane sets it).
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete childEnv[k];
      else childEnv[k] = v;
    }
    const r = spawnSync("bun", [`--preload=${PRELOAD}`, "-e", "console.log('LOADED')"], {
      encoding: "utf-8",
      env: childEnv,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("aborts when TPS_TEST_ROOT is unset", () => {
    // CONTROL: without the precondition, a bare `bun test` under a real HOME
    // runs the suite against the real ~/.tps.
    const r = runPreload({ TPS_TEST_ROOT: undefined });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ISOLATION GUARD");
    expect(r.stdout).not.toContain("LOADED");
  });

  test("aborts when os.homedir() is outside TPS_TEST_ROOT", () => {
    const root = mktmp("tps-guard-root-");
    const elsewhere = mktmp("tps-guard-elsewhere-");
    const r = runPreload({ TPS_TEST_ROOT: root, HOME: elsewhere });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ISOLATION GUARD");
    expect(r.stderr).toContain("OUTSIDE");
    expect(r.stdout).not.toContain("LOADED");
  });

  test("passes when os.homedir() is inside TPS_TEST_ROOT", () => {
    const root = mktmp("tps-guard-root-");
    const r = runPreload({ TPS_TEST_ROOT: root, HOME: root });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LOADED");
  });
});
