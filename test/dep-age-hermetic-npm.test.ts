/**
 * test/dep-age-hermetic-npm.test.ts — the release-age gate's npm lockfile model
 * against a real npm installer on a loopback registry (cli#818).
 *
 * Every case generates its fixture packages with `npm pack`, serves them from
 * test/helpers/local-registry.ts, writes the lock with real npm against that
 * registry, runs `npm ci` on the lock (recording the metadata and tarball
 * requests it makes), and runs scripts/check-dep-ages.mjs on the same lock
 * through TPS_DEP_AGES_ROOT and TPS_DEP_AGES_REGISTRY.
 *
 * The registry advertises canonical public-registry tarball URLs, so the
 * lockfile is the shape a repository carries and `npm ci` fetches the bytes
 * from the loopback server by replacing the registry host. A request outside
 * the served set fails the case by default; the two identity-disagreement cases
 * assert the exact unserved request instead.
 *
 * The Docker Integration image ships no npm, so the file skips there; the Unit &
 * Integration lane sets TPS_TEST_REQUIRE_NPM=1 and fails if npm is missing.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalRegistry, type LocalRegistry, type RegistryPackage } from "./helpers/local-registry";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const GATE = join(REPO, "scripts", "check-dep-ages.mjs");
const NODE = Bun.which("node");

/** A publish time well past the gate's 7-day threshold. */
const OLD = "2026-01-01T00:00:00.000Z";

const npmAvailable = (() => {
  if (Bun.which("npm") === null) return false;
  const probe = Bun.spawnSync(["npm", "--version"], { stdout: "pipe", stderr: "pipe" });
  return probe.exitCode === 0;
})();

if (!npmAvailable) {
  console.log(
    "dep-age hermetic npm lane: skipped — npm is not on PATH (the Docker Integration image ships no npm)",
  );
}
if (npmAvailable && process.env.TPS_TEST_REQUIRE_NPM === "1" && Bun.which("tar") === null) {
  throw new Error("the Unit & Integration lane requires tar on PATH to unpack the bundle fixtures");
}

/** The npm and Arborist actually used, from npm's own install. */
function npmToolchain(): { npm: string; arborist: string } {
  const npmBin = Bun.which("npm");
  if (npmBin === null) throw new Error("test setup requires npm on PATH");
  const version = Bun.spawnSync(["npm", "--version"], { stdout: "pipe", stderr: "pipe" });
  if (version.exitCode !== 0) {
    throw new Error(`npm --version exited ${version.exitCode}: ${version.stderr.toString().trim()}`);
  }
  const npmDir = dirname(dirname(realpathSync(npmBin)));
  const arboristPath = join(npmDir, "node_modules", "@npmcli", "arborist", "package.json");
  let arborist: string;
  try {
    arborist = JSON.parse(readFileSync(arboristPath, "utf8")).version;
  } catch (err) {
    throw new Error(
      `test setup cannot read npm's bundled Arborist at ${arboristPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { npm: version.stdout.toString().trim(), arborist };
}

const TOOLCHAIN = npmAvailable ? npmToolchain() : null;
if (TOOLCHAIN !== null) {
  console.log(`dep-age hermetic npm lane: npm ${TOOLCHAIN.npm}, @npmcli/arborist ${TOOLCHAIN.arborist}`);
}

const SCRATCH = npmAvailable ? mkdtempSync(join(tmpdir(), "dep-age-hermetic-")) : "";
const liveRegistries: LocalRegistry[] = [];

afterAll(() => {
  for (const registry of liveRegistries.splice(0)) registry.stop();
  if (SCRATCH !== "") rmSync(SCRATCH, { recursive: true, force: true });
});

type Packed = { name: string; version: string; tarball: Uint8Array };
type PackSpec = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  bundleDependencies?: string[];
  /** Generated tarballs to unpack into the source tree before packing, as [file, destination under the source]. */
  bundled?: [string, string][];
};

/** A throwaway root per case, removed whatever the case did. */
async function withLane(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(SCRATCH, "case-"));
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function prepare(root: string): void {
  for (const dir of ["home", "npm-cache", "install-cache", "bundle-cache", "prefix", "tarballs"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  // Empty configs: npm's own config must not reach the loopback install.
  writeFileSync(join(root, "npmrc-user"), "");
  writeFileSync(join(root, "npmrc-global"), "");
}

function npmEnv(root: string, cache: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    npm_config_cache: join(root, cache),
    npm_config_userconfig: join(root, "npmrc-user"),
    npm_config_globalconfig: join(root, "npmrc-global"),
    npm_config_prefix: join(root, "prefix"),
    npm_config_update_notifier: "false",
  };
}

async function runNpm(args: string[], cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn(["npm", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

async function npmStep(args: string[], cwd: string, env: Record<string, string>, what: string) {
  const result = await runNpm(args, cwd, env);
  if (result.status !== 0) {
    throw new Error(`${what} exited ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

/** Pack a fixture package with real npm; returns the generated tarball's bytes. */
function pack(root: string, spec: PackSpec): Packed {
  const tarballs = join(root, "tarballs");
  const source = join(root, "src", `${spec.name}-${spec.version}`);
  mkdirSync(source, { recursive: true });
  const manifest: Record<string, unknown> = { name: spec.name, version: spec.version };
  if (spec.dependencies !== undefined) manifest.dependencies = spec.dependencies;
  if (spec.bundleDependencies !== undefined) manifest.bundleDependencies = spec.bundleDependencies;
  writeFileSync(join(source, "package.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(source, "index.js"), `module.exports = ${JSON.stringify(spec.name)};\n`);
  for (const [file, at] of spec.bundled ?? []) {
    const destination = join(source, at);
    mkdirSync(destination, { recursive: true });
    const unpacked = Bun.spawnSync(
      ["tar", "xzf", join(tarballs, file), "-C", destination, "--strip-components=1"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (unpacked.exitCode !== 0) {
      throw new Error(`cannot unpack ${file}: ${unpacked.stderr.toString().trim()}`);
    }
  }
  const packed = Bun.spawnSync(["npm", "pack", "--pack-destination", tarballs, "--silent"], {
    cwd: source,
    env: npmEnv(root, "npm-cache"),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (packed.exitCode !== 0) {
    throw new Error(`npm pack ${spec.name} exited ${packed.exitCode}: ${packed.stderr.toString().trim()}`);
  }
  const file = `${spec.name}-${spec.version}.tgz`;
  return { name: spec.name, version: spec.version, tarball: readFileSync(join(tarballs, file)) };
}

function startRegistry(packages: RegistryPackage[]): LocalRegistry {
  const registry = startLocalRegistry(packages);
  liveRegistries.push(registry);
  return registry;
}

function stopRegistry(registry: LocalRegistry): void {
  registry.stop();
  const index = liveRegistries.indexOf(registry);
  if (index >= 0) liveRegistries.splice(index, 1);
}

type Project = { dir: string; lock: { packages?: Record<string, Record<string, unknown>> } };

type ProjectSpec = {
  dependencies: Record<string, string>;
  bundleDependencies?: string[];
  /** A full `npm install` (needed for bundles to land on disk), not just the lock. */
  full?: boolean;
  cache?: string;
};

/** Write the consumer project's lock with real npm against the loopback registry. */
async function lockProject(
  root: string,
  registry: LocalRegistry,
  spec: ProjectSpec,
): Promise<Project> {
  const dir = join(root, "project");
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    name: "consumer",
    version: "1.0.0",
    dependencies: spec.dependencies,
  };
  if (spec.bundleDependencies !== undefined) manifest.bundleDependencies = spec.bundleDependencies;
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  const env = npmEnv(root, spec.cache ?? "npm-cache");
  const args = ["--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry.url}`];
  if (spec.full === true) {
    await npmStep(["install", ...args], dir, env, "npm install");
  } else {
    await npmStep(["install", "--package-lock-only", ...args], dir, env, "npm install --package-lock-only");
  }
  const read = (): Project => ({
    dir,
    lock: JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")),
  });
  return read();
}

/** Re-write the lock from the tree on disk, which is where npm records bundled entries. */
async function relockProject(root: string, registry: LocalRegistry, project: Project, cache: string): Promise<Project> {
  // Without a lock to read, npm writes it from the installed tree and records the
  // bundled children it finds there.
  rmSync(join(project.dir, "package-lock.json"), { force: true });
  await npmStep(
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry.url}`],
    project.dir,
    npmEnv(root, cache),
    "npm install --package-lock-only (second pass)",
  );
  return {
    dir: project.dir,
    lock: JSON.parse(readFileSync(join(project.dir, "package-lock.json"), "utf8")),
  };
}

type InstallResult = { status: number; stdout: string; stderr: string; requests: string[] };

/** Run the real installer on the lock, from a cache it has never used. */
async function installProject(
  root: string,
  registry: LocalRegistry,
  project: Project,
  cache = "install-cache",
): Promise<InstallResult> {
  rmSync(join(project.dir, "node_modules"), { recursive: true, force: true });
  registry.requests.length = 0;
  const result = await runNpm(
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry.url}`],
    project.dir,
    npmEnv(root, cache),
  );
  return { ...result, requests: [...registry.requests] };
}

type GateResult = { status: number; stdout: string; stderr: string; output: string };

/** Point the gate at the same lock through its fixture seam and run it. */
async function gateOn(root: string, registry: LocalRegistry, project: Project): Promise<GateResult> {
  if (NODE === null) throw new Error("test setup requires node on PATH");
  const gateRoot = join(root, "gate");
  mkdirSync(join(gateRoot, "docs"), { recursive: true });
  writeFileSync(join(gateRoot, "bunfig.toml"), "[install]\nminimumReleaseAge = 604800\n");
  writeFileSync(join(gateRoot, "bun.lock"), '{ "lockfileVersion": 1, "packages": {} }\n');
  writeFileSync(
    join(gateRoot, "docs", "dep-age-exceptions.md"),
    "# Dependency release-age exceptions\n\n## Exceptions\n",
  );
  writeFileSync(join(gateRoot, "package-lock.json"), JSON.stringify(project.lock, null, 2));
  const proc = Bun.spawn([NODE, GATE], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TPS_DEP_AGES_ROOT: gateRoot,
      TPS_DEP_AGES_REGISTRY: registry.url,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr, output: `${stdout}${stderr}` };
}

/** Every `resolved` URL the lock records. */
function resolvedUrls(project: Project): string[] {
  return Object.values(project.lock.packages ?? {})
    .map((entry) => entry?.resolved)
    .filter((resolved): resolved is string => typeof resolved === "string");
}

function expectCanonicalResolvedOnly(project: Project): void {
  for (const url of resolvedUrls(project)) {
    expect(url.startsWith("https://registry.npmjs.org/")).toBe(true);
  }
}

function entry(project: Project, path: string): Record<string, unknown> {
  const value = project.lock.packages?.[path];
  if (value === undefined) throw new Error(`no ${path} entry; lock has ${Object.keys(project.lock.packages ?? {}).join(", ")}`);
  return value;
}

describe("the release-age gate and a real npm installer on the same lock", () => {
  it.each([
    {
      label: "name",
      advertised: "https://registry.npmjs.org/other-dep/-/other-dep-1.0.0.tgz",
      requested: "/other-dep/-/other-dep-1.0.0.tgz",
      message: "resolved URL identifies other-dep, but the entry records dep-b",
    },
    {
      label: "version",
      advertised: "https://registry.npmjs.org/dep-b/-/dep-b-2.0.0.tgz",
      requested: "/dep-b/-/dep-b-2.0.0.tgz",
      message: "resolved URL identifies dep-b@2.0.0, but the entry records version 1.0.0",
    },
  ])(
    "a canonical tarball URL whose $label disagrees with the recorded entry: the gate refuses it and the installer asks for that URL",
    async ({ advertised, requested, message }) => {
      await withLane(async (root) => {
        prepare(root);
        const depB = pack(root, { name: "dep-b", version: "1.0.0" });
        const registry = startRegistry([{ ...depB, time: { "1.0.0": OLD }, tarballUrl: advertised }]);
        try {
          const project = await lockProject(root, registry, { dependencies: { "dep-b": "^1.0.0" } });
          expect(entry(project, "node_modules/dep-b").resolved).toBe(advertised);

          const install = await installProject(root, registry, project);
          expect(install.status).not.toBe(0);
          expect(install.requests).toContain(`GET ${requested}`);
          expect(registry.unexpected).toEqual([`GET ${requested}`]);

          const gate = await gateOn(root, registry, project);
          expect(gate.status).toBe(2);
          expect(gate.output).toContain(message);
        } finally {
          stopRegistry(registry);
        }
      });
    },
  );

  it("an alias records the aliased package's identity, and both sides read that identity", async () => {
    await withLane(async (root) => {
      prepare(root);
      const depA = pack(root, { name: "dep-a", version: "1.0.0" });
      const registry = startRegistry([{ ...depA, time: { "1.0.0": OLD } }]);
      try {
        const project = await lockProject(root, registry, {
          dependencies: { "dep-alias": "npm:dep-a@^1.0.0" },
        });
        expect(entry(project, "node_modules/dep-alias")).toMatchObject({
          name: "dep-a",
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/dep-a/-/dep-a-1.0.0.tgz",
        });
        expectCanonicalResolvedOnly(project);

        const install = await installProject(root, registry, project);
        expect(install.status).toBe(0);
        expect(install.requests).toEqual(["GET /dep-a/-/dep-a-1.0.0.tgz"]);
        registry.assertNoUnexpected();
        const installed = JSON.parse(readFileSync(join(project.dir, "node_modules", "dep-alias", "package.json"), "utf8"));
        expect(installed.name).toBe("dep-a");

        const gate = await gateOn(root, registry, project);
        expect(gate.status).toBe(0);
        expect(gate.stdout).toContain("All 1 external resolved versions are at least 7 days old.");
      } finally {
        stopRegistry(registry);
      }
    });
  });

  it("an entry without `resolved` is aged by its recorded name and version, and the installer resolves it from metadata", async () => {
    await withLane(async (root) => {
      prepare(root);
      const depB = pack(root, { name: "dep-b", version: "1.0.0" });
      const registry = startRegistry([{ ...depB, time: { "1.0.0": OLD } }]);
      try {
        // A packument that advertises no tarball is how npm writes an entry without `resolved`.
        registry.setTarballAdvertised("dep-b", false);
        const project = await lockProject(root, registry, { dependencies: { "dep-b": "^1.0.0" } });
        expect(entry(project, "node_modules/dep-b")).toMatchObject({ version: "1.0.0" });
        expect(entry(project, "node_modules/dep-b").resolved).toBeUndefined();

        registry.setTarballAdvertised("dep-b", true);
        const install = await installProject(root, registry, project);
        expect(install.status).toBe(0);
        expect(install.requests).toEqual(["GET /dep-b", "GET /dep-b/-/dep-b-1.0.0.tgz"]);
        registry.assertNoUnexpected();

        const gate = await gateOn(root, registry, project);
        expect(gate.status).toBe(0);
        expect(gate.stdout).toContain("All 1 external resolved versions are at least 7 days old.");
      } finally {
        stopRegistry(registry);
      }
    });
  });

  it("an `inBundle` entry is aged by its recorded version, and the installer takes the bundle from the parent's tarball", async () => {
    await withLane(async (root) => {
      prepare(root);
      const bundledDep = pack(root, { name: "bundled-dep", version: "1.0.0" });
      const pkgParent = pack(root, {
        name: "pkg-parent",
        version: "1.0.0",
        dependencies: { "bundled-dep": "^1.0.0" },
        bundleDependencies: ["bundled-dep"],
        bundled: [["bundled-dep-1.0.0.tgz", "node_modules/bundled-dep"]],
      });
      const registry = startRegistry([
        { ...pkgParent, time: { "1.0.0": OLD } },
        { ...bundledDep, time: { "1.0.0": OLD } },
      ]);
      try {
        const project = await lockProject(root, registry, {
          dependencies: { "pkg-parent": "^1.0.0" },
          bundleDependencies: ["pkg-parent"],
        });
        expect(entry(project, "node_modules/pkg-parent")).toMatchObject({
          version: "1.0.0",
          inBundle: true,
          resolved: "https://registry.npmjs.org/pkg-parent/-/pkg-parent-1.0.0.tgz",
        });

        const install = await installProject(root, registry, project);
        expect({ status: install.status, stderr: install.stderr }).toMatchObject({ status: 0 });
        expect(install.requests).toEqual(["GET /pkg-parent/-/pkg-parent-1.0.0.tgz"]);
        registry.assertNoUnexpected();
        const installed = JSON.parse(
          readFileSync(join(project.dir, "node_modules", "pkg-parent", "node_modules", "bundled-dep", "package.json"), "utf8"),
        );
        expect(installed.name).toBe("bundled-dep");

        const gate = await gateOn(root, registry, project);
        expect(gate.status).toBe(0);
        expect(gate.stdout).toContain("All 1 external resolved versions are at least 7 days old.");
      } finally {
        stopRegistry(registry);
      }
    });
  });

  it("a nested entry under an `inBundle` parent is aged on its own, and the installer resolves each entry", async () => {
    await withLane(async (root) => {
      prepare(root);
      const bundledDep = pack(root, { name: "bundled-dep", version: "1.0.0" });
      const pkgParent = pack(root, {
        name: "pkg-parent",
        version: "1.0.0",
        dependencies: { "bundled-dep": "^1.0.0" },
        bundleDependencies: ["bundled-dep"],
        bundled: [["bundled-dep-1.0.0.tgz", "node_modules/bundled-dep"]],
      });
      const registry = startRegistry([
        { ...pkgParent, time: { "1.0.0": OLD } },
        { ...bundledDep, time: { "1.0.0": OLD } },
      ]);
      try {
        const first = await lockProject(root, registry, {
          dependencies: { "pkg-parent": "^1.0.0" },
          bundleDependencies: ["pkg-parent"],
          full: true,
          cache: "bundle-cache",
        });
        const project = await relockProject(root, registry, first, "bundle-cache");
        expect(entry(project, "node_modules/pkg-parent").inBundle).toBe(true);
        expect(entry(project, "node_modules/pkg-parent/node_modules/bundled-dep")).toMatchObject({
          version: "1.0.0",
          inBundle: true,
        });
        expect(
          entry(project, "node_modules/pkg-parent/node_modules/bundled-dep").resolved,
        ).toBeUndefined();

        const install = await installProject(root, registry, project);
        expect({ status: install.status, stderr: install.stderr }).toMatchObject({ status: 0 });
        expect(install.requests).toEqual([
          "GET /pkg-parent",
          "GET /pkg-parent/-/pkg-parent-1.0.0.tgz",
          "GET /bundled-dep",
          "GET /bundled-dep/-/bundled-dep-1.0.0.tgz",
        ]);
        registry.assertNoUnexpected();
        const installed = JSON.parse(
          readFileSync(
            join(project.dir, "node_modules", "pkg-parent", "node_modules", "bundled-dep", "package.json"),
            "utf8",
          ),
        );
        expect(installed.name).toBe("bundled-dep");

        const gate = await gateOn(root, registry, project);
        expect(gate.status).toBe(0);
        expect(gate.stdout).toContain("All 2 external resolved versions are at least 7 days old.");
      } finally {
        stopRegistry(registry);
      }
    });
  });

  it("a young package with no `resolved` is refused with exit 1 while the installer still installs it", async () => {
    await withLane(async (root) => {
      prepare(root);
      const young = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const depYoung = pack(root, { name: "dep-young", version: "1.0.0" });
      const registry = startRegistry([{ ...depYoung, time: { "1.0.0": young } }]);
      try {
        registry.setTarballAdvertised("dep-young", false);
        const project = await lockProject(root, registry, { dependencies: { "dep-young": "^1.0.0" } });
        expect(entry(project, "node_modules/dep-young")).toMatchObject({ version: "1.0.0" });
        expect(entry(project, "node_modules/dep-young").resolved).toBeUndefined();

        registry.setTarballAdvertised("dep-young", true);
        const install = await installProject(root, registry, project);
        expect(install.status).toBe(0);
        expect(install.requests).toEqual(["GET /dep-young", "GET /dep-young/-/dep-young-1.0.0.tgz"]);
        registry.assertNoUnexpected();

        const gate = await gateOn(root, registry, project);
        expect(gate.status).toBe(1);
        expect(gate.stderr).toContain("External packages younger than the 7-day release-age gate:");
        expect(gate.stderr).toContain("package-lock.json: dep-young@1.0.0");
      } finally {
        stopRegistry(registry);
      }
    });
  });

  it("a versionless entry is refused with exit 2, and the installer rejects the lock after one metadata request", async () => {
    await withLane(async (root) => {
      prepare(root);
      const depVersionless = pack(root, { name: "dep-versionless", version: "1.0.0" });
      const registry = startRegistry([{ ...depVersionless, time: { "1.0.0": OLD } }]);
      try {
        const project = await lockProject(root, registry, { dependencies: { "dep-versionless": "^1.0.0" } });
        // npm always records a version; delete both fields to exercise the gate's refusal.
        const locked = project.lock.packages?.["node_modules/dep-versionless"];
        if (locked === undefined) throw new Error("no dep-versionless entry in the lock");
        delete locked.version;
        delete locked.resolved;
        delete locked.integrity;
        writeFileSync(join(project.dir, "package-lock.json"), JSON.stringify(project.lock, null, 2));

        const install = await installProject(root, registry, project);
        expect(install.status).not.toBe(0);
        expect(install.stderr).toContain("Invalid: lock file's dep-versionless@ does not satisfy dep-versionless@1.0.0");
        registry.assertNoUnexpected();
        expect(install.requests).toEqual(["GET /dep-versionless"]);

        const gate = await gateOn(root, registry, project);
        expect(gate.status).toBe(2);
        expect(gate.output).toContain(
          "package-lock.json: entry node_modules/dep-versionless: entry with no `resolved` URL has no version",
        );
      } finally {
        stopRegistry(registry);
      }
    });
  });

  it("a missing publish time is refused with exit 2 while the installer still installs the tarball", async () => {
    await withLane(async (root) => {
      prepare(root);
      const depSilent = pack(root, { name: "dep-silent", version: "1.0.0" });
      const registry = startRegistry([{ ...depSilent, time: { "0.9.0": OLD } }]);
      try {
        const project = await lockProject(root, registry, { dependencies: { "dep-silent": "^1.0.0" } });
        expect(entry(project, "node_modules/dep-silent").resolved).toBe(
          "https://registry.npmjs.org/dep-silent/-/dep-silent-1.0.0.tgz",
        );
        expectCanonicalResolvedOnly(project);

        const install = await installProject(root, registry, project);
        expect(install.status).toBe(0);
        expect(install.requests).toEqual(["GET /dep-silent/-/dep-silent-1.0.0.tgz"]);
        registry.assertNoUnexpected();

        const gate = await gateOn(root, registry, project);
        expect(gate.status).toBe(2);
        expect(gate.stderr).toContain("dep-silent@1.0.0: no publish time in the registry response");
      } finally {
        stopRegistry(registry);
      }
    });
  });
});
