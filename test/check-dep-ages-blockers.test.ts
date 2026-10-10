import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditExcludes } from "../scripts/lib/check-dep-ages-collect.mjs";

const gate = fileURLToPath(new URL("../scripts/check-dep-ages.mjs", import.meta.url));
const node = Bun.which("node");

const AGE = "[install]\nminimumReleaseAge = 604800\n";

describe("the gate reads exclusions with Bun's TOML parser", () => {
  const DOTTED_AGE = "install.minimumReleaseAge = 604800\n";
  // `toml10`: the text defines `install` once, as TOML 1.0 requires, so the running Bun must
  // parse it; those cases cannot pass on a refusal. The other case defines `install` twice:
  // the expectation follows whatever the running Bun does with it.
  it.each([
    ["a plain [install] key", `${AGE}minimumReleaseAgeExcludes = ["foo", "bar"]\n`, true],
    ["a dotted key", `${DOTTED_AGE}install.minimumReleaseAgeExcludes = ["foo", "bar"]\n`, true],
    ["a quoted dotted key", `${DOTTED_AGE}install."minimumReleaseAgeExcludes" = ["foo", "bar"]\n`, true],
    ["an escaped dotted key", `${DOTTED_AGE}install."minimumReleaseAge\\u0045xcludes" = ["foo", "bar"]\n`, true],
    ["a literal dotted key", `${DOTTED_AGE}install.'minimumReleaseAgeExcludes' = ['foo', 'bar']\n`, true],
    ["an inline table", `install = { minimumReleaseAge = 604800, minimumReleaseAgeExcludes = ["foo", "bar"] }\n`, true],
    ["a multi-line array", `${AGE}minimumReleaseAgeExcludes = [\n  "foo",\n  "bar",\n]\n`, true],
    ["comments", `${AGE}# minimumReleaseAgeExcludes = ["decoy"]\nminimumReleaseAgeExcludes = [ # names\n  "foo", # first\n  # none here\n  "bar", ] # end\n`, true],
    ["an escaped dotted key before an [install] table", `install."minimumReleaseAge\\u0045xcludes" = ["foo", "bar"]\n${AGE}`, false],
  ])("matches the running Bun's parse of %s, and fails without a dated exception", (_label, bunfig, toml10) => {
    let parsed: unknown;
    let rejected: unknown = null;
    try {
      parsed = Bun.TOML.parse(bunfig).install.minimumReleaseAgeExcludes;
    } catch (err) {
      rejected = err;
    }
    if (toml10) expect(rejected).toBeNull();
    linkedFixture((root) => {
      writeFileSync(join(root, "bunfig.toml"), bunfig);
      writeFileSync(join(root, "docs", "dep-age-exceptions.md"), "## Exceptions\n");
      const output = runGate(root);
      if (rejected === null) {
        expect(parsed).toEqual(["foo", "bar"]);
        expect([...output.matchAll(/^ {4}(\S+): no dated entry under/gm)].map((m) => m[1])).toEqual(parsed);
      } else {
        expect(output).toContain("cannot read bunfig.toml with Bun's TOML parser: the parser rejected it");
      }
      expect(output).not.toContain("Checking");
    });
  });

  it("fails closed with a named error when bun cannot be run", () => {
    if (!node) throw new Error("test setup failed: node is not on PATH");
    linkedFixture((root) => {
      const noBun = join(root, "..", "no-bun");
      mkdirSync(noBun);
      const run = spawnSync(node, [gate], {
        env: { PATH: noBun, TPS_DEP_AGES_ROOT: root }, encoding: "utf8", timeout: 5000,
      });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("cannot read bunfig.toml with Bun's TOML parser: cannot run bun");
      expect(run.stderr).not.toContain("bun.lock");
    });
  });

  it("fails closed with a named error when Bun's parser rejects bunfig.toml", () => {
    const bunfig = `${AGE}minimumReleaseAgeExcludes = ["foo",, "bar"]\n`;
    expect(() => Bun.TOML.parse(bunfig)).toThrow();
    linkedFixture((root) => {
      writeFileSync(join(root, "bunfig.toml"), bunfig);
      const output = runGate(root);
      expect(output).toContain("cannot read bunfig.toml with Bun's TOML parser: the parser rejected it");
      expect(output).not.toContain("bun.lock");
    });
  });

  it("does not load the repository's bunfig.toml preload into the parsing process", () => {
    linkedFixture((root) => {
      writeFileSync(join(root, "patch.ts"), "Bun.TOML.parse = () => ({});\n");
      writeFileSync(join(root, "bunfig.toml"), `preload = ["./patch.ts"]\n${AGE}minimumReleaseAgeExcludes = ["foo"]\n`);
      writeFileSync(join(root, "docs", "dep-age-exceptions.md"), "## Exceptions\n");
      expect(runGate(root)).toContain("foo: no dated entry under");
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

  it("refuses an excluded name in a nested package.json's overrides and does not count it", () => {
    expect(auditExcludes({
      excludes: ["foo"], exceptionEntries: new Map([["foo@1.0.0", {}]]), exceptionErrors: [],
      packageJsons: [
        { path: "package.json", json: { workspaces: ["packages/*"] } },
        { path: join("packages", "w", "package.json"), json: { overrides: { foo: "1.0.0" } } },
      ],
    })).toEqual([
      { kind: "nested-override", name: "foo", path: join("packages", "w", "package.json") },
      { kind: "unpinned", name: "foo" },
    ]);
  });

  it("refuses an excluded name in resolutions, keyed by its name or **/ and its name", () => {
    expect(auditExcludes({
      excludes: ["foo"], exceptionEntries: new Map([["foo@1.0.0", {}]]), exceptionErrors: [],
      packageJsons: [{ path: "package.json", json: {
        overrides: { foo: "1.0.0" }, resolutions: { foo: "1.0.0", "**/foo": "1.0.0", "**/foobar": "1.0.0" },
      } }],
    })).toEqual([
      { kind: "resolution", name: "foo", path: "package.json", key: "foo" },
      { kind: "resolution", name: "foo", path: "package.json", key: "**/foo" },
    ]);
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

describe("the exclusion audit counts only the declarations Bun applies", () => {
  it("refuses an excluded name pinned exactly only in a manifest Bun does not apply", () => {
    appliedFixture((root) => {
      writeManifest(root, "package.json", { name: "fixture", workspaces: ["packages/*"] });
      writeManifest(root, join("packages", "w", "package.json"), { name: "w" });
      writeManifest(root, join("tools", "helper", "package.json"), {
        name: "helper", dependencies: { "dep-a": "1.0.0" },
      });
      const output = runGate(root);
      expect(output).toContain(
        "tools/helper/package.json: `dep-a` is declared exactly here, but this manifest is neither the root package.json nor a workspace",
      );
      expect(output).not.toContain("Checking");
    });
  });

  it.each([
    ["the root dependency", { workspaces: ["packages/*"], dependencies: { "dep-a": "1.0.0" } }],
    ["a root override", { workspaces: ["packages/*"], overrides: { "dep-a": "1.0.0" } }],
  ])("accepts a pin in %s", (_label, rootJson) => {
    appliedFixture((root) => {
      writeManifest(root, "package.json", { name: "fixture", ...(rootJson as object) });
      writeManifest(root, join("packages", "w", "package.json"), { name: "w" });
      writeManifest(root, join("tools", "helper", "package.json"), { name: "helper" });
      expect(runGate(root)).toContain("bun.lock is not parseable");
    });
  });

  it("accepts a pin in a workspace's dependencies", () => {
    appliedFixture((root) => {
      writeManifest(root, "package.json", { name: "fixture", workspaces: ["packages/*"] });
      writeManifest(root, join("packages", "w", "package.json"), {
        name: "w", dependencies: { "dep-a": "1.0.0" },
      });
      writeManifest(root, join("tools", "helper", "package.json"), { name: "helper" });
      expect(runGate(root)).toContain("bun.lock is not parseable");
    });
  });

  // Also run against real Bun in check-dep-ages-install-age-bun.test.ts: the ** row, both ? rows, the ./ row
  // and both rows that put a negation before or after a positive pattern. The other rows are expectations only.
  it.each([
    ["a ** pattern reaches a nested directory", ["packages/**"], "packages/a/b", true],
    ["a negation removes a * match", ["packages/*", "!packages/x"], "packages/x", false],
    ["a negation leaves other * matches", ["packages/*", "!packages/x"], "packages/y", true],
    ["a negation before its positive pattern loses", ["!packages/x", "packages/*"], "packages/x", true],
    ["a positive pattern after a negation wins", ["packages/*", "!packages/x", "packages/x"], "packages/x", true],
    ["a ? pattern matches one character", ["packages/?"], "packages/a", true],
    ["a ? pattern does not match two characters", ["packages/?"], "packages/ab", false],
    ["a ./ prefix and trailing slash", ["./packages/*/"], "packages/a", true],
    ["a * pattern does not reach a nested directory", ["packages/*"], "packages/a/b", false],
  ])("%s", (_label, workspaces, dir, expectApplied) => {
    appliedFixture((root) => {
      writeManifest(root, "package.json", { name: "fixture", workspaces });
      writeManifest(root, join(dir, "package.json"), { name: "w", dependencies: { "dep-a": "1.0.0" } });
      const output = runGate(root);
      if (expectApplied) {
        expect(output).toContain("bun.lock is not parseable");
      } else {
        expect(output).toContain(
          `${dir}/package.json: \`dep-a\` is declared exactly here, but this manifest is neither the root package.json nor a workspace`,
        );
        expect(output).not.toContain("Checking");
      }
    });
  });

  it("refuses an excluded name pinned exactly only in a dot-directory under a * workspace pattern", () => {
    appliedFixture((root) => {
      writeManifest(root, "package.json", { name: "fixture", workspaces: ["packages/*"] });
      writeManifest(root, join("packages", "a", "package.json"), { name: "a" });
      writeManifest(root, join("packages", ".hidden", "package.json"), {
        name: "hidden", dependencies: { "dep-a": "1.0.0" },
      });
      const output = runGate(root);
      expect(output).toContain(
        "packages/.hidden/package.json: `dep-a` is declared exactly here, but this manifest is neither the root package.json nor a workspace",
      );
      expect(output).not.toContain("Checking");
    });
  });

  it("fails with its path when a workspace manifest cannot be read or parsed", () => {
    for (const [label, content, message] of [
      ["unreadable", "", "cannot inspect"],
      ["unparseable", "{ not json", "cannot parse"],
    ]) {
      appliedFixture((root) => {
        writeManifest(root, "package.json", { name: "fixture", workspaces: ["packages/*"] });
        const manifest = join("packages", "w", "package.json");
        mkdirSync(join(root, "packages", "w"), { recursive: true });
        if (label === "unreadable") symlinkSync("missing.json", join(root, manifest));
        else writeFileSync(join(root, manifest), content);
        const output = runGate(root);
        expect(output).toContain(`${message} ${manifest}`);
        expect(output).not.toContain("Checking");
      });
    }
  });
});

/** A real on-disk layout: a root manifest, an optional workspace and an unused manifest. */
function appliedFixture(write: (root: string) => void) {
  const scratch = mkdtempSync(join(tmpdir(), "age-applied-"));
  const root = join(scratch, "repo");
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "bunfig.toml"), '[install]\nminimumReleaseAge = 604800\nminimumReleaseAgeExcludes = ["dep-a"]\n');
    writeFileSync(
      join(root, "docs", "dep-age-exceptions.md"),
      "## Exceptions\n- dep-a@1.0.0 | expires:9999-12-31 | reason: fixture\n",
    );
    writeFileSync(join(root, "bun.lock"), "invalid lock");
    write(root);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function writeManifest(root: string, path: string, json: unknown) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(json));
}

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
