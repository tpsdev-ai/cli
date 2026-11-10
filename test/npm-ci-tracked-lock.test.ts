import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCiLockDirs, parseWorkflow, scanQuotedValue } from "./helpers/npm-ci-workflow-guard";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = "test/fixtures/heartbeat-openclaw";
const HELPER = join(REPO, "scripts/npm-ci-tracked-lock.sh");
const NODE = Bun.which("node");
if (NODE === null) throw new Error("test setup requires node");

// The real-npm cases need npm. The Unit & Integration lane sets
// TPS_TEST_REQUIRE_NPM=1, so a missing npm fails there; the Docker Integration
// image has no npm and skips these cases by name.
const npmProbe = spawnSync("npm", ["--version"], { encoding: "utf8", timeout: 10_000 });
const npmAvailable = npmProbe.error === undefined && npmProbe.status === 0;
if (!npmAvailable && process.env.TPS_TEST_REQUIRE_NPM === "1") {
  throw new Error("the Unit & Integration lane requires npm on PATH");
}

type Recorded = {
  argv: string[];
  cwd: string;
  lock: string;
  manifest: string;
  registry: string | null;
  userconfigEmpty: boolean;
  globalconfigEmpty: boolean;
  noUpdateNotifier: boolean;
};

/** The install args without the flags the helper chooses (registry, empty configs). */
function installerArgs(record: Recorded): string[] {
  return record.argv.filter((arg) =>
    !arg.startsWith("--registry=")
    && !arg.startsWith("--userconfig=")
    && !arg.startsWith("--globalconfig=")
    && arg !== "--no-update-notifier");
}

function expectInstallFlags(record: Recorded, registry = "https://registry.npmjs.org") {
  expect(record.registry).toBe(registry);
  expect(record.userconfigEmpty).toBe(true);
  expect(record.globalconfigEmpty).toBe(true);
  expect(record.noUpdateNotifier).toBe(true);
}

function harness(action: (h: ReturnType<typeof makeHarness>) => void, sfw = true) {
  const root = mkdtempSync(join(tmpdir(), "tracked-lock-"));
  try {
    action(makeHarness(root, sfw));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeHarness(root: string, sfw: boolean) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["git", "cp", "mkdir", "cmp", "node", "bash", "mktemp", "rm", "rmdir"]) {
    const path = Bun.which(name);
    if (path === null) throw new Error(`test setup requires ${name}`);
    symlinkSync(path, join(bin, name));
  }
  const recorder = `#!${NODE}
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, basename } = require("node:path");
const argv = process.argv.slice(2);
if (basename(process.argv[1]) === "npm") writeFileSync(process.env.RECORD + ".npm-call", JSON.stringify({ argv, cwd: process.cwd() }));
const prefix = argv.includes("--prefix") ? argv[argv.indexOf("--prefix") + 1] : process.cwd();
const lockPath = join(prefix, "package-lock.json");
const flag = (name) => {
  const found = argv.find((arg) => arg.startsWith(name + "="));
  return found === undefined ? null : found.slice(name.length + 1);
};
const empty = (path) => path !== null && existsSync(path) && readFileSync(path, "utf8") === "";
const record = {
  argv, cwd: process.cwd(), lock: readFileSync(lockPath, "utf8"), manifest: readFileSync(join(prefix, "package.json"), "utf8"),
  registry: flag("--registry"),
  userconfigEmpty: empty(flag("--userconfig")),
  globalconfigEmpty: empty(flag("--globalconfig")),
  noUpdateNotifier: argv.includes("--no-update-notifier"),
};
`;
  writeFileSync(join(bin, "npm"), `${recorder}
writeFileSync(process.env.RECORD + ".npm", JSON.stringify(record));
if (process.env.REWRITE_LOCK === "1") writeFileSync(lockPath, "rewritten\\n");
process.exit(Number(process.env.NPM_EXIT ?? 0));
`, { mode: 0o755 });
  if (sfw) writeFileSync(join(bin, "sfw"), `${recorder}
writeFileSync(process.env.RECORD + ".sfw", JSON.stringify(record));
const result = require("node:child_process").spawnSync(argv[0], argv.slice(1), { env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const prefix = join(root, "prefix with spaces");
  const record = join(root, "record");
  const env = { HOME: process.env.HOME, PATH: bin, RECORD: record, RUNNER_TEMP: root, GITHUB_ENV: join(root, "github-env") };
  const run = (args: string[], extra: Record<string, string> = {}, cwd = REPO) => spawnSync("/bin/bash", args, {
    cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 10_000,
  });
  const installed = () => JSON.parse(readFileSync(`${record}.npm`, "utf8")) as Recorded;
  const firewalled = () => JSON.parse(readFileSync(`${record}.sfw`, "utf8")) as Recorded;
  const assertNoInstall = () => {
    expect(() => readFileSync(`${record}.npm-call`, "utf8")).toThrow(/ENOENT/);
  };
  return { root, prefix, run, installed, firewalled, assertNoInstall };
}

it("the helper copies the committed fixture and invokes npm ci through sfw with the requested prefix", () => {
  harness((h) => {
    const lock = readFileSync(join(REPO, FIXTURE, "package-lock.json"), "utf8");
    const manifest = readFileSync(join(REPO, FIXTURE, "package.json"), "utf8");
    const result = h.run([HELPER, "--via", "sfw", FIXTURE, h.prefix, "--ignore-scripts", "--no-audit", "--no-fund"]);
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("reading fixture files from HEAD");
    const args = ["ci", "--prefix", h.prefix, "--ignore-scripts", "--no-audit", "--no-fund"];
    const installed = h.installed();
    expect(installerArgs(installed)).toEqual(args);
    expectInstallFlags(installed);
    expect(installed.cwd).toBe(REPO.replace(/\/$/, ""));
    expect(installed.lock).toBe(lock);
    expect(installed.manifest).toBe(manifest);
    const firewalled = h.firewalled();
    expect(installerArgs(firewalled)).toEqual(["npm", ...args]);
    expectInstallFlags(firewalled);
    expect(firewalled.cwd).toBe(REPO.replace(/\/$/, ""));
    expect(firewalled.lock).toBe(lock);
    expect(firewalled.manifest).toBe(manifest);
    expect(readFileSync(join(h.prefix, "package-lock.json"), "utf8")).toBe(lock);
  });
}, 30_000);

it.each(["untracked", "missing"])("the helper refuses the %s lock before npm runs", (kind) => {
  harness((h) => {
    const fixture = kind === "missing" ? "test/fixtures/missing-lock" : join(h.root, "untracked");
    if (kind === "untracked") {
      mkdirSync(fixture);
      writeFileSync(join(fixture, "package.json"), "{}");
      writeFileSync(join(fixture, "package-lock.json"), "{}");
    }
    const result = h.run([HELPER, "--via", "sfw", fixture, h.prefix]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`cannot read committed file: ${fixture}/package-lock.json`);
    h.assertNoInstall();
  });
}, 30_000);

it("the helper passes committed bytes to a stub installer despite a modified working-tree lock and manifest", () => {
  harness((h) => {
    const repo = join(h.root, "repo");
    mkdirSync(join(repo, FIXTURE), { recursive: true });
    const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: REPO, encoding: "utf8", timeout: 10_000 });
    expect({ status: gitDir.status, stderr: gitDir.stderr }).toMatchObject({ status: 0 });
    symlinkSync(gitDir.stdout.trim(), join(repo, ".git"));
    const committed = (file: string) => {
      const result = spawnSync("git", ["show", `HEAD:${FIXTURE}/${file}`], { cwd: repo, encoding: "utf8", timeout: 10_000 });
      expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
      return result.stdout;
    };
    const lock = committed("package-lock.json");
    const manifest = committed("package.json");
    writeFileSync(join(repo, FIXTURE, "package-lock.json"), "working-tree lock\n");
    writeFileSync(join(repo, FIXTURE, "package.json"), "working-tree manifest\n");
    const result = h.run([HELPER, "--via", "sfw", FIXTURE, h.prefix], {}, repo);
    expect(h.installed().lock).toBe(lock);
    expect(h.installed().manifest).toBe(manifest);
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(readFileSync(join(h.prefix, "package-lock.json"), "utf8")).toBe(lock);
  });
}, 30_000);

function fixtureRepo(root: string) {
  const repo = join(root, "repo");
  mkdirSync(join(repo, FIXTURE), { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, env: process.env, encoding: "utf8", timeout: 10_000 });
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.name", "Fixture Author");
  git("config", "user.email", "fixture@example.test");
  const write = (version: string) => {
    writeFileSync(join(repo, FIXTURE, "package.json"), JSON.stringify({ name: "fixture", version }));
    writeFileSync(join(repo, FIXTURE, "package-lock.json"), JSON.stringify({
      name: "fixture", version, lockfileVersion: 3, packages: { "": { name: "fixture", version } },
    }));
  };
  write("1.0.0");
  git("add", ".");
  git("commit", "-qm", "fixture initial");
  return { repo, git, write };
}

function workingFixture(h: ReturnType<typeof makeHarness>) {
  const repo = join(h.root, "repo");
  mkdirSync(join(repo, FIXTURE), { recursive: true });
  const result = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: REPO, encoding: "utf8", timeout: 10_000 });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  symlinkSync(result.stdout.trim(), join(repo, ".git"));
  for (const file of ["package-lock.json", "package.json"]) {
    const committed = spawnSync("git", ["show", `HEAD:${FIXTURE}/${file}`], { cwd: REPO, encoding: "utf8", timeout: 10_000 });
    expect({ status: committed.status, stderr: committed.stderr }).toMatchObject({ status: 0 });
    writeFileSync(join(repo, FIXTURE, file), committed.stdout);
  }
  mkdirSync(join(repo, "scripts/lib"), { recursive: true });
  writeFileSync(join(repo, "scripts/npm-ci-tracked-lock.sh"), readFileSync(HELPER));
  writeFileSync(join(repo, "scripts/lib/npm-ci-revision.sh"), readFileSync(join(REPO, "scripts/lib/npm-ci-revision.sh")));
  return repo;
}

const DEP = "fixture-dep";
const DEP_TARBALL = `${DEP}-1.0.0.tgz`;
const DEP_PATH = `/${DEP}/-/${DEP_TARBALL}`;

/** A git repo whose tracked fixture has one installable lock entry. */
function depFixtureRepo(root: string, entry: Record<string, unknown>) {
  const repo = join(root, "repo");
  const dir = join(repo, FIXTURE);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, env: process.env, encoding: "utf8", timeout: 10_000 });
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.name", "Fixture Author");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "fixture", version: "1.0.0", dependencies: { [DEP]: "^1.0.0" },
  }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({
    name: "fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "fixture", version: "1.0.0", dependencies: { [DEP]: "^1.0.0" } },
      [`node_modules/${DEP}`]: entry,
    },
  }));
  git("add", ".");
  git("commit", "-qm", "fixture initial");
  return repo;
}

/** Pack a one-file package without touching the network; returns its bytes and integrity. */
function packedTarball(root: string): { bytes: Uint8Array; integrity: string } {
  const src = join(root, "pkg-src");
  const tar = join(root, "tar");
  const home = join(root, "pack-home");
  const cache = join(root, "pack-cache");
  for (const dir of [src, tar, home, cache]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: DEP, version: "1.0.0" }));
  const pack = spawnSync("npm", ["pack", "--pack-destination", tar, "--silent"], {
    cwd: src, env: { PATH: process.env.PATH ?? "", HOME: home, npm_config_cache: cache },
    encoding: "utf8", timeout: 60_000,
  });
  expect({ status: pack.status, stderr: pack.stderr }).toMatchObject({ status: 0 });
  const files = readdirSync(tar).filter((file) => file.endsWith(".tgz"));
  expect(files).toEqual([DEP_TARBALL]);
  const bytes = readFileSync(join(tar, files[0]));
  return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

/** A loopback registry that records every request and answers only the tarball. */
function startRegistry(bytes: Uint8Array) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === DEP_PATH) return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
      return new Response("unexpected request", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

/** A second loopback server that records every request; any request is a leak. */
function startEvil() {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response("unexpected proxy request", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

async function runHelper(args: string[], cwd: string, extra: Record<string, string>) {
  const env = { PATH: process.env.PATH ?? "", ...extra };
  const proc = Bun.spawn(["/bin/bash", HELPER, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

it.each(["npm-shrinkwrap.json", "package-lock.json", "package.json"])(
  "in-place install refuses a prior workflow step writing %s before the installer runs", (file) => {
    harness((h) => {
      const repo = workingFixture(h);
      const run = `echo '{}' > ${FIXTURE}/${file}`;
      const install = `bash scripts/npm-ci-tracked-lock.sh --via npm --in-place ${FIXTURE} --ignore-scripts`;
      const source = `jobs:\n  build:\n    steps:\n      - run: ${run}\n      - run: ${install}\n`;
      const steps = parseWorkflow(source).jobs.build.steps;
      if (file === "npm-shrinkwrap.json") {
        expect(() => npmCiLockDirs(steps[0].run!, "", "prior writer")).toThrow(/physical line 1/);
      } else {
        expect(npmCiLockDirs(steps[0].run!, "", "prior writer")).toEqual([]);
      }
      expect(npmCiLockDirs(steps[1].run!, "", "install")).toEqual([FIXTURE]);
      const prior = h.run(["-c", steps[0].run!], {}, repo);
      expect({ status: prior.status, stderr: prior.stderr }).toMatchObject({ status: 0 });
      const result = h.run(["-c", steps[1].run!], {}, repo);
      h.assertNoInstall();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(file === "npm-shrinkwrap.json"
        ? `npm-shrinkwrap.json refused: ${FIXTURE}/${file}`
        : `working file differs from HEAD: ${FIXTURE}/${file}`);
    });
  }, 30_000,
);

it.each(["npm", "sfw"])("in-place install uses the literal %s installer and preserves committed bytes", (via) => {
  harness((h) => {
    const repo = workingFixture(h);
    const lock = readFileSync(join(repo, FIXTURE, "package-lock.json"), "utf8");
    const manifest = readFileSync(join(repo, FIXTURE, "package.json"), "utf8");
    const result = h.run([HELPER, "--via", via, "--in-place", FIXTURE, "--ignore-scripts"], {}, repo);
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    const installed = h.installed();
    expect(installerArgs(installed)).toEqual(["ci", "--ignore-scripts"]);
    expectInstallFlags(installed);
    expect(installed.cwd).toBe(join(repo, FIXTURE));
    expect(installed.lock).toBe(lock);
    expect(installed.manifest).toBe(manifest);
    if (via === "sfw") {
      expect(installerArgs(h.firewalled())).toEqual(["npm", "ci", "--ignore-scripts"]);
      expectInstallFlags(h.firewalled());
    } else expect(() => h.firewalled()).toThrow(/ENOENT/);
    expect(readFileSync(join(repo, FIXTURE, "package-lock.json"), "utf8")).toBe(lock);
  }, via === "sfw");
}, 30_000);

it("in-place install refuses a dangling shrinkwrap symlink", () => {
  harness((h) => {
    const repo = workingFixture(h);
    symlinkSync("missing", join(repo, FIXTURE, "npm-shrinkwrap.json"));
    const result = h.run([HELPER, "--via", "npm", "--in-place", FIXTURE], {}, repo);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`npm-shrinkwrap.json refused: ${FIXTURE}/npm-shrinkwrap.json`);
    h.assertNoInstall();
  });
}, 30_000);

it("in-place install refuses a lock rewritten by the installer", () => {
  harness((h) => {
    const repo = workingFixture(h);
    const result = h.run([HELPER, "--via", "npm", "--in-place", FIXTURE], { REWRITE_LOCK: "1" }, repo);
    expect(installerArgs(h.installed())).toEqual(["ci"]);
    expect(result.status).not.toBe(0);
  });
}, 30_000);

it.each([{ args: [] }, { args: ["--via", "other"] }, { args: ["--via"] }])("the helper refuses missing or invalid installer arguments %j", ({ args }) => {
  harness((h) => {
    const result = h.run([HELPER, ...args, "--in-place", FIXTURE]);
    expect(result.status).not.toBe(0);
    h.assertNoInstall();
  });
}, 30_000);

it("the real workflow installs through four in-place npm calls and one sfw prefix call", () => {
  const workflow = parseWorkflow(readFileSync(join(REPO, ".github/workflows/test.yml"), "utf8"));
  const sites: { job: string; run: string }[] = [];
  for (const [job, value] of Object.entries(workflow.jobs)) {
    for (const step of value.steps) {
      if (step.run === undefined) continue;
      const dirs = npmCiLockDirs(step.run, step["working-directory"] ?? value.defaults?.run?.["working-directory"] ?? "", job);
      if (dirs.length) sites.push({ job, run: step.run });
    }
  }
  const mail = "bash scripts/npm-ci-tracked-lock.sh --via npm --in-place plugins/openclaw-tps-mail --ignore-scripts";
  const review = "bash scripts/npm-ci-tracked-lock.sh --via npm --in-place plugins/openclaw-github-review --ignore-scripts";
  expect(sites.filter((site) => site.job !== "heartbeat-real-openclaw").map((site) => site.run.trim()).sort()).toEqual([mail, mail, review, review].sort());
  expect(sites.filter((site) => site.job === "heartbeat-real-openclaw").map((site) => site.run)).toEqual([
    expect.stringContaining('bash scripts/npm-ci-tracked-lock.sh --via sfw test/fixtures/heartbeat-openclaw "$prefix" --ignore-scripts --no-audit --no-fund'),
  ]);
}, 5_000);

it("the helper reads GITHUB_SHA bytes when HEAD moved after checkout under Actions", () => {
  harness((h) => {
    const { repo, git, write } = fixtureRepo(h.root);
    const sha = git("rev-parse", "HEAD");
    const lock = readFileSync(join(repo, FIXTURE, "package-lock.json"), "utf8");
    const manifest = readFileSync(join(repo, FIXTURE, "package.json"), "utf8");
    write("2.0.0");
    git("add", ".");
    git("commit", "-qm", "fixture changed");
    expect(git("rev-parse", "HEAD")).not.toBe(sha);
    const result = h.run([HELPER, "--via", "sfw", FIXTURE, h.prefix], { GITHUB_ACTIONS: "true", GITHUB_SHA: sha }, repo);
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain(`reading fixture files from ${sha}`);
    expect(h.installed().lock).toBe(lock);
    expect(h.installed().manifest).toBe(manifest);
  });
}, 30_000);

it.each([undefined, "", "malformed", "a".repeat(39), "g".repeat(40)])(
  "the helper refuses Actions with invalid GITHUB_SHA %j before npm runs", (sha) => {
    harness((h) => {
      const extra: Record<string, string> = { GITHUB_ACTIONS: "true" };
      if (sha !== undefined) extra.GITHUB_SHA = sha;
      const result = h.run([HELPER, "--via", "sfw", FIXTURE, h.prefix], extra);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("GITHUB_SHA must be 40 hex characters under GitHub Actions");
      h.assertNoInstall();
    });
  }, 30_000,
);

it.each(["npm-shrinkwrap.json", "package-lock.json", ".occupied"])(
  "the helper refuses a non-empty prefix containing %s before npm runs", (file) => {
    harness((h) => {
      mkdirSync(h.prefix);
      writeFileSync(join(h.prefix, file), "{}");
      const result = h.run([HELPER, "--via", "sfw", FIXTURE, h.prefix]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`non-empty prefix refused: ${h.prefix}`);
      h.assertNoInstall();
    });
  }, 30_000,
);

it("the helper accepts an existing empty prefix", () => {
  harness((h) => {
    mkdirSync(h.prefix);
    const result = h.run([HELPER, "--via", "sfw", FIXTURE, h.prefix]);
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(h.installed().lock).toBe(readFileSync(join(REPO, FIXTURE, "package-lock.json"), "utf8"));
  });
}, 30_000);

it("the gate refuses a tracked nested npm-shrinkwrap.json before registry lookup", () => {
  harness((h) => {
    const { repo, git } = fixtureRepo(h.root);
    mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "scripts", "check-dep-ages.mjs"), readFileSync(join(REPO, "scripts", "check-dep-ages.mjs")));
    writeFileSync(join(repo, "scripts", "lib", "check-dep-ages-collect.mjs"), readFileSync(join(REPO, "scripts", "lib", "check-dep-ages-collect.mjs")));
    writeFileSync(join(repo, "bunfig.toml"), "[install]\nminimumReleaseAge = 604800\n");
    writeFileSync(join(repo, "bun.lock"), JSON.stringify({ packages: { pkg: ["pkg@1.0.0"] } }));
    writeFileSync(join(repo, "docs", "dep-age-exceptions.md"), "## Exceptions\n");
    const shrinkwrap = `${FIXTURE}/npm-shrinkwrap.json`;
    writeFileSync(join(repo, shrinkwrap), "{}");
    git("add", shrinkwrap);
    const result = spawnSync(NODE, [join(repo, "scripts", "check-dep-ages.mjs")], {
      cwd: repo, env: { PATH: process.env.PATH, TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1" },
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${shrinkwrap}: npm-shrinkwrap.json is not aged; install refused.`);
    expect(result.stdout).not.toContain("Checking");
  });
}, 30_000);

it("the helper refuses a lock rewritten by npm after the install", () => {
  harness((h) => {
    const result = h.run([HELPER, "--via", "sfw", FIXTURE, h.prefix], { REWRITE_LOCK: "1" });
    expect(h.installed().lock).toBe(readFileSync(join(REPO, FIXTURE, "package-lock.json"), "utf8"));
    expect(result.status).not.toBe(0);
  });
}, 30_000);

it("the helper refuses when sfw is absent without invoking bare npm", () => {
  harness((h) => {
    const result = h.run([HELPER, "--via", "sfw", FIXTURE, h.prefix]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sfw is required; install refused");
    h.assertNoInstall();
  }, false);
}, 30_000);

it("the helper propagates npm failure", () => {
  harness((h) => {
    const result = h.run([HELPER, "--via", "sfw", FIXTURE, h.prefix], { NPM_EXIT: "9" });
    expect(h.installed().lock).toBe(readFileSync(join(REPO, FIXTURE, "package-lock.json"), "utf8"));
    expect(result.status).toBe(9);
  });
}, 30_000);

it("the helper refuses a directory override before npm runs", () => {
  harness((h) => {
    const result = h.run([HELPER, "--via", "sfw", FIXTURE, h.prefix, "--prefix", "elsewhere"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("directory override refused: --prefix");
    h.assertNoInstall();
  });
}, 30_000);

it("the real workflow step passes the tracked fixture selected independently by the guard to a stub installer", () => {
  const workflow = parseWorkflow(readFileSync(join(REPO, ".github/workflows/test.yml"), "utf8"));
  const job = workflow.jobs["heartbeat-real-openclaw"];
  const step = job.steps.find((candidate) => candidate.name === "Install the pinned OpenClaw into a temp prefix");
  if (step?.run === undefined) throw new Error("workflow install step is missing");
  const run = step.run;
  const selected = npmCiLockDirs(run, "", "heartbeat install");
  expect(selected).toEqual([FIXTURE]);
  const lock = readFileSync(join(REPO, selected[0], "package-lock.json"), "utf8");
  harness((h) => {
    const result = h.run(["-c", run]);
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    const installed = h.installed();
    expect(installed.lock).toBe(lock);
    expect(installed.cwd).toBe(REPO.replace(/\/$/, ""));
    const pin = JSON.parse(readFileSync(join(REPO, FIXTURE, "package.json"), "utf8")).dependencies.openclaw;
    const prefix = join(h.root, `openclaw-${pin}`);
    expect(installerArgs(installed)).toEqual(["ci", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund"]);
    expectInstallFlags(installed);
    expect(installerArgs(h.firewalled())).toEqual(["npm", ...installerArgs(installed)]);
    expectInstallFlags(h.firewalled());
    expect(readFileSync(join(h.root, "github-env"), "utf8")).toBe(`OPENCLAW_BIN_DIR=${prefix}/node_modules/.bin\n`);
  });
}, 30_000);

it("the helper installs only from TPS_DEP_AGES_REGISTRY through empty npm configs", () => {
  harness((h) => {
    const registry = "http://127.0.0.1:9";
    const repo = depFixtureRepo(h.root, {
      version: "1.0.0",
      resolved: `${registry}${DEP_PATH}`,
      integrity: "sha512-deadbeef",
    });
    const result = h.run([HELPER, "--via", "npm", FIXTURE, h.prefix], { TPS_DEP_AGES_REGISTRY: registry }, repo);
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    const installed = h.installed();
    expect(installerArgs(installed)).toEqual(["ci", "--prefix", h.prefix]);
    expectInstallFlags(installed, registry);
  });
}, 30_000);

it.skipIf(!npmAvailable)("a clean fixture installs through the local registry the gate checked", async () => {
  const root = mkdtempSync(join(tmpdir(), "tracked-lock-registry-"));
  let registry: ReturnType<typeof startRegistry> | undefined;
  try {
    const tarball = packedTarball(root);
    registry = startRegistry(tarball.bytes);
    const repo = depFixtureRepo(root, {
      version: "1.0.0",
      resolved: `${registry.url}${DEP_PATH}`,
      integrity: tarball.integrity,
    });
    const home = join(root, "home");
    const cache = join(root, "npm-cache");
    const prefix = join(root, "prefix");
    for (const dir of [home, cache]) mkdirSync(dir, { recursive: true });
    const result = await runHelper([
      "--via", "npm", FIXTURE, prefix, "--ignore-scripts", "--no-audit", "--no-fund",
    ], repo, { HOME: home, TPS_DEP_AGES_REGISTRY: registry.url, npm_config_cache: cache });
    expect(result.status, result.stderr).toBe(0);
    const installed = JSON.parse(readFileSync(join(prefix, "node_modules", DEP, "package.json"), "utf8"));
    expect(installed.name).toBe(DEP);
    const expected = new Set([`GET ${DEP_PATH}`, `GET /${DEP}`]);
    for (const request of registry.requests) expect(expected.has(request)).toBe(true);
    expect(registry.requests).toContain(`GET ${DEP_PATH}`);
  } finally {
    registry?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

const userConfigSources = ["$HOME/.npmrc", "npm_config_userconfig"] as const;

it.skipIf(!npmAvailable).each(userConfigSources)(
  "a user npmrc supplied via %s cannot route the install",
  async (source) => {
    const root = mkdtempSync(join(tmpdir(), "tracked-lock-userconfig-"));
    let registry: ReturnType<typeof startRegistry> | undefined;
    let evil: ReturnType<typeof startEvil> | undefined;
    try {
      const tarball = packedTarball(root);
      registry = startRegistry(tarball.bytes);
      evil = startEvil();
      const repo = depFixtureRepo(root, {
        version: "1.0.0",
        resolved: `${registry.url}${DEP_PATH}`,
        integrity: tarball.integrity,
      });
      const home = join(root, "home");
      const cache = join(root, "npm-cache");
      const prefix = join(root, "prefix");
      for (const dir of [home, cache]) mkdirSync(dir, { recursive: true });
      const contents = `proxy=${evil.url}/\nhttps-proxy=${evil.url}/\nregistry=${evil.url}/\n`;
      const extra: Record<string, string> = {
        HOME: home, TPS_DEP_AGES_REGISTRY: registry.url, npm_config_cache: cache,
      };
      if (source === "$HOME/.npmrc") {
        writeFileSync(join(home, ".npmrc"), contents);
      } else {
        const named = join(root, "named-userconfig");
        writeFileSync(named, contents);
        extra.npm_config_userconfig = named;
      }
      const result = await runHelper([
        "--via", "npm", FIXTURE, prefix, "--ignore-scripts", "--no-audit", "--no-fund",
      ], repo, extra);
      expect(result.status, result.stderr).toBe(0);
      const installed = JSON.parse(readFileSync(join(prefix, "node_modules", DEP, "package.json"), "utf8"));
      expect(installed.name).toBe(DEP);
      expect(registry.requests).toContain(`GET ${DEP_PATH}`);
      expect(evil.requests).toEqual([]);
    } finally {
      registry?.stop();
      evil?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

it.skipIf(!npmAvailable).each(["HTTPS_PROXY", "http_proxy"] as const)(
  "an environment %s is refused with zero registry requests",
  async (name) => {
    const root = mkdtempSync(join(tmpdir(), "tracked-lock-proxy-env-"));
    let registry: ReturnType<typeof startRegistry> | undefined;
    let evil: ReturnType<typeof startEvil> | undefined;
    try {
      const tarball = packedTarball(root);
      registry = startRegistry(tarball.bytes);
      evil = startEvil();
      const repo = depFixtureRepo(root, {
        version: "1.0.0",
        resolved: `${registry.url}${DEP_PATH}`,
        integrity: tarball.integrity,
      });
      const home = join(root, "home");
      const cache = join(root, "npm-cache");
      for (const dir of [home, cache]) mkdirSync(dir, { recursive: true });
      const result = await runHelper([
        "--via", "npm", FIXTURE, join(root, "prefix"), "--ignore-scripts", "--no-audit", "--no-fund",
      ], repo, {
        HOME: home, TPS_DEP_AGES_REGISTRY: registry.url, npm_config_cache: cache,
        [name]: evil.url,
      });
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toContain(JSON.stringify(name));
      expect(result.stderr).toContain("unset them for this install");
      expect(registry.requests).toEqual([]);
      expect(evil.requests).toEqual([]);
    } finally {
      registry?.stop();
      evil?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

it.skipIf(!npmAvailable)("NODE_EXTRA_CA_CERTS set in the environment is refused with zero registry requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "tracked-lock-extra-ca-"));
  let registry: ReturnType<typeof startRegistry> | undefined;
  try {
    const tarball = packedTarball(root);
    registry = startRegistry(tarball.bytes);
    const repo = depFixtureRepo(root, {
      version: "1.0.0",
      resolved: `${registry.url}${DEP_PATH}`,
      integrity: tarball.integrity,
    });
    const home = join(root, "home");
    const cache = join(root, "npm-cache");
    for (const dir of [home, cache]) mkdirSync(dir, { recursive: true });
    const result = await runHelper([
      "--via", "npm", FIXTURE, join(root, "prefix"), "--ignore-scripts", "--no-audit", "--no-fund",
    ], repo, {
      HOME: home, TPS_DEP_AGES_REGISTRY: registry.url, npm_config_cache: cache,
      NODE_EXTRA_CA_CERTS: join(root, "extra-ca.pem"),
    });
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain(JSON.stringify("NODE_EXTRA_CA_CERTS"));
    expect(result.stderr).toContain("unset them for this install");
    expect(registry.requests).toEqual([]);
  } finally {
    registry?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(!npmAvailable)("a lock entry under the registry without integrity is refused with zero registry requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "tracked-lock-integrity-"));
  let registry: ReturnType<typeof startRegistry> | undefined;
  try {
    const tarball = packedTarball(root);
    registry = startRegistry(tarball.bytes);
    const repo = depFixtureRepo(root, { version: "1.0.0", resolved: `${registry.url}${DEP_PATH}` });
    const result = await runHelper([
      "--via", "npm", FIXTURE, join(root, "prefix"), "--ignore-scripts", "--no-audit", "--no-fund",
    ], repo, { HOME: join(root, "home"), TPS_DEP_AGES_REGISTRY: registry.url });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`node_modules/${DEP}: no integrity`);
    expect(registry.requests).toEqual([]);
  } finally {
    registry?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(!npmAvailable)("an .npmrc in the tracked fixture directory is refused with zero registry requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "tracked-lock-npmrc-"));
  let registry: ReturnType<typeof startRegistry> | undefined;
  try {
    const tarball = packedTarball(root);
    registry = startRegistry(tarball.bytes);
    const repo = depFixtureRepo(root, {
      version: "1.0.0",
      resolved: `${registry.url}${DEP_PATH}`,
      integrity: tarball.integrity,
    });
    writeFileSync(join(repo, FIXTURE, ".npmrc"), "registry=http://127.0.0.1:1/\n");
    const result = await runHelper([
      "--via", "npm", FIXTURE, join(root, "prefix"), "--ignore-scripts", "--no-audit", "--no-fund",
    ], repo, { HOME: join(root, "home"), TPS_DEP_AGES_REGISTRY: registry.url });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`.npmrc refused: ${FIXTURE}/.npmrc`);
    expect(registry.requests).toEqual([]);
  } finally {
    registry?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(!npmAvailable)("an .npmrc in the install directory is refused with zero registry requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "tracked-lock-npmrc-prefix-"));
  let registry: ReturnType<typeof startRegistry> | undefined;
  try {
    const tarball = packedTarball(root);
    registry = startRegistry(tarball.bytes);
    const repo = depFixtureRepo(root, {
      version: "1.0.0",
      resolved: `${registry.url}${DEP_PATH}`,
      integrity: tarball.integrity,
    });
    const prefix = join(root, "prefix");
    mkdirSync(prefix);
    writeFileSync(join(prefix, ".npmrc"), "registry=http://127.0.0.1:1/\n");
    const result = await runHelper([
      "--via", "npm", FIXTURE, prefix, "--ignore-scripts", "--no-audit", "--no-fund",
    ], repo, { HOME: join(root, "home"), TPS_DEP_AGES_REGISTRY: registry.url });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`.npmrc refused: ${prefix}/.npmrc`);
    expect(registry.requests).toEqual([]);
  } finally {
    registry?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

for (const name of ["npm_config_registry", "npm_config_@scope:registry", "npm_config_prefix", "npm_config_node_gyp", "NPM_CONFIG_REGISTRY"]) {
  it.skipIf(!npmAvailable)(`the helper refuses ${name} before any registry request`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tracked-lock-env-"));
    let registry: ReturnType<typeof startRegistry> | undefined;
    try {
      const tarball = packedTarball(root);
      registry = startRegistry(tarball.bytes);
      const repo = depFixtureRepo(root, {
        version: "1.0.0",
        resolved: `${registry.url}${DEP_PATH}`,
        integrity: tarball.integrity,
      });
      const result = await runHelper([
        "--via", "npm", FIXTURE, join(root, "prefix"), "--ignore-scripts", "--no-audit", "--no-fund",
      ], repo, {
        HOME: join(root, "home"), TPS_DEP_AGES_REGISTRY: registry.url,
        [name]: "http://127.0.0.1:1/",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing npm_config_* variables");
      expect(result.stderr).toContain(JSON.stringify(name));
      expect(registry.requests).toEqual([]);
    } finally {
      registry?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
}

it.skipIf(!npmAvailable)("an env-named global config is refused with zero registry requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "tracked-lock-globalconfig-"));
  let registry: ReturnType<typeof startRegistry> | undefined;
  try {
    const tarball = packedTarball(root);
    registry = startRegistry(tarball.bytes);
    const repo = depFixtureRepo(root, {
      version: "1.0.0",
      resolved: `${registry.url}${DEP_PATH}`,
      integrity: tarball.integrity,
    });
    const globalconfig = join(root, "globalconfig");
    writeFileSync(globalconfig, `registry=${registry.url}/\n`);
    const result = await runHelper([
      "--via", "npm", FIXTURE, join(root, "prefix"), "--ignore-scripts", "--no-audit", "--no-fund",
    ], repo, {
      HOME: join(root, "home"), TPS_DEP_AGES_REGISTRY: registry.url,
      npm_config_globalconfig: globalconfig,
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("refusing npm_config_* variables");
    expect(result.stderr).toContain(JSON.stringify("npm_config_globalconfig"));
    expect(registry.requests).toEqual([]);
  } finally {
    registry?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(!npmAvailable)("a lock entry without a resolved URL is refused with zero registry requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "tracked-lock-resolved-"));
  let registry: ReturnType<typeof startRegistry> | undefined;
  try {
    const tarball = packedTarball(root);
    registry = startRegistry(tarball.bytes);
    const repo = depFixtureRepo(root, { version: "1.0.0" });
    const result = await runHelper([
      "--via", "npm", FIXTURE, join(root, "prefix"), "--ignore-scripts", "--no-audit", "--no-fund",
    ], repo, { HOME: join(root, "home"), TPS_DEP_AGES_REGISTRY: registry.url });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`node_modules/${DEP}: no resolved URL`);
    expect(registry.requests).toEqual([]);
  } finally {
    registry?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

const foreignResolvedUrls: [string, (registry: string) => string][] = [
  ["a different host", () => `https://other.example${DEP_PATH}`],
  ["a host-suffix trick", (registry) => `${registry}.evil.test${DEP_PATH}`],
  ["a userinfo trick", (registry) => `${registry}@evil.test${DEP_PATH}`],
];

it.skipIf(!npmAvailable).each(foreignResolvedUrls)(
  "a lock entry whose resolved URL is %s is refused with zero registry requests",
  async (_label, resolved) => {
    const root = mkdtempSync(join(tmpdir(), "tracked-lock-resolved-host-"));
    let registry: ReturnType<typeof startRegistry> | undefined;
    try {
      const tarball = packedTarball(root);
      registry = startRegistry(tarball.bytes);
      const repo = depFixtureRepo(root, { version: "1.0.0", resolved: resolved(registry.url) });
      const result = await runHelper([
        "--via", "npm", FIXTURE, join(root, "prefix"), "--ignore-scripts", "--no-audit", "--no-fund",
      ], repo, { HOME: join(root, "home"), TPS_DEP_AGES_REGISTRY: registry.url });
      expect(result.status).toBe(3);
      expect(result.stderr).toContain(`node_modules/${DEP}: resolved URL is not under ${registry.url}`);
      expect(registry.requests).toEqual([]);
    } finally {
      registry?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

it.skipIf(!npmAvailable)("TPS_DEP_AGES_REGISTRY is refused under the CI signal with zero registry requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "tracked-lock-ci-"));
  let registry: ReturnType<typeof startRegistry> | undefined;
  try {
    const tarball = packedTarball(root);
    registry = startRegistry(tarball.bytes);
    const repo = depFixtureRepo(root, {
      version: "1.0.0",
      resolved: `${registry.url}${DEP_PATH}`,
      integrity: tarball.integrity,
    });
    const result = await runHelper([
      "--via", "npm", FIXTURE, join(root, "prefix"), "--ignore-scripts", "--no-audit", "--no-fund",
    ], repo, {
      HOME: join(root, "home"), GITHUB_ACTIONS: "true", TPS_DEP_AGES_REGISTRY: registry.url,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing TPS_DEP_AGES_REGISTRY under GitHub Actions");
    expect(registry.requests).toEqual([]);
  } finally {
    registry?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

const quotedValues: [string, string[] | null][] = [
  ["\"\"", []],
  ["\"literal_0./ :+-\"", []],
  ["\"$name\"", ["name"]],
  ["\"${name}\"", ["name"]],
  ["\"$_name0\"", ["_name0"]],
  ["\"${_name0}\"", ["_name0"]],
  ["\"$A0\"", ["A0"]],
  ["\"${A}0\"", ["A"]],
  ["\"$A0$A\"", ["A0", "A"]],
  ["\"path/$name:${other_2}/end\"", ["name", "other_2"]],
  ["\"$A${B}$A\"", ["A", "B", "A"]],
  ["''", []],
  ["'literal $name ${name}'", []],
  ["'embedded\"quote'", []],
  ["literal", null],
  ["\"unterminated", null],
  ["\"$1\"", null],
  ["\"$\"", null],
  ["\"${\"", null],
  ["\"${name\"", null],
  ["\"${}\"", null],
  ["\"${1name}\"", null],
  ["\"${name-x}\"", null],
  ["\"embedded\"quote\"", null],
  ["\"$(name)\"", null],
  ["\"line\nbreak\"", null],
  ["\"line\rbreak\"", null],
  ["\"back\\slash\"", null],
  ["\"tab\there\"", null],
  ["'line\nbreak'", null],
  ["\"a\"\n", null],
  ["\"\u00e9\"", null],
];

it.each(quotedValues)("scans quoted value %j", (value, names) => {
  expect(scanQuotedValue(value)).toEqual(names);
}, 5_000);

it("checks greedily consumed names against prior assignments", () => {
  const helper = 'bash scripts/npm-ci-tracked-lock.sh --via sfw test/fixtures/heartbeat-openclaw "$prefix"';
  expect(() => npmCiLockDirs('a="literal"\nprefix="$a0"\n' + helper, "", "guard")).toThrow();
  expect(npmCiLockDirs('a0="literal"\nprefix="$a0"\n' + helper, "", "guard")).toEqual([FIXTURE]);
}, 5_000);

it("decides a long quoted value within 100 ms", () => {
  const scanner = fileURLToPath(new URL("./helpers/npm-ci-workflow-guard.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--eval", `
    import { scanQuotedValue } from ${JSON.stringify(scanner)};
    const input = '"$A' + "0$A".repeat(5000) + "x";
    const start = performance.now();
    const names = scanQuotedValue(input);
    const malformed = scanQuotedValue(input + '!"');
    const valid = scanQuotedValue(input + '"');
    console.log(JSON.stringify({ names, malformed, count: valid?.length, elapsed: performance.now() - start }));
  `], { encoding: "utf8", env: process.env, timeout: 2_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const { names, malformed, count, elapsed } = JSON.parse(result.stdout);
  expect(names).toBeNull();
  expect(malformed).toBeNull();
  expect(count).toBe(5001);
  expect(elapsed).toBeLessThan(100);
}, 5_000);
