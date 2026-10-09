import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditExcludes, parseMinReleaseAgeExcludes } from "../scripts/lib/check-dep-ages-collect.mjs";

const gate = fileURLToPath(new URL("../scripts/check-dep-ages.mjs", import.meta.url));
const collector = new URL("../scripts/lib/check-dep-ages-collect.mjs", import.meta.url).href;

function fallback(text: string) {
  const run = spawnSync("node", ["--input-type=module", "-e",
    `import { parseMinReleaseAgeExcludes } from ${JSON.stringify(collector)};
     console.log(JSON.stringify(parseMinReleaseAgeExcludes(process.argv[1])));`, text], { encoding: "utf8" });
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout);
}

describe("exclusion parser conformance", () => {
  it.each([
    'minimumReleaseAgeExcludes = ["foo", "bar"]',
    '"minimumReleaseAgeExcludes" = ["foo", "bar"]',
    '"minimumReleaseAge\\u0045xcludes" = ["foo", "bar"]',
    "'minimumReleaseAgeExcludes' = ['foo', 'bar']",
    'minimumReleaseAgeExcludes = [\n "foo",\n "bar",\n]',
  ])("matches real Bun.TOML.parse for %s", (declaration) => {
    const text = `[install]\n${declaration}\n`;
    expect(parseMinReleaseAgeExcludes(text)).toEqual({
      names: Bun.TOML.parse(text).install.minimumReleaseAgeExcludes, error: null,
    });
  });

  it("keeps the ordinary Node fallback form", () => {
    const text = '[install]\nminimumReleaseAgeExcludes = ["foo", "bar",] # names\n';
    expect(fallback(text)).toEqual({ names: ["foo", "bar"], error: null });
    expect(fallback('[install]\nminimumReleaseAge = 604800\n')).toEqual({ names: [], error: null });
    expect(fallback('[install]\nminimumReleaseAgeExcludes = []\n')).toEqual({ names: [], error: null });
  });

  it.each([
    '[install]\n"minimumReleaseAgeExcludes" = ["foo"]',
    '[install]\n"minimumReleaseAge\\u0045xcludes" = ["foo"]',
    "[install]\n'minimumReleaseAgeExcludes' = ['foo']",
    '[install]\nminimumReleaseAgeExcludes = ["foo",, "bar"]',
    '[install]\nminimumReleaseAgeExcludes = [\n "foo",\n "bar"\n]',
    '[install]\nminimumReleaseAgeExcludes = { name = "foo" }',
    'install = { minimumReleaseAgeExcludes = ["foo"] }',
    '["install"]\nminimumReleaseAgeExcludes = ["foo"]',
    '["install"]\n"minimumReleaseAge\\u0045xcludes" = ["foo"]',
    '"inst\\u0061ll" = { "minimumReleaseAge\\u0045xcludes" = ["foo"] }',
    '[install]\nminimumReleaseAgeExcludes = ["foo"]\nminimumReleaseAgeExcludes = []',
  ])("refuses unsupported fallback syntax: %s", (text) => {
    expect(fallback(text)).toMatchObject({ names: [], error: expect.stringContaining("minimumReleaseAgeExcludes") });
  });

  it("refuses a malformed array under real Bun", () => {
    const text = '[install]\nminimumReleaseAgeExcludes = ["foo",, "bar"]';
    expect(() => Bun.TOML.parse(text)).toThrow();
    expect(parseMinReleaseAgeExcludes(text)).toMatchObject({
      names: [], error: expect.stringContaining("minimumReleaseAgeExcludes"),
    });
  });
});

describe("excluded declarations", () => {
  it("fails with a named error when an excluded name has no declaration", () => {
    linkedFixture((root) => {
      const output = runGate(root);
      expect(output).toContain("foo: excluded but not pinned: declare it exactly, e.g. via overrides, or remove the exclude");
      expect(output).not.toContain("Checking");
    });
  });

  it("passes the exclusion audit with only an exact override", () => {
    linkedFixture((root) => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ overrides: { foo: "1.0.0" } }));
      expect(runGate(root)).toContain("bun.lock is not parseable");
    });
  });

  it.each(["devDependencies", "optionalDependencies", "peerDependencies", "overrides"])(
    "reports a range in %s after an exact dependency", (field) => {
      expect(auditExcludes({
        excludes: ["foo"], exceptionEntries: new Map([["foo@1.0.0", {}]]), exceptionErrors: [],
        packageJsons: [{ path: "package.json", json: {
          dependencies: { foo: "1.0.0" }, [field]: { foo: "^1.0.0" },
        } }],
      })).toEqual([{ kind: "range", name: "foo", path: "package.json", spec: "^1.0.0" }]);
    },
  );
});

function linkedFixture(check: (root: string, outside: string) => void) {
  const scratch = mkdtempSync(join(tmpdir(), "age-links-"));
  const root = join(scratch, "repo");
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, ".git", "target"), { recursive: true });
    writeFileSync(join(root, "bunfig.toml"), '[install]\nminimumReleaseAge = 604800\nminimumReleaseAgeExcludes = ["foo"]\n');
    writeFileSync(join(root, "docs", "dep-age-exceptions.md"), '## Exceptions\n- foo@1.0.0 | expires:9999-12-31 | reason: fixture\n');
    writeFileSync(join(root, "bun.lock"), "invalid lock");
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "package.json"), JSON.stringify({ dependencies: { foo: "1.0.0" } }));
    check(root, outside);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runGate(root: string) {
  const run = spawnSync("node", [gate], {
    env: { PATH: process.env.PATH, TPS_DEP_AGES_ROOT: root }, encoding: "utf8", timeout: 5000,
  });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(2);
  return run.stdout + run.stderr;
}

describe("manifest symlinks", () => {
  it.each(["file", "directory"])("checks an in-root %s link", (kind) => {
    linkedFixture((root) => {
      const target = join(root, ".git", "target");
      writeFileSync(join(target, "package.json"), JSON.stringify({ dependencies: { foo: "^1.0.0" } }));
      symlinkSync(kind === "file" ? join(target, "package.json") : target,
        join(root, kind === "file" ? "package.json" : "linked"));
      expect(runGate(root)).toContain("`foo` is declared as `^1.0.0`");
    });
  });

  it.each(["file", "directory"])("refuses an outside-root %s link", (kind) => {
    linkedFixture((root, outside) => {
      const path = kind === "file" ? "package.json" : "linked";
      symlinkSync(kind === "file" ? join(outside, "package.json") : outside, join(root, path));
      const output = runGate(root);
      expect(output).toContain(`cannot inspect ${path}`);
      expect(output).toContain("symlink resolves outside repository root");
    });
  });

  it("terminates a directory link cycle before reading the lock", () => {
    linkedFixture((root) => {
      mkdirSync(join(root, "nested"));
      symlinkSync(root, join(root, "nested", "back"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { foo: "1.0.0" } }));
      expect(runGate(root)).toContain("bun.lock is not parseable");
    });
  });
});
