/**
 * cli#341 S1b — profile loading is validate-or-FAIL.
 *
 * One bundled directory (`nono-profiles/`), JSON profiles with `extends`
 * (nono 0.70+ shape), the surviving names plus the root tree's extras
 * (tps-office, tps-agent). A missing or invalid profile is a FAILURE — never
 * warn-and-continue.
 *
 * Uses the fake nono (which implements `profile validate`) so the fail-closed
 * path is exercised without a kernel backend.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import {
  checkProfileLoadable,
  resolveProfilePath,
  systemReadPaths,
  systemReadFiles,
  harnessReadPaths,
  harnessReadFiles,
  buildNonoArgs,
} from "../src/utils/nono.js";

const FAKE_NONO_DIR = join(import.meta.dir, "fakes/nono/bin");

let tmpHome: string;
let origPath: string | undefined;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "tps-profiles-"));
  origPath = process.env.PATH;
  origHome = process.env.HOME;
  process.env.PATH = `${FAKE_NONO_DIR}:${origPath ?? ""}`;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (origPath !== undefined) process.env.PATH = origPath;
  else delete process.env.PATH;
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  delete process.env.NONO_FAKE_VALIDATE_FAIL;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("the bundled profile set (one directory)", () => {
  test("the code-asked name tps-agent-run resolves", () => {
    expect(resolveProfilePath("tps-agent-run")).not.toBeNull();
  });

  test("the root tree's extras were carried in (tps-office, tps-agent)", () => {
    expect(resolveProfilePath("tps-office")).not.toBeNull();
    expect(resolveProfilePath("tps-agent")).not.toBeNull();
    expect(existsSync(resolveProfilePath("tps-office")!)).toBe(true);
  });
});

describe("validate-or-FAIL (never warn-and-continue)", () => {
  test("a valid profile loads ok", () => {
    const r = checkProfileLoadable("tps-agent-run");
    expect(r.ok).toBe(true);
    expect(r.path).not.toBeNull();
  });

  test("a MISSING profile is refused, with a reason", () => {
    const r = checkProfileLoadable("no-such-profile");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no-such-profile.json");
  });

  test("an INVALID profile is refused (validation failure, not a warning)", () => {
    process.env.NONO_FAKE_VALIDATE_FAIL = "1";
    const r = checkProfileLoadable("tps-agent-run");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("validate");
  });
});

describe("the read set replaces `--read /`", () => {
  test("systemReadPaths() carries the validated roots and never the root", () => {
    const paths = systemReadPaths();
    expect(paths).not.toContain("/");
    expect(paths.length).toBeGreaterThan(0);
    if (process.platform === "darwin") {
      for (const p of ["/opt/homebrew", "/usr", "/bin", "/sbin", "/Library"]) {
        expect(paths).toContain(p);
      }
    }
  });

  test("harnessReadPaths() grants dirs only — never the shared identity directory", () => {
    const paths = harnessReadPaths();
    expect(paths).not.toContain("/");
    expect(paths.some((p) => p.endsWith(join(".tps", "identity")))).toBe(false);
    expect(paths.some((p) => p.endsWith(".bun"))).toBe(true);
  });

  test("harnessReadFiles() is the system files plus exactly the agent's own key (.key/.pub)", () => {
    const idDir = join(homedir(), ".tps", "identity");
    const files = harnessReadFiles("agent1");
    expect(files).toContain(join(idDir, "agent1.key"));
    expect(files).toContain(join(idDir, "agent1.pub"));
    // no other agent's files
    expect(files.some((p) => p.includes("agent2"))).toBe(false);
    // without an id, no identity files at all
    expect(harnessReadFiles()).toEqual(systemReadFiles());
    // and nothing under the identity DIRECTORY is granted as a dir on Linux
    expect(systemReadPaths()).not.toContain("/etc");
  });

  test("systemReadFiles() grants the system git config — unreadable is FATAL to git (cli#351 r5b)", () => {
    const files = systemReadFiles();
    // /etc/gitconfig is granted where it exists: git reads it as part of
    // "reading the configuration files", and an unreadable one exits 128.
    if (existsSync("/etc/gitconfig")) expect(files).toContain("/etc/gitconfig");
    // every entry is filtered to a path that exists (no warned-and-skipped grant)
    for (const f of files) expect(existsSync(f)).toBe(true);
    expect(files).toContain("/etc/hosts");
    expect(files).toContain("/etc/resolv.conf");
  });

  test("buildNonoArgs emits --read-file for a single-file read grant", () => {
    const args = buildNonoArgs("tps-agent-run", { readFiles: ["/x/agent1.key"] }, ["echo"]);
    expect(args).toContain("--read-file");
    expect(args[args.indexOf("--read-file") + 1]).toBe("/x/agent1.key");
  });
});

describe("one validated launch path", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  }

  test("no source file spawnSync's nono outside the validated helper", () => {
    const srcDir = join(import.meta.dir, "..", "src");
    const offenders = walk(srcDir)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => readFileSync(f, "utf-8").includes("spawnSync(nono"))
      .map((f) => f.slice(srcDir.length + 1));
    // Only the validated helper (runCommandUnderNono) may invoke nono directly.
    expect(offenders).toEqual(["utils/nono.ts"]);
  });

  test("buildNonoArgs passes the resolved absolute profile path, not the bare name", () => {
    const args = buildNonoArgs("tps-hire", {}, ["echo", "x"]);
    const profileArg = args[args.indexOf("--profile") + 1];
    expect(profileArg.startsWith("/")).toBe(true);
    expect(profileArg.endsWith("tps-hire.json")).toBe(true);
  });
});

describe("the gate is a durable control", () => {
  test("CI wires scripts/check-nono-profiles.sh against a pinned nono, on Linux and macOS", () => {
    const yml = readFileSync(
      join(import.meta.dir, "..", "..", "..", ".github", "workflows", "test.yml"),
      "utf-8",
    );
    // The gate cannot be silently orphaned by a later workflow edit.
    expect(yml).toContain("./scripts/check-nono-profiles.sh");
    expect(yml).toContain("NONO_BIN=");
    expect(yml).toMatch(/macos-\d+/);
    expect(yml).toMatch(/nono-pin|\.nono-version|bc1406e9/);
  });
});
