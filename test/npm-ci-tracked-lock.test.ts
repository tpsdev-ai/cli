import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCiLockDirs, parseWorkflow, scanQuotedValue } from "./helpers/npm-ci-workflow-guard";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = "test/fixtures/heartbeat-openclaw";
const HELPER = join(REPO, "scripts/npm-ci-tracked-lock.sh");
const NODE = Bun.which("node");
if (NODE === null) throw new Error("test setup requires node");

type Recorded = { argv: string[]; cwd: string; lock: string; manifest: string };

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
const { readFileSync, writeFileSync } = require("node:fs");
const { join, basename } = require("node:path");
const argv = process.argv.slice(2);
if (basename(process.argv[1]) === "npm") writeFileSync(process.env.RECORD + ".npm-call", JSON.stringify({ argv, cwd: process.cwd() }));
const prefix = argv.includes("--prefix") ? argv[argv.indexOf("--prefix") + 1] : process.cwd();
const lockPath = join(prefix, "package-lock.json");
const record = { argv, cwd: process.cwd(), lock: readFileSync(lockPath, "utf8"), manifest: readFileSync(join(prefix, "package.json"), "utf8") };
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
    expect(h.installed()).toEqual({ argv: args, cwd: REPO.replace(/\/$/, ""), lock, manifest });
    expect(h.firewalled()).toEqual({ argv: ["npm", ...args], cwd: REPO.replace(/\/$/, ""), lock, manifest });
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

it.each(["npm-shrinkwrap.json", "package-lock.json", "package.json"])(
  "in-place install refuses a prior workflow step writing %s before the installer runs", (file) => {
    harness((h) => {
      const repo = workingFixture(h);
      const run = `echo '{}' > ${FIXTURE}/${file}`;
      const install = `bash scripts/npm-ci-tracked-lock.sh --via npm --in-place ${FIXTURE} --ignore-scripts`;
      const source = `jobs:\n  build:\n    steps:\n      - run: ${run}\n      - run: ${install}\n`;
      const steps = parseWorkflow(source).jobs.build.steps;
      expect(npmCiLockDirs(steps[0].run!, "", "prior writer")).toEqual([]);
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
    expect(h.installed()).toEqual({ argv: ["ci", "--ignore-scripts"], cwd: join(repo, FIXTURE), lock, manifest });
    if (via === "sfw") expect(h.firewalled().argv).toEqual(["npm", "ci", "--ignore-scripts"]);
    else expect(() => h.firewalled()).toThrow(/ENOENT/);
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
    expect(h.installed().argv).toEqual(["ci"]);
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
    expect(installed.argv).toEqual(["ci", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund"]);
    expect(h.firewalled().argv).toEqual(["npm", ...installed.argv]);
    expect(readFileSync(join(h.root, "github-env"), "utf8")).toBe(`OPENCLAW_BIN_DIR=${prefix}/node_modules/.bin\n`);
  });
}, 30_000);

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
