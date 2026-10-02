/**
 * cli#424 — pin Renovate's `@tpsdev-ai/**` exclusion to the invariant it needs.
 *
 * `.github/renovate.json` turns Renovate off for every `@tpsdev-ai/*`
 * dependency. That is safe only while each such dependency name in this repo is
 * one of cli's current six release packages. This test fails on any other name,
 * regardless of its specifier, naming the file and the dependency.
 *
 * The six names are read from `.github/workflows/release.yml`'s `PKGS` array,
 * not restated here. A workflow that cannot supply the list throws rather than
 * reading as an empty set.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RELEASE_WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");

/** The dependency maps a package.json may name dependencies in. */
const DEP_KINDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/** `@tpsdev-ai/<name>` for each package in the release workflow's `PKGS` array. */
function releasePackages(): string[] {
  const workflow = Bun.YAML.parse(readFileSync(RELEASE_WORKFLOW, "utf8")) as {
    jobs?: Record<string, { steps?: Array<{ run?: unknown }> }>;
  };
  const runs = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string");
  const arrays = runs.flatMap((run) => [...run.matchAll(/\bPKGS=\(([^)]*)\)/g)].map((match) => match[1]));
  if (arrays.length !== 1) {
    throw new Error(`${RELEASE_WORKFLOW}: expected exactly one PKGS=(...) array, found ${arrays.length}`);
  }
  const names = arrays[0]
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => `@tpsdev-ai/${name}`);
  if (names.length === 0) throw new Error(`${RELEASE_WORKFLOW}: PKGS=(...) is empty`);
  return names;
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
  it("every @tpsdev-ai/* dependency names one of the six release packages", () => {
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
