/**
 * reviewer-launch.test.ts — the trusted launcher (cli#425 acceptance A2, A3,
 * A9): the host assignment and its override refusal, the allowlisted child
 * environment with a fixed PATH, runtime verification with fixed binaries, the
 * worktree checks (symlinked lockfiles and directories before and after every
 * job, bounded reads, the git configuration baseline and hooks, the fresh-clone
 * check checkout's skip relies on, resolved working directories), timeouts and
 * leftover processes, and the review build end to end — the needs closure,
 * real bash steps — on depth-1 clones of a temporary source repository, with
 * temporary trusted/scratch directories in place of /opt/reviewer and
 * /tmp/review.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArgsFor, loadTable } from "../../../../scripts/reviewer/build-reviewer-image.mjs";
import {
  checkFreshClone,
  checkStepEnv,
  containedDirectory,
  gitConfigFindings,
  guardStep,
  HERMETIC,
  HERMETIC_KEYS,
  hermeticEnv,
  hostAssignment,
  inspectGitConfig,
  PASSTHROUGH_KEYS,
  probeActualVersions,
  readBoundedFile,
  readCreationEnv,
  removeCreatedPaths,
  reviewBuild,
  runSteps,
  scanWorkspace,
  selfCheck,
  STEP_PATH,
  verifyArtifact,
  verifyRuntime,
} from "../../../../scripts/reviewer/reviewer-launch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const table = loadTable(resolve(repo, "docker", "reviewer", "runtime-matrix.json"));
const node22 = table.images.find((i: { id: string }) => i.id === "reviewer-node22-bun1310");
const launcher = resolve(repo, "scripts", "reviewer", "reviewer-launch.mjs");

const CHECKOUT = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683";
const SETUP_BUN = "oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76";
const SOCKET = "socketdev/action@ba6de6cc0565af1f42295590380973573297e31f";

/** Parent-environment values that must never reach a step. */
const POLLUTION: Record<string, string> = {
  NPM_TOKEN: "canary-npm",
  NODE_AUTH_TOKEN: "canary-node-auth",
  GH_TOKEN: "canary-gh",
  GITHUB_TOKEN: "canary-github",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "store",
  GIT_CONFIG_GLOBAL: "/host/.gitconfig",
  GH_CONFIG_DIR: "/host/gh",
  NPM_CONFIG_USERCONFIG: "/host/.npmrc",
  BUN_INSTALL: "/host/.bun",
  COREPACK_HOME: "/host/corepack",
  SSH_AUTH_SOCK: "/host/agent.sock",
  NODE_OPTIONS: "--require /host/hook.js",
  FOO_SECRET: "canary-foo",
  REVIEWER_IMAGE_ID: "reviewer-node22-bun1310",
};

/** The host's assignment, as the container init's environment carries it. */
const HOST = { REVIEWER_CI_WORKFLOW: ".github/workflows/ci.yml", REVIEWER_CI_JOB: "review", REVIEWER_CI_BASE: "main" };

describe("A3 — the child environment is an allowlist with a fixed PATH", () => {
  test("hermetic values + fixed PATH + LANG, LC_ALL, TERM, TZ + CI=true; nothing else", () => {
    const env = hermeticEnv(
      {
        ...POLLUTION,
        PATH: "/evil/bin:/usr/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TERM: "dumb",
        TZ: "UTC",
        HOME: "/root",
        TMPDIR: "/host/tmp",
        npm_config_cache: "/host/npm",
        BASH_ENV: "/host/bashenv",
      },
      "/scratch",
    );
    expect(Object.keys(env).sort()).toEqual([...PASSTHROUGH_KEYS, ...HERMETIC_KEYS, "PATH", "CI"].sort());
    for (const key of [...Object.keys(POLLUTION), "BASH_ENV"]) expect(env[key]).toBeUndefined();
    expect(env.PATH).toBe(STEP_PATH);
    expect(env.CI).toBe("true");
    expect(env.HOME).toBe("/scratch/home");
    expect(env.TMPDIR).toBe("/scratch/tmp");
    expect(env.npm_config_cache).toBe("/scratch/cache/npm");
    expect(env.BUN_INSTALL_CACHE_DIR).toBe("/scratch/cache/bun");
  });

  test("the image's ENV defaults are exactly the launcher's hermetic layout, under /tmp/review", () => {
    const dockerfile = readFileSync(resolve(repo, "docker", "reviewer", "Dockerfile"), "utf8");
    const envBlock = dockerfile.slice(dockerfile.indexOf("ENV REVIEWER_IMAGE_ID="));
    for (const [key, value] of Object.entries(HERMETIC)) {
      expect(value.startsWith("/tmp/review/")).toBe(true);
      expect(envBlock).toContain(`${key}=${value}`);
    }
  });

  test("guardStep refuses a step whose effective env the planner should never have produced", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    try {
      const launcherEnv = hermeticEnv({}, "/scratch");
      const step = { index: 1, name: "s", script: "true", workingDirectory: ".", env: { NODE_ENV: "test" }, always: false };
      const ok = guardStep(step, launcherEnv, dir);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.env.NODE_ENV).toBe("test");
      for (const env of [{ GH_TOKEN: "x" }, { PATH: "/evil" }, { HOME: "/elsewhere" }]) {
        const r = guardStep({ ...step, env }, launcherEnv, dir);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.refusal.kind).toBe("step-env");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a step's effective env is re-checked: launcher-owned values unchanged, nothing credential-shaped", () => {
    const launcherEnv = hermeticEnv({}, "/scratch");
    expect(checkStepEnv({ ...launcherEnv, NODE_ENV: "test" }, launcherEnv).ok).toBe(true);
    const home = checkStepEnv({ ...launcherEnv, HOME: "/elsewhere" }, launcherEnv);
    expect(home.ok).toBe(false);
    if (!home.ok) expect(home.refusal.message).toContain("HOME changed");
    for (const key of ["GH_TOKEN", "GIT_CONFIG_COUNT", "NODE_OPTIONS", "SOME_SECRET"]) {
      const r = checkStepEnv({ ...launcherEnv, [key]: "x" }, launcherEnv);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.kind).toBe("step-env");
    }
  });
});

describe("A2 — runtime verification", () => {
  test("accepts actual versions matching the entry and every requirement", () => {
    const r = verifyRuntime({
      image: node22,
      actual: { node: node22.node, bun: node22.bun },
      requirements: [
        { tool: "node", range: "22.x", source: "engines.node" },
        { tool: "bun", range: "1.3.10", source: "packageManager" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.receipt.requirements_verified).toBe(2);
  });

  test("stops on a node version mismatch", () => {
    const r = verifyRuntime({ image: node22, actual: { node: "24.21.0", bun: node22.bun } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe("version-mismatch");
  });

  test("stops on a bun version mismatch", () => {
    const r = verifyRuntime({ image: node22, actual: { node: node22.node, bun: "1.3.9" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("version-mismatch");
      expect(r.refusal.message).toContain("actual bun 1.3.9");
    }
    expect(verifyRuntime({ image: node22, actual: { node: node22.node, bun: null } }).ok).toBe(false);
  });

  test("stops when the actual node does not satisfy a repository requirement", () => {
    const r = verifyRuntime({ image: node22, actual: { node: node22.node, bun: node22.bun }, requirements: { node: ">22" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe("unsupported");
  });

  test("stops when the actual bun does not satisfy a repository requirement", () => {
    const r = verifyRuntime({
      image: node22,
      actual: { node: node22.node, bun: node22.bun },
      requirements: [{ tool: "bun", range: ">=1.4", source: ".bun-version" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toContain("actual bun 1.3.10 does not satisfy >=1.4 (required by .bun-version)");
  });

  test("a requirement for a runtime the image does not provide stops the build", () => {
    const r = verifyRuntime({
      image: node22,
      actual: { node: node22.node, bun: node22.bun },
      requirements: [{ tool: "deno", range: "2", source: "x" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toContain("no runtime in this image provides deno");
  });

  test("checksum verification fails closed", () => {
    expect(verifyArtifact({ sha256: "a".repeat(64) }, "a".repeat(64)).ok).toBe(true);
    expect(verifyArtifact({ sha256: "a".repeat(64) }, "b".repeat(64)).ok).toBe(false);
  });
});

describe("the host assignment", () => {
  test("comes from the creation environment; the caller may repeat it but not change or add it", () => {
    const ok = hostAssignment(HOST, { ...HOST, PATH: "/x" });
    expect(ok).toEqual({ ok: true, workflow: HOST.REVIEWER_CI_WORKFLOW, job: HOST.REVIEWER_CI_JOB, base: HOST.REVIEWER_CI_BASE });
    for (const key of Object.keys(HOST)) {
      const r = hostAssignment(HOST, { [key]: "other" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.kind).toBe("assignment-override");
    }
    const added = hostAssignment({}, HOST);
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.refusal.kind).toBe("assignment-override");
  });

  test("an unreadable creation environment, a missing value or a malformed one refuses", () => {
    const none = hostAssignment(null, {});
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.refusal.message).toContain("creation environment");
    const missing = hostAssignment({ ...HOST, REVIEWER_CI_BASE: "" }, {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refusal.message).toContain("the host names no CI job");
    for (const [key, value, text] of [
      ["REVIEWER_CI_WORKFLOW", "ci.yml", "is not a .github/workflows/<name>.yml path"],
      ["REVIEWER_CI_JOB", "review;x", 'REVIEWER_CI_JOB "review;x" is not a job id'],
      ["REVIEWER_CI_BASE", "main*", "is not a branch name"],
    ]) {
      const r = hostAssignment({ ...HOST, [key]: value }, {});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.message).toContain(text);
    }
  });
});

describe("A2 — step execution order", () => {
  test("after a failure only always() steps run, and the failure is reported", async () => {
    const ran: number[] = [];
    const steps = [
      { index: 1, name: "a", always: false },
      { index: 2, name: "b", always: false },
      { index: 3, name: "c", always: false },
      { index: 4, name: "d", always: true },
    ];
    const r = await runSteps(steps, async (s: { index: number }) => {
      ran.push(s.index);
      return s.index === 2 ? 3 : 0;
    });
    expect(ran).toEqual([1, 2, 4]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failed).toEqual({ step: 2, name: "b", code: 3 });
  });

  test("a refusal from the step runner stops at once", async () => {
    const ran: number[] = [];
    const r = await runSteps(
      [
        { index: 1, name: "a", always: false },
        { index: 2, name: "b", always: true },
      ],
      async (s: { index: number }) => {
        ran.push(s.index);
        return { ok: false, refusal: { kind: "working-directory", message: "x" } };
      },
    );
    expect(ran).toEqual([1]);
    expect(r.refusal?.kind).toBe("working-directory");
  });
});

describe("git configuration: the safe baseline", () => {
  test("a fresh clone's configuration and an identity are the baseline", () => {
    const listing = [
      "file:.git/config\tcore.repositoryformatversion=0",
      "file:.git/config\tcore.filemode=true",
      "file:.git/config\tcore.bare=false",
      "file:.git/config\tcore.logallrefupdates=true",
      "file:.git/config\tcore.ignorecase=true",
      "file:.git/config\tcore.precomposeunicode=true",
      "file:.git/config\tremote.origin.url=https://github.com/tpsdev-ai/cli",
      "file:.git/config\tremote.origin.fetch=+refs/heads/*:refs/remotes/origin/*",
      "file:.git/config\tbranch.main.remote=origin",
      "file:.git/config\tbranch.main.merge=refs/heads/main",
      "file:.git/config\tuser.name=ci",
      "file:.git/config\tuser.email=ci@example.invalid",
      "command line:\tsafe.directory=/workspace",
      "command line:\tcore.fsmonitor=false",
    ].join("\n");
    expect(gitConfigFindings(listing)).toEqual([]);
  });

  test("executable, transport-changing and credential keys outside the baseline are named", () => {
    const keys = [
      "core.fsmonitor=touch x",
      "core.hookspath=/tmp/h",
      "core.pager=less",
      "core.editor=vi",
      "core.worktree=/elsewhere",
      "protocol.file.allow=always",
      "protocol.ext.allow=always",
      "uploadpack.allowfilter=true",
      "url.https://mirror.example/.insteadof=https://github.com/",
      "url.https://mirror.example/.pushinsteadof=https://github.com/",
      "filter.lfs.clean=git-lfs clean -- %f",
      "diff.external=/tmp/d",
      "remote.origin.uploadpack=/tmp/u",
      "remote.origin.receivepack=/tmp/r",
      "gpg.program=/tmp/g",
      "safe.directory=*",
    ];
    const findings = gitConfigFindings(keys.map((k) => `file:.git/config\t${k}`).join("\n"));
    expect(findings).toEqual(keys.map((k) => `${k.slice(0, k.indexOf("="))} (file:.git/config)`));
  });

  test("a baseline key whose value carries a credential or picks a transport helper is named", () => {
    const findings = gitConfigFindings(
      [
        "file:.git/config\tremote.origin.url=https://x:ghp_SECRET@github.com/o/r",
        "file:.git/config\tremote.evil.url=ext::sh -c touch% /tmp/pwned",
        "file:.git/config\tremote.opt.url=--upload-pack=touch",
        "file:.git/config\tbranch.main.merge=refs/heads/main",
      ].join("\n"),
    );
    expect(findings).toEqual(["remote.origin.url (file:.git/config)", "remote.evil.url (file:.git/config)", "remote.opt.url (file:.git/config)"]);
    expect(findings.join(" ")).not.toContain("SECRET");
  });

  test("gitConfigFindings names keys and origins, never values, and masks userinfo — each rule on its own", () => {
    const listing = [
      "file:.git/config\tcore.bare=false",
      "file:.git/config\thttp.https://github.com/.extraheader=X-Trace: 1",
      "file:.git/config\turl.https://u:ghs_SECRET@github.com/.insteadof=https://github.com/",
      "file:.git/config\tremote.origin.url=https://x:ghp_SECRET@github.com/o/r",
      "file:/etc/gitconfig\tcredential.helper=store",
      "file:.git/config\tcore.askpass=/x",
      "file:.git/config\tcore.sshcommand=ssh -i k",
      "file:.git/config\tinclude.path=../evil",
      "file:.git/config\tincludeif.gitdir:/x/.path=y",
      "file:.git/config\thttp.cookiefile=/c",
      "file:.git/config\thttp.sslcert=/c",
      "file:.git/config\tsendemail.smtppass=hunter2",
      "file:.git/config\talias.x=!curl -H 'Authorization: Basic c2VjcmV0'",
      "command line:\tsafe.directory=/workspace",
    ].join("\n");
    const findings = gitConfigFindings(listing);
    expect(findings).toEqual([
      "http.https://github.com/.extraheader (file:.git/config)",
      "url.https://***@github.com/.insteadof (file:.git/config)",
      "remote.origin.url (file:.git/config)",
      "credential.helper (file:/etc/gitconfig)",
      "core.askpass (file:.git/config)",
      "core.sshcommand (file:.git/config)",
      "include.path (file:.git/config)",
      "includeif.gitdir:/x/.path (file:.git/config)",
      "http.cookiefile (file:.git/config)",
      "http.sslcert (file:.git/config)",
      "sendemail.smtppass (file:.git/config)",
      "alias.x (file:.git/config)",
    ]);
    const joined = findings.join(" ");
    for (const secret of ["SECRET", "c2VjcmV0", "hunter2"]) expect(joined).not.toContain(secret);
  });
});

// ─── the review build, end to end ────────────────────────────────────────────

let root: string;
let trusted: string;
let src: string;
let workspace: string;
let scratch: string;
let outside: string;

const actual22 = () => ({ node: "22.22.1", bun: "1.3.10" });
const GIT_ENV = () => ({ PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1" });
const gitIn = (cwd: string, ...args: string[]) => spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8", env: GIT_ENV() });
const git = (...args: string[]) => gitIn(workspace, ...args);
/** The real inspectors, with the host machine's own system git config excluded. */
const inspectNoSystem = (a: { workspace: string; env: Record<string, string> }) =>
  inspectGitConfig({ ...a, env: { ...a.env, GIT_CONFIG_NOSYSTEM: "1" } });
const freshNoSystem = (a: { workspace: string; env: Record<string, string>; fetchDepth: number }) =>
  checkFreshClone({ ...a, env: { ...a.env, GIT_CONFIG_NOSYSTEM: "1" } });
/** A checkout step, for jobs added before `review`. */
const CO = `      - uses: ${CHECKOUT}\n`;

/** A pull_request workflow whose `review` job runs the given step lines; `jobs` adds jobs before it. Written to the source repo. */
function writeWorkspace(nodeRange: string, steps: string, { jobExtra = "", jobs = "", env = "", checkoutWith = "" } = {}) {
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "fixture", private: true, packageManager: "bun@1.3.10", engines: { node: nodeRange } }));
  mkdirSync(join(src, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(src, ".github", "workflows", "ci.yml"),
    `on:\n  pull_request:\n    branches: [main]\n${env}jobs:\n${jobs}  review:\n    runs-on: ubuntu-latest\n${jobExtra}    steps:\n      - uses: ${CHECKOUT}\n${checkoutWith}      - uses: ${SETUP_BUN}\n        with:\n          bun-version: "1.3.10"\n${steps}`,
  );
}

/** Commit the source repo and mount a fresh clone of it as the worktree: depth 1 (checkout's default) or full. */
function publish(depth: 0 | 1 = 1) {
  gitIn(src, "add", "-A");
  gitIn(src, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture");
  rmSync(workspace, { recursive: true, force: true });
  const args = depth === 1 ? ["clone", "-q", "--depth", "1", `file://${src}`, workspace] : ["clone", "-q", `file://${src}`, workspace];
  const r = spawnSync("/usr/bin/git", args, { encoding: "utf8", env: GIT_ENV() });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
}

function build(overrides: Record<string, unknown> & { afterPublish?: () => void; depth?: 0 | 1 } = {}) {
  const { afterPublish, depth = 1, ...rest } = overrides;
  publish(depth);
  afterPublish?.();
  return reviewBuild({
    workspace,
    trustedDir: trusted,
    hermeticRoot: scratch,
    parentEnv: { PATH: process.env.PATH, ...POLLUTION, ...HOST },
    creationEnv: HOST,
    probe: actual22,
    inspectGit: inspectNoSystem,
    checkFresh: freshNoSystem,
    ...rest,
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-launch-")));
  trusted = join(root, "opt-reviewer");
  src = join(root, "src");
  workspace = join(root, "workspace");
  scratch = join(root, "tmp-review");
  outside = join(root, "outside");
  mkdirSync(join(trusted, "shims"), { recursive: true });
  mkdirSync(workspace);
  mkdirSync(outside);
  mkdirSync(src);
  gitIn(src, "init", "-q", "-b", "main");
  copyFileSync(resolve(repo, "docker", "reviewer", "runtime-matrix.json"), join(trusted, "runtime-matrix.json"));
  copyFileSync(resolve(repo, "docker", "reviewer", "shims", "sfw"), join(trusted, "shims", "sfw"));
  chmodSync(join(trusted, "shims", "sfw"), 0o755);
  writeFileSync(join(trusted, "image-id"), "reviewer-node22-bun1310\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("A2/A3 — the review build", () => {
  test("an in-matrix pin for THIS image runs every step, in order, in its directory, with the allowlisted env and fixed PATH", async () => {
    mkdirSync(join(src, "sub"));
    writeFileSync(join(src, "sub", ".keep"), "");
    writeWorkspace(
      "22.x",
      [
        "      - run: echo one > order",
        "      - run: pwd > ../where\n        working-directory: sub",
        "      - run: |\n          env > child-env\n          echo \"$HOME|$TMPDIR|$npm_config_cache|$PATH\" > child-dirs\n          touch \"$HOME/h\" \"$TMPDIR/t\" \"$BUN_INSTALL_CACHE_DIR/b\"",
        "      - run: |\n          if shopt -q login_shell; then exit 90; fi\n          case $- in *i*) exit 91 ;; esac\n          echo two >> order",
      ].join("\n") + "\n",
    );
    const r = await build();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("review-build-ok");
    expect(r.image).toBe("reviewer-node22-bun1310");
    expect(r.base).toBe("main");
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0].steps.map((s: { code?: number }) => s.code)).toEqual([0, 0, 0, 0]); // step 4: not a login or interactive shell
    expect(r.jobs[0].skipped.map((s: { uses: string }) => s.uses)).toEqual([CHECKOUT, SETUP_BUN]);
    expect(readFileSync(join(workspace, "order"), "utf8")).toBe("one\ntwo\n");
    expect(readFileSync(join(workspace, "where"), "utf8").trim()).toBe(join(workspace, "sub"));
    expect(readFileSync(join(workspace, "child-dirs"), "utf8").trim()).toBe(`${scratch}/home|${scratch}/tmp|${scratch}/cache/npm|${STEP_PATH}`);
    const childEnv = readFileSync(join(workspace, "child-env"), "utf8");
    for (const key of [...Object.keys(POLLUTION), ...Object.keys(HOST)]) expect(childEnv).not.toMatch(new RegExp(`^${key}=`, "m"));
    expect(childEnv).toMatch(/^CI=true$/m);
  });

  test("a caller's PATH never selects a step's executables", async () => {
    const evil = join(root, "evil");
    mkdirSync(evil);
    writeFileSync(join(evil, "touch"), `#!/bin/sh\necho evil > "${join(root, "evil-ran")}"\n`, { mode: 0o755 });
    writeWorkspace("22.x", "      - run: touch made\n");
    const r = await build({ parentEnv: { ...POLLUTION, ...HOST, PATH: `${evil}:/usr/bin:/bin` } });
    expect(r.ok).toBe(true);
    expect(existsSync(join(workspace, "made"))).toBe(true);
    expect(existsSync(join(root, "evil-ran"))).toBe(false);
  });

  test("an out-of-matrix pin refuses by name before anything runs", async () => {
    writeWorkspace(">=25", "      - run: echo ran > review-marker\n");
    let steps = 0;
    const r = await build({ runStep: async () => ++steps });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("out-of-matrix");
      expect(r.refusal.message).toContain("missing image: node >=25 with bun 1.3.10");
    }
    expect(steps).toBe(0);
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("a pin that resolves to ANOTHER matrix image refuses (wrong-image) before anything runs", async () => {
    writeWorkspace("24.x", "      - run: echo ran > review-marker\n");
    const r = await build();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("wrong-image");
      expect(r.refusal.message).toContain("resolves to reviewer-node24-bun1310");
    }
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("the actual runtime is measured with the CHILD env and must match; a mismatch runs nothing", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n");
    let seen: Record<string, string> = {};
    const r = await build({
      probe: (env: Record<string, string>) => {
        seen = env;
        return { node: "22.22.1", bun: "1.3.9" };
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe("version-mismatch");
    expect(seen.HOME).toBe(`${scratch}/home`);
    expect(seen.PATH).toBe(STEP_PATH);
    expect(seen.FOO_SECRET).toBeUndefined();
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("the image's baked identity is authoritative: a disagreeing REVIEWER_IMAGE_ID or a missing one refuses", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n");
    const wrongEnv = await build({ parentEnv: { PATH: "/x", ...HOST, REVIEWER_IMAGE_ID: "reviewer-node24-bun1310" } });
    expect(wrongEnv.ok).toBe(false);
    if (!wrongEnv.ok) expect(wrongEnv.refusal.kind).toBe("image-identity");
    rmSync(join(trusted, "image-id"));
    const none = await build();
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.refusal.message).toContain("carries no baked image identity");
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("the job comes only from the host: a caller naming another job, or no host assignment, runs nothing", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n", { jobs: "  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo other > other-marker\n" });
    const override = await build({ parentEnv: { PATH: "/x", ...HOST, REVIEWER_CI_JOB: "other" } });
    expect(override.ok).toBe(false);
    if (!override.ok) expect(override.refusal.kind).toBe("assignment-override");
    const none = await build({ creationEnv: null });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.refusal.kind).toBe("no-ci-job");
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
    expect(existsSync(join(workspace, "other-marker"))).toBe(false);
  });

  test("each step runs under bash -eo pipefail: a failed command or pipeline fails the step; always() still runs", async () => {
    writeWorkspace(
      "22.x",
      ["      - run: |\n          false | true\n          touch after-pipe", "      - run: touch skipped", "      - run: touch always-ran\n        if: always()"].join("\n") + "\n",
    );
    const r = await build();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe("stage-failed");
    expect(existsSync(join(workspace, "after-pipe"))).toBe(false);
    expect(existsSync(join(workspace, "skipped"))).toBe(false);
    expect(existsSync(join(workspace, "always-ran"))).toBe(true);

    writeWorkspace("22.x", "      - run: |\n          false\n          touch after-false\n");
    expect((await build()).ok).toBe(false);
    expect(existsSync(join(workspace, "after-false"))).toBe(false);
  });

  test("a build that changes or creates a lockfile is not a frozen install", async () => {
    writeFileSync(join(src, "bun.lock"), "{}\n");
    writeWorkspace("22.x", "      - run: echo '// drift' >> bun.lock\n");
    const r = await build();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("unfrozen-install");
      expect(r.refusal.message).toContain("bun.lock (changed)");
    }
    writeWorkspace("22.x", "      - run: mkdir -p pkg && echo '{}' > pkg/package-lock.json\n");
    const created = await build();
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.refusal.message).toContain("pkg/package-lock.json (created)");
  });

  test("a symlinked lockfile or a symlinked directory refuses before any step runs", async () => {
    writeFileSync(join(outside, "bun.lock"), "{}\n");
    symlinkSync(join(outside, "bun.lock"), join(src, "bun.lock"));
    writeWorkspace("22.x", "      - run: echo changed >> bun.lock && echo ran > review-marker\n");
    const lock = await build();
    expect(lock.ok).toBe(false);
    if (!lock.ok) {
      expect(lock.refusal.kind).toBe("symlinked-path");
      expect(lock.refusal.message).toContain("a symlinked lockfile bun.lock");
    }
    expect(readFileSync(join(outside, "bun.lock"), "utf8")).toBe("{}\n");
    rmSync(join(src, "bun.lock"));
    symlinkSync(outside, join(src, "pkg"));
    const alias = await build();
    expect(alias.ok).toBe(false);
    if (!alias.ok) expect(alias.refusal.message).toContain("a symlinked directory pkg");
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("a lockfile the build turns into a symlink is drift", async () => {
    writeFileSync(join(src, "bun.lock"), "{}\n");
    writeFileSync(join(outside, "bun.lock"), "{}\n");
    writeWorkspace("22.x", `      - run: rm bun.lock && ln -s "${join(outside, "bun.lock")}" bun.lock\n`);
    const r = await build();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("unfrozen-install");
      expect(r.refusal.message).toContain("symlinked lockfiles (bun.lock)");
    }
  });

  test("a working directory that RESOLVES outside the worktree refuses immediately before the step", async () => {
    writeWorkspace(
      "22.x",
      [`      - run: ln -s "${outside}" esc`, "      - run: echo escaped > marker\n        working-directory: esc"].join("\n") + "\n",
    );
    const r = await build();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("working-directory");
      expect(r.refusal.message).toContain('"esc" resolves outside the worktree');
    }
    expect(existsSync(join(outside, "marker"))).toBe(false);
  });

  test("a symlinked directory a job creates runs in its resolved path, and the post-job scan refuses it", async () => {
    mkdirSync(join(src, "real"));
    writeFileSync(join(src, "real", ".keep"), "");
    writeWorkspace("22.x", ["      - run: ln -s real alias", "      - run: pwd -P > ../cwd\n        working-directory: alias"].join("\n") + "\n");
    const r = await build();
    expect(readFileSync(join(workspace, "cwd"), "utf8").trim()).toBe(join(workspace, "real"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("symlinked-path");
      expect(r.refusal.message).toContain("job review left symlinked directories (alias)");
    }
  });

  test("git credential or auth settings in the worktree refuse before any step, without repeating the value", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n");
    const r = await build({ afterPublish: () => git("config", "http.https://github.com/.extraheader", "AUTHORIZATION: basic ZmFrZS1yZWQtcHJvb2Y=") });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("git-config");
      expect(r.refusal.message).toContain("http.https://github.com/.extraheader (file:.git/config)");
      expect(r.refusal.message).not.toContain("ZmFrZS1yZWQtcHJvb2Y=");
    }
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
    expect((await build()).ok).toBe(true);
  });

  test("an executable git setting (core.fsmonitor) refuses before git runs anything in the worktree", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n");
    const r = await build({ afterPublish: () => git("config", "core.fsmonitor", `touch ${join(root, "fsmonitor-ran")}`) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("git-config");
      expect(r.refusal.message).toContain("core.fsmonitor (file:.git/config)");
    }
    expect(existsSync(join(root, "fsmonitor-ran"))).toBe(false);
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("a git hook a fresh clone would not have refuses", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n");
    const r = await build({ afterPublish: () => writeFileSync(join(workspace, ".git", "hooks", "post-checkout"), "#!/bin/sh\n", { mode: 0o755 }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toContain("git hooks a fresh clone does not (post-checkout)");
  });

  test("a git configuration git cannot read, or a missing git, refuses rather than passes", () => {
    const bad = join(root, "bad-git");
    writeFileSync(bad, "#!/bin/sh\necho 'fatal: bad config line 1 in file .git/config' >&2\nexit 128\n", { mode: 0o755 });
    const unreadable = inspectGitConfig({ workspace, env: hermeticEnv({}, scratch), git: bad });
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) {
      expect(unreadable.refusal.kind).toBe("git-config-unreadable");
      expect(unreadable.refusal.message).toContain("bad config line 1");
    }
    const missing = inspectGitConfig({ workspace, env: hermeticEnv({}, scratch), git: join(root, "no-such-git") });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refusal.kind).toBe("git-config-unreadable");
  });

  test("checkFreshClone cannot verify a worktree whose git metadata is unreachable, and refuses", () => {
    writeFileSync(join(workspace, ".git"), "gitdir: /nonexistent/host/.git/worktrees/x\n");
    const r = checkFreshClone({ workspace, env: { ...hermeticEnv({}, scratch), GIT_CONFIG_NOSYSTEM: "1" }, fetchDepth: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toContain("not reachable in the sandbox");
  });

  test("a worktree whose git metadata is outside the sandbox is not an error", () => {
    writeFileSync(join(workspace, ".git"), "gitdir: /nonexistent/host/.git/worktrees/x\n");
    const r = inspectNoSystem({ workspace, env: hermeticEnv({}, scratch) });
    expect(r.ok).toBe(true);
  });

  test("workflow env carrying a credential never reaches a step", async () => {
    writeWorkspace("22.x", "      - run: echo \"$GH_TOKEN\" > leaked\n", { env: "env:\n  GH_TOKEN: fake-token\n" });
    const r = await build();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toContain("sets GH_TOKEN");
    expect(existsSync(join(workspace, "leaked"))).toBe(false);
  });

  test("a job whose needed guard fails does not run, and the build is not ok", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n", {
      jobExtra: "    needs: guard\n",
      jobs: `  guard:\n    runs-on: ubuntu-latest\n    steps:\n${CO}      - run: exit 3\n`,
    });
    const r = await build();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("stage-failed");
      expect(r.refusal.message).toBe("job guard: step 2 (run 2) exited 3");
      expect(r.jobs.at(-1)).toEqual({ job: "review", skipped: "needs guard, which did not succeed" });
    }
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("the closure runs dependencies first, each job from the worktree as the build found it", async () => {
    writeFileSync(join(src, "kept"), "pre-existing\n");
    writeWorkspace("22.x", "      - run: |\n          test ! -e left-behind\n          test ! -e made-dir\n          test -e kept\n          test ! -e \"$HOME/job-home\"\n          echo ran > review-marker\n", {
      jobExtra: "    needs: build\n",
      jobs: `  build:\n    runs-on: ubuntu-latest\n    steps:\n${CO}      - run: |\n          echo x > left-behind\n          mkdir -p made-dir/sub && echo y > made-dir/sub/f\n          echo job-home > "$HOME/job-home"\n`,
    });
    const r = await build();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jobs.map((j: { job: string }) => j.job)).toEqual(["build", "review"]);
    expect(existsSync(join(workspace, "review-marker"))).toBe(true);
    expect(readFileSync(join(workspace, "kept"), "utf8")).toBe("pre-existing\n");
  });

  test("a job-level always() still runs after a failed need, and the build is still not ok", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n", {
      jobExtra: "    needs: guard\n    if: always()\n",
      jobs: `  guard:\n    runs-on: ubuntu-latest\n    steps:\n${CO}      - run: exit 3\n`,
    });
    const r = await build();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toContain("job guard: step 2");
    expect(existsSync(join(workspace, "review-marker"))).toBe(true);
  });

  test("checkout is skipped only on a fresh clone: an untracked, ignored or modified path refuses before any step", async () => {
    writeFileSync(join(src, ".gitignore"), "dist/\n");
    writeFileSync(join(src, "tracked"), "v1\n");
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n");
    for (const dirty of [
      () => writeFileSync(join(workspace, "stray"), "x"),
      () => {
        mkdirSync(join(workspace, "dist"));
        writeFileSync(join(workspace, "dist", "old.js"), "x");
      },
      () => writeFileSync(join(workspace, "tracked"), "v2\n"),
    ]) {
      const r = await build({ afterPublish: dirty });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.refusal.kind).toBe("not-fresh");
        expect(r.refusal.message).toContain("not the clean clone actions/checkout gives CI");
      }
      expect(existsSync(join(workspace, "review-marker"))).toBe(false);
    }
  });

  test("checkout's history shape: depth 1 needs a shallow one-commit clone without tags; fetch-depth 0 needs a full clone", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n");
    const full = await build({ depth: 0 });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.refusal.message).toContain("is not a shallow clone");
    const tagged = await build({ afterPublish: () => git("tag", "v1") });
    expect(tagged.ok).toBe(false);
    if (!tagged.ok) expect(tagged.refusal.message).toContain("has tags");
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n", { checkoutWith: "        with:\n          fetch-depth: 0\n" });
    expect((await build({ depth: 0 })).ok).toBe(true);
    const shallowForFull = await build({ depth: 1 });
    expect(shallowForFull.ok).toBe(false);
    if (!shallowForFull.ok) expect(shallowForFull.refusal.message).toContain("fetch-depth: 0");
  });

  test("a needed job that modifies a tracked file leaves the next job no fresh clone: refused, the next job never runs", async () => {
    writeFileSync(join(src, "tracked"), "v1\n");
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n", {
      jobExtra: "    needs: build\n",
      jobs: `  build:\n    runs-on: ubuntu-latest\n    steps:\n${CO}      - run: echo v2 > tracked\n`,
    });
    const r = await build();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("not-fresh");
      expect(r.refusal.message).toContain("tracked");
    }
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("a step's timeout-minutes is enforced: the step is killed at the limit and the build fails", async () => {
    writeWorkspace("22.x", "      - run: |\n          sleep 5\n          touch late\n        timeout-minutes: 0.01\n");
    const t0 = Date.now();
    const r = await build();
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toBe("job review: step 3 (run 3) timed out (timeout-minutes)");
    expect(existsSync(join(workspace, "late"))).toBe(false);
  });

  test("a job's timeout-minutes bounds every step, always() ones included", async () => {
    writeWorkspace(
      "22.x",
      ["      - run: sleep 5", "      - run: touch second", "      - run: touch always-ran\n        if: always()"].join("\n") + "\n",
      { jobExtra: "    timeout-minutes: 0.01\n" },
    );
    const t0 = Date.now();
    const r = await build();
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toContain("timed out");
    expect(existsSync(join(workspace, "second"))).toBe(false);
    expect(existsSync(join(workspace, "always-ran"))).toBe(false);
  });

  test("the step runner is given the smaller of the step's and the job's remaining time", async () => {
    writeWorkspace("22.x", "      - run: a\n        timeout-minutes: 2\n      - run: b\n", { jobExtra: "    timeout-minutes: 5\n" });
    const seen: number[] = [];
    const r = await build({
      runStep: async ({ timeoutMs }: { timeoutMs: number }) => {
        seen.push(timeoutMs);
        return 0;
      },
    });
    expect(r.ok).toBe(true);
    expect(seen[0]).toBe(120_000);
    expect(seen[1]).toBeGreaterThan(290_000);
    expect(seen[1]).toBeLessThanOrEqual(300_000);
  });

  test("once the job's time is up, no further step is started, always() ones included", async () => {
    writeWorkspace("22.x", "      - run: a\n      - run: b\n        if: always()\n", { jobExtra: "    timeout-minutes: 0.0005\n" });
    const started: number[] = [];
    const r = await build({
      runStep: async ({ step }: { step: { index: number } }) => {
        started.push(step.index);
        await new Promise((done) => setTimeout(done, 80));
        return { code: 124, timedOut: true };
      },
    });
    expect(r.ok).toBe(false);
    expect(started).toEqual([3]);
    if (!r.ok) expect(r.jobs[0].steps.map((s: { timedOut?: boolean }) => s.timedOut)).toEqual([true, true]);
  });

  test("what a job's steps leave running is killed when the job ends", async () => {
    writeWorkspace("22.x", `      - run: (sleep 1; touch "${join(root, "orphan-ran")}") > /dev/null 2>&1 &\n`);
    const r = await build();
    expect(r.ok).toBe(true);
    await new Promise((done) => setTimeout(done, 1600));
    expect(existsSync(join(root, "orphan-ran"))).toBe(false);
  });

  test("a job using socketdev/action gets the sfw shim, which runs its command unwrapped", async () => {
    writeWorkspace("22.x", "      - run: |\n          command -v sfw > sfw-path\n          sfw sh -c 'echo shimmed > sfw-out'\n");
    const text = readFileSync(join(src, ".github", "workflows", "ci.yml"), "utf8");
    writeFileSync(
      join(src, ".github", "workflows", "ci.yml"),
      text.replace(`      - uses: ${CHECKOUT}\n`, `      - uses: ${CHECKOUT}\n      - uses: ${SOCKET}\n        with:\n          mode: firewall-free\n`),
    );
    const r = await build();
    expect(r.ok).toBe(true);
    expect(readFileSync(join(workspace, "sfw-path"), "utf8").trim()).toBe(join(trusted, "shims", "sfw"));
    expect(readFileSync(join(workspace, "sfw-out"), "utf8").trim()).toBe("shimmed");
  });

  test("the hermetic scratch root is recreated on every run", async () => {
    mkdirSync(join(scratch, "home"), { recursive: true });
    writeFileSync(join(scratch, "home", ".npmrc"), "//registry/:_authToken=planted\n");
    writeWorkspace("22.x", '      - run: test ! -e "$HOME/.npmrc"\n');
    expect((await build()).ok).toBe(true);
  });

  test("a symlinked workflow file refuses", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n");
    const wf = join(src, ".github", "workflows", "ci.yml");
    copyFileSync(wf, join(src, "real-ci.yml"));
    rmSync(wf);
    symlinkSync("../../real-ci.yml", wf);
    const r = await build();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toContain("reached through a symlink");
  });
});

describe("bounded reads of the worktree", () => {
  test("a declaration that is not a regular file, too large, dangling or outside the worktree refuses without hanging", () => {
    expect(spawnSync("mkfifo", [join(workspace, ".nvmrc")]).status).toBe(0);
    const fifo = readBoundedFile(workspace, ".nvmrc", 100);
    expect(fifo.ok).toBe(false);
    rmSync(join(workspace, ".nvmrc"));
    writeFileSync(join(workspace, "big"), "x".repeat(101));
    expect(readBoundedFile(workspace, "big", 100).ok).toBe(false);
    symlinkSync(join(outside, "nope"), join(workspace, "dangling"));
    expect(readBoundedFile(workspace, "dangling", 100).ok).toBe(false);
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(join(outside, "secret"), join(workspace, ".node-version"));
    const out = readBoundedFile(workspace, ".node-version", 100);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal.message).toContain("resolves outside the worktree");
    expect(readBoundedFile(workspace, "absent", 100)).toEqual({ ok: true, text: null });
  });

  test("scanWorkspace finds symlinked lockfiles and directory aliases, skips node_modules/.git, and is bounded", () => {
    mkdirSync(join(workspace, "node_modules", "x"), { recursive: true });
    writeFileSync(join(workspace, "node_modules", "x", "yarn.lock"), "");
    writeFileSync(join(workspace, "yarn.lock"), "a");
    symlinkSync(join(outside), join(workspace, "alias"));
    symlinkSync(join(workspace, "yarn.lock"), join(workspace, "package-lock.json"));
    const s = scanWorkspace(workspace);
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect([...s.lockfiles.keys()]).toEqual(["yarn.lock"]);
      expect(s.symlinkedLockfiles).toEqual(["package-lock.json"]);
      expect(s.directoryAliases).toEqual(["alias"]);
    }
    const bounded = scanWorkspace(workspace, { maxEntries: 2 });
    expect(bounded.ok).toBe(false);
  });

  test("a lockfile that is not a regular file (a FIFO) refuses without hanging", () => {
    expect(spawnSync("mkfifo", [join(workspace, "bun.lock")]).status).toBe(0);
    const s = scanWorkspace(workspace);
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.refusal.message).toContain("bun.lock is not a regular file");
  });

  test("removeCreatedPaths removes only what was not there before, top-most first", () => {
    writeFileSync(join(workspace, "old"), "o");
    const before = scanWorkspace(workspace);
    mkdirSync(join(workspace, "new-dir", "deep"), { recursive: true });
    writeFileSync(join(workspace, "new-dir", "deep", "f"), "n");
    writeFileSync(join(workspace, "new-file"), "n");
    const now = scanWorkspace(workspace);
    if (!before.ok || !now.ok) throw new Error("scan failed");
    expect(removeCreatedPaths(workspace, before.paths, now.paths).sort()).toEqual(["new-dir", "new-file"]);
    expect(existsSync(join(workspace, "old"))).toBe(true);
    expect(existsSync(join(workspace, "new-dir"))).toBe(false);
  });

  test("containedDirectory resolves symlinks and refuses an escape", () => {
    symlinkSync(outside, join(workspace, "out"));
    mkdirSync(join(workspace, "in"));
    expect(containedDirectory(workspace, "out").ok).toBe(false);
    expect(containedDirectory(workspace, "missing").ok).toBe(false);
    expect(containedDirectory(workspace, "in")).toEqual({ ok: true, dir: join(workspace, "in") });
  });
});

describe("the launcher's own inputs", () => {
  test("probeActualVersions runs the fixed binaries, not whatever PATH names", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), "#!/bin/sh\necho v22.22.1\n", { mode: 0o755 });
    writeFileSync(join(bin, "bun"), "#!/bin/sh\necho 1.3.10\n", { mode: 0o755 });
    const bins = { node: join(bin, "node"), bun: join(bin, "bun") };
    expect(probeActualVersions({ PATH: join(root, "empty") }, bins)).toEqual({ node: "22.22.1", bun: "1.3.10" });
    expect(probeActualVersions({ PATH: bin }, { node: join(root, "none", "node"), bun: join(root, "none", "bun") })).toEqual({ node: null, bun: null });
  });

  test("readCreationEnv parses a NUL-separated environ block; unreadable is null", () => {
    const f = join(root, "environ");
    writeFileSync(f, "A=1\0REVIEWER_CI_JOB=test\0B=x=y\0");
    expect(readCreationEnv(f)).toEqual({ A: "1", REVIEWER_CI_JOB: "test", B: "x=y" });
    expect(readCreationEnv(join(root, "missing"))).toBeNull();
  });

  test("self-check verifies the actual runtimes against the baked entry", () => {
    expect(selfCheck({ trustedDir: trusted, parentEnv: { PATH: "/x" }, probe: actual22 }).ok).toBe(true);
    expect(selfCheck({ trustedDir: trusted, parentEnv: { PATH: "/x" }, probe: () => ({ node: "22.22.0", bun: "1.3.10" }) }).ok).toBe(false);
  });

  test("the CLI takes no workspace or table override and refuses unknown arguments", () => {
    const run = (args: string[]) => spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    for (const args of [["--workspace", workspace], ["--matrix", join(trusted, "runtime-matrix.json")], ["extra"]]) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("usage:");
    }
    // Outside an image there is no /opt/reviewer: the build path refuses by name.
    const outsideImage = run([]);
    expect(outsideImage.status).toBe(1);
    expect(outsideImage.stderr).toMatch(/refused: (image-identity|no-ci-job): /);
    expect(JSON.parse(outsideImage.stdout.trim()).status).toBe("refused");
  });
});

describe("A2 — build args come from the table", () => {
  test("pins linux/amd64 and passes the exact versions and checksums, including the launcher's js-yaml", () => {
    const args = buildArgsFor(node22, table);
    expect(args.slice(0, 2)).toEqual(["--platform", "linux/amd64"]);
    const joined = args.join(" ");
    expect(joined).toContain(`BASE_REF=${table.base.image}@${table.base.digest}`);
    expect(joined).toContain(`NODE_SHA256=${table.artifacts.node[node22.node].sha256}`);
    expect(joined).toContain(`BUN_SHA256=${table.artifacts.bun[node22.bun].sha256}`);
    expect(joined).toContain(`GH_SHA256=${table.artifacts.gh[node22.gh].sha256}`);
    expect(joined).toContain(`JSYAML_SHA256=${table.launcherDeps["js-yaml"].sha256}`);
    expect(joined).toContain(`REVIEWER_IMAGE_ID=${node22.id}`);
  });

  test("refuses an image pinning a runtime absent from the table, or another platform", () => {
    expect(() => buildArgsFor({ ...node22, id: "x", node: "99.0.0" }, table)).toThrow();
    expect(() => buildArgsFor({ ...node22, platform: "linux/arm64" }, table)).toThrow();
    expect(() => buildArgsFor(node22, { ...table, launcherDeps: {} })).toThrow(/launcherDeps js-yaml/);
  });
});
