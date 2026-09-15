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
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  checkProfileLoadable,
  resolveProfilePath,
  systemReadPaths,
  harnessReadPaths,
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

  test("harnessReadPaths() includes identity, bun and the interpreter dir", () => {
    const paths = harnessReadPaths();
    expect(paths).not.toContain("/");
    expect(paths.some((p) => p.endsWith(join(".tps", "identity")))).toBe(true);
    expect(paths.some((p) => p.endsWith(".bun"))).toBe(true);
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
