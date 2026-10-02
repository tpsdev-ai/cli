/**
 * cli#424 — pin Renovate's `@tpsdev-ai/**` exclusion to the invariant it needs.
 *
 * `.github/renovate.json` turns Renovate off for every `@tpsdev-ai/*`
 * dependency. That is safe only while each such dependency in this repo is one
 * of cli's six release packages, or a `workspace:`/`file:` reference: a
 * separately versioned `@tpsdev-ai/*` dependency would silently stop receiving
 * updates and possibly its vulnerability PRs. This test fails when one is added,
 * naming the file and the dependency.
 *
 * The six names are read from `.github/workflows/release.yml`'s `PKGS` array,
 * not restated here. A workflow that cannot supply the list throws rather than
 * reading as an empty set.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

/** Every package.json under the repo root, node_modules excluded. */
function packageJsonPaths(dir: string = ROOT): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      paths.push(...packageJsonPaths(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name === "package.json") {
      paths.push(join(dir, entry.name));
    }
  }
  return paths;
}

describe("Renovate @tpsdev-ai scope (cli#424)", () => {
  it("every @tpsdev-ai/* dependency is one of the six release packages or a workspace/file reference", () => {
    const allowed = new Set(releasePackages());
    const files = packageJsonPaths();
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const kind of DEP_KINDS) {
        const deps = pkg[kind];
        if (deps === undefined) continue;
        if (typeof deps !== "object" || deps === null) {
          throw new Error(`${file}: ${kind} is not an object`);
        }
        for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
          if (!name.startsWith("@tpsdev-ai/")) continue;
          // A `workspace:`/`file:` specifier is a local link, not a registry version.
          if (typeof spec === "string" && (spec.startsWith("workspace:") || spec.startsWith("file:"))) continue;
          if (allowed.has(name)) continue;
          violations.push(`${file.slice(ROOT.length + 1)}: ${kind}["${name}"] = ${JSON.stringify(spec)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
