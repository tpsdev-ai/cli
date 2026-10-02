/** Checks regular, non-symlinked package.json files outside node_modules and .git for nonrelease @tpsdev-ai/* dependencies. */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RELEASE_WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");

/** The dependency maps a package.json may name dependencies in. */
const DEP_KINDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

function releasePackages(source = readFileSync(RELEASE_WORKFLOW, "utf8")): string[] {
  const workflow = Bun.YAML.parse(source) as {
    defaults?: unknown;
    jobs?: Record<string, {
      "runs-on"?: unknown;
      if?: unknown;
      defaults?: unknown;
      steps?: Array<{ name?: string; if?: unknown; shell?: unknown; run?: unknown }>;
    }>;
  };
  const job = workflow.jobs?.["publish-packages"];
  const steps = job?.steps?.filter((step) => step.name === "Verify ALL workspace versions match the tag") ?? [];
  const step = steps[0];
  if (job?.["runs-on"] !== "ubuntu-latest" ||
      workflow.defaults !== undefined || job.defaults !== undefined || job.if !== undefined ||
      steps.length !== 1 || step.if !== undefined || step.shell !== undefined || typeof step.run !== "string") {
    throw new Error(`${RELEASE_WORKFLOW}: expected an unconditional version-verification step on ubuntu-latest with the default shell`);
  }
  const lines = step.run.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const assignment = lines[2]?.match(/^PKGS=\(([a-z0-9-]+(?:[ \t]+[a-z0-9-]+)*)\)$/);
  if (lines[0] !== "set -euo pipefail" || lines[1] !== 'VERSION="${GITHUB_REF_NAME#v}"' || !assignment) {
    throw new Error(`${RELEASE_WORKFLOW}: expected executable literal PKGS=(...) after set -euo pipefail and VERSION`);
  }
  return assignment[1].split(/[ \t]+/).map((name) => `@tpsdev-ai/${name}`);
}

/** Regular package.json files below root; node_modules, .git, and symlinks are skipped. */
function packageJsonPaths(
  root: string = ROOT,
  onSkippedSymlink: (path: string) => void = (path) => console.warn(`${relative(root, path)}: skipped symlink`),
): string[] {
  const paths: string[] = [];
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isSymbolicLink()) {
        onSkippedSymlink(path);
        continue;
      }
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name === "package.json") {
        paths.push(path);
      }
    }
  }
  visit(root);
  return paths;
}

function dependencyViolations(
  file: string,
  pkg: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  for (const kind of DEP_KINDS) {
    const deps = pkg[kind];
    if (deps === undefined) continue;
    if (typeof deps !== "object" || deps === null) {
      throw new Error(`${file}: ${kind} is not an object`);
    }
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (!name.startsWith("@tpsdev-ai/")) continue;
      if (allowed.has(name)) continue;
      violations.push(`${file}: ${kind}["${name}"] = ${JSON.stringify(spec)}`);
    }
  }
  return violations;
}

describe("Renovate @tpsdev-ai scope (cli#424)", () => {
  it("rejects a commented-out release PKGS assignment", () => {
    const source = readFileSync(RELEASE_WORKFLOW, "utf8");
    const commented = source.replace(/^(\s*)PKGS=/m, "$1# PKGS=");
    expect(commented).not.toBe(source);
    expect(() => releasePackages(commented)).toThrow();
  });

  for (const [label, replacement] of [
    ["missing", ""],
    ["echoed", "echo 'PKGS=(cli)'"],
    ["quoted", "TEXT='\nPKGS=(cli)\n'"],
    ["heredoc", "cat <<'EOF'\nPKGS=(cli)\nEOF"],
    ["conditional", "if false; then\nPKGS=(cli)\nfi"],
    ["short-circuited", "false && PKGS=(cli)"],
    ["uncalled function", "unused() {\nPKGS=(cli)\n}"],
    ["after exit", "exit 0\nPKGS=(cli)"],
    ["empty", "PKGS=()"],
  ]) {
    it(`rejects ${label} release PKGS assignments`, () => {
      const source = readFileSync(RELEASE_WORKFLOW, "utf8");
      const changed = source.replace(/^([ \t]*)PKGS=.*$/m, (_, indent) =>
        replacement.split("\n").map((line) => `${indent}${line}`).join("\n"));
      expect(changed).not.toBe(source);
      expect(() => releasePackages(changed)).toThrow();
    });
  }

  for (const [label, before, after] of [
    ["wrong job", "  publish-packages:", "  another-job:"],
    ["wrong step", "name: Verify ALL workspace versions match the tag", "name: Another step"],
    ["disabled job", "  publish-packages:", "  publish-packages:\n    if: false"],
    ["disabled step", "name: Verify ALL workspace versions match the tag", "name: Verify ALL workspace versions match the tag\n        if: false"],
    ["nondefault shell", "name: Verify ALL workspace versions match the tag", "name: Verify ALL workspace versions match the tag\n        shell: python"],
  ]) {
    it(`rejects PKGS in a ${label}`, () => {
      const source = readFileSync(RELEASE_WORKFLOW, "utf8");
      const changed = source.replace(before, after);
      expect(changed).not.toBe(source);
      expect(() => releasePackages(changed)).toThrow();
    });
  }

  it("rejects a Windows release runner", () => {
    const workflow = Bun.YAML.parse(readFileSync(RELEASE_WORKFLOW, "utf8"));
    workflow.jobs["publish-packages"]["runs-on"] = "windows-latest";
    expect(() => releasePackages(Bun.YAML.stringify(workflow))).toThrow();
  });

  it("checks regular, non-symlinked package.json files outside node_modules and .git for nonrelease @tpsdev-ai/* dependencies", () => {
    const allowed = new Set(releasePackages());
    const files = packageJsonPaths();
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      violations.push(...dependencyViolations(relative(ROOT, file), pkg, allowed));
    }

    expect(violations).toEqual([]);
  });

  for (const specifier of ["workspace:*", "file:../pi-tps-mail"]) {
    it(`rejects a nonrelease package with ${specifier}`, () => {
      const violations = dependencyViolations(
        "fixtures/package.json",
        { dependencies: { "@tpsdev-ai/pi-tps-mail": specifier } },
        new Set(releasePackages()),
      );
      expect(violations).toEqual([
        `fixtures/package.json: dependencies["@tpsdev-ai/pi-tps-mail"] = ${JSON.stringify(specifier)}`,
      ]);
    });
  }

  it("reports a symlinked package.json as skipped", () => {
    const root = mkdtempSync(join(tmpdir(), "renovate-tpsdev-deps-"));
    try {
      writeFileSync(join(root, "target.json"), "{}\n");
      symlinkSync("target.json", join(root, "package.json"));
      const skipped: string[] = [];
      expect(packageJsonPaths(root, (path) => skipped.push(relative(root, path)))).toEqual([]);
      expect(skipped).toEqual(["package.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
