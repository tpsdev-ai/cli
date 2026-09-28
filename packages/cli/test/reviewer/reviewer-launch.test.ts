/**
 * reviewer-launch.test.ts — the trusted launcher (cli#425 acceptance A2, A3):
 * the allowlisted child environment, the runtime verification, and the review
 * build end to end — trusted table and baked identity, the host-named job,
 * resolution, the image check, the version check, and only then real bash steps
 * — using temporary trusted/workspace/scratch directories in place of
 * /opt/reviewer, /workspace and /tmp/review.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArgsFor, loadTable } from "../../../../scripts/reviewer/build-reviewer-image.mjs";
import {
  HERMETIC,
  HERMETIC_KEYS,
  PASSTHROUGH_KEYS,
  hermeticEnv,
  probeActualVersions,
  reviewBuild,
  runSteps,
  selfCheck,
  verifyArtifact,
  verifyRuntime,
} from "../../../../scripts/reviewer/reviewer-launch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const table = loadTable(resolve(repo, "docker", "reviewer", "runtime-matrix.json"));
const node22 = table.images.find((i: { id: string }) => i.id === "reviewer-node22-bun1310");
const launcher = resolve(repo, "scripts", "reviewer", "reviewer-launch.mjs");

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

describe("A3 — the child environment is an allowlist", () => {
  test("hermetic values + PATH, LANG, LC_ALL, TERM, TZ + CI=true; nothing else", () => {
    const env = hermeticEnv(
      {
        ...POLLUTION,
        PATH: "/usr/bin",
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
    expect(Object.keys(env).sort()).toEqual([...PASSTHROUGH_KEYS, ...HERMETIC_KEYS, "CI"].sort());
    for (const key of [...Object.keys(POLLUTION), "BASH_ENV"]) expect(env[key]).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CI).toBe("true");
    expect(env.HOME).toBe("/scratch/home");
    expect(env.USERPROFILE).toBe("/scratch/home");
    expect(env.TMPDIR).toBe("/scratch/tmp");
    expect(env.npm_config_cache).toBe("/scratch/cache/npm");
    expect(env.BUN_INSTALL_CACHE_DIR).toBe("/scratch/cache/bun");
    expect(env.XDG_CACHE_HOME).toBe("/scratch/cache");
  });

  test("the image's ENV defaults are exactly the launcher's hermetic layout, under /tmp/review", () => {
    const dockerfile = readFileSync(resolve(repo, "docker", "reviewer", "Dockerfile"), "utf8");
    const envBlock = dockerfile.slice(dockerfile.indexOf("ENV REVIEWER_IMAGE_ID="));
    for (const [key, value] of Object.entries(HERMETIC)) {
      expect(value.startsWith("/tmp/review/")).toBe(true);
      expect(envBlock).toContain(`${key}=${value}`);
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
    const missing = verifyRuntime({ image: node22, actual: { node: node22.node, bun: null } });
    expect(missing.ok).toBe(false);
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
    if (!r.ok) {
      expect(r.refusal.kind).toBe("unsupported");
      expect(r.refusal.message).toContain("actual bun 1.3.10 does not satisfy >=1.4 (required by .bun-version)");
    }
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
});

// ─── the review build, end to end ────────────────────────────────────────────

let root: string;
let trusted: string;
let workspace: string;
let scratch: string;

const HOST_JOB = { REVIEWER_CI_WORKFLOW: ".github/workflows/ci.yml", REVIEWER_CI_JOB: "review" };
const actual22 = () => ({ node: "22.22.1", bun: "1.3.10" });

function writeWorkspace(nodeRange: string, steps: string, jobExtra = "") {
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "fixture", private: true, packageManager: "bun@1.3.10", engines: { node: nodeRange } }),
  );
  mkdirSync(join(workspace, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(workspace, ".github", "workflows", "ci.yml"),
    `on: push\njobs:\n  review:\n    runs-on: ubuntu-latest\n${jobExtra}    steps:\n      - uses: actions/checkout@v4\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: "1.3.10"\n${steps}`,
  );
}

function build(overrides: Record<string, unknown> = {}) {
  return reviewBuild({
    workspace,
    trustedDir: trusted,
    hermeticRoot: scratch,
    parentEnv: { PATH: process.env.PATH, ...POLLUTION, ...HOST_JOB },
    probe: actual22,
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reviewer-launch-"));
  trusted = join(root, "opt-reviewer");
  workspace = join(root, "workspace");
  scratch = join(root, "tmp-review");
  mkdirSync(join(trusted, "shims"), { recursive: true });
  mkdirSync(workspace);
  copyFileSync(resolve(repo, "docker", "reviewer", "runtime-matrix.json"), join(trusted, "runtime-matrix.json"));
  copyFileSync(resolve(repo, "docker", "reviewer", "shims", "sfw"), join(trusted, "shims", "sfw"));
  chmodSync(join(trusted, "shims", "sfw"), 0o755);
  writeFileSync(join(trusted, "image-id"), "reviewer-node22-bun1310\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("A2/A3 — the review build", () => {
  test("an in-matrix pin for THIS image runs every step, in order, in its directory, with the allowlisted env", async () => {
    mkdirSync(join(workspace, "sub"));
    writeWorkspace(
      "22.x",
      [
        "      - run: echo one > order",
        "      - run: pwd > ../where\n        working-directory: sub",
        "      - run: |\n          env > child-env\n          echo \"$HOME|$TMPDIR|$npm_config_cache\" > child-dirs\n          touch \"$HOME/h\" \"$TMPDIR/t\" \"$BUN_INSTALL_CACHE_DIR/b\"",
        "      - run: |\n          if shopt -q login_shell; then exit 90; fi\n          case $- in *i*) exit 91 ;; esac\n          echo two >> order",
      ].join("\n") + "\n",
    );
    const r = await build();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("review-build-ok");
    expect(r.image).toBe("reviewer-node22-bun1310");
    expect(r.steps.map((s: { code?: number }) => s.code)).toEqual([0, 0, 0, 0]); // step 4: not a login or interactive shell
    expect(r.skipped.map((s: { uses: string }) => s.uses)).toEqual(["actions/checkout@v4", "oven-sh/setup-bun@v2"]);
    expect(readFileSync(join(workspace, "order"), "utf8")).toBe("one\ntwo\n");
    expect(readFileSync(join(workspace, "where"), "utf8").trim().endsWith("/workspace/sub")).toBe(true);
    expect(readFileSync(join(workspace, "child-dirs"), "utf8").trim()).toBe(
      `${scratch}/home|${scratch}/tmp|${scratch}/cache/npm`,
    );
    const childEnv = readFileSync(join(workspace, "child-env"), "utf8");
    for (const key of Object.keys(POLLUTION)) expect(childEnv).not.toMatch(new RegExp(`^${key}=`, "m"));
    expect(childEnv).toMatch(/^CI=true$/m);
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
      expect(r.refusal.message).toContain("this sandbox is reviewer-node22-bun1310");
    }
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("the actual runtime is measured under the CHILD env and must match; a mismatch runs nothing", async () => {
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
    expect(seen.FOO_SECRET).toBeUndefined();
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("the image's baked identity is authoritative: a disagreeing REVIEWER_IMAGE_ID or a missing one refuses", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n");
    const wrongEnv = await build({ parentEnv: { PATH: process.env.PATH, ...HOST_JOB, REVIEWER_IMAGE_ID: "reviewer-node24-bun1310" } });
    expect(wrongEnv.ok).toBe(false);
    if (!wrongEnv.ok) expect(wrongEnv.refusal.kind).toBe("image-identity");
    rmSync(join(trusted, "image-id"));
    const none = await build();
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.refusal.kind).toBe("image-identity");
      expect(none.refusal.message).toContain("carries no baked image identity");
    }
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("without a host-named job nothing is guessed", async () => {
    writeWorkspace("22.x", "      - run: echo ran > review-marker\n");
    const r = await build({ parentEnv: { PATH: process.env.PATH } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("no-ci-job");
      expect(r.refusal.message).toContain("the host names no CI job");
    }
    const badJob = await build({ parentEnv: { PATH: process.env.PATH, ...HOST_JOB, REVIEWER_CI_JOB: "review;x" } });
    expect(badJob.ok).toBe(false);
    if (!badJob.ok) expect(badJob.refusal.message).toContain('REVIEWER_CI_JOB "review;x" is not a job id');
    // A workflow outside .github/workflows is not a CI lane, even when it is a valid one.
    copyFileSync(join(workspace, ".github", "workflows", "ci.yml"), join(workspace, "ci.yml"));
    const outside = await build({ parentEnv: { PATH: process.env.PATH, REVIEWER_CI_WORKFLOW: "ci.yml", REVIEWER_CI_JOB: "review" } });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.refusal.message).toContain("is not a .github/workflows/<name>.yml path");
    expect(existsSync(join(workspace, "review-marker"))).toBe(false);
  });

  test("each step runs under bash -eo pipefail: a failed command or pipeline fails the step; always() still runs", async () => {
    writeWorkspace(
      "22.x",
      [
        "      - run: |\n          false | true\n          touch after-pipe",
        "      - run: touch skipped",
        "      - run: touch always-ran\n        if: always()",
      ].join("\n") + "\n",
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

  test("a build that changes a lockfile is not a frozen install", async () => {
    writeFileSync(join(workspace, "bun.lock"), "{}\n");
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

  test("a job using socketdev/action gets the sfw shim, which runs its command unwrapped", async () => {
    writeWorkspace(
      "22.x",
      "      - run: |\n          command -v sfw > sfw-path\n          sfw sh -c 'echo shimmed > sfw-out'\n",
      "",
    );
    const text = readFileSync(join(workspace, ".github", "workflows", "ci.yml"), "utf8");
    writeFileSync(
      join(workspace, ".github", "workflows", "ci.yml"),
      text.replace("    steps:\n", "    steps:\n      - uses: socketdev/action@v1\n        with:\n          mode: firewall-free\n"),
    );
    const r = await build();
    expect(r.ok).toBe(true);
    expect(readFileSync(join(workspace, "sfw-path"), "utf8").trim()).toBe(join(trusted, "shims", "sfw"));
    expect(readFileSync(join(workspace, "sfw-out"), "utf8").trim()).toBe("shimmed");
  });

  test("the hermetic scratch root is recreated on every run", async () => {
    mkdirSync(join(scratch, "home"), { recursive: true });
    writeFileSync(join(scratch, "home", ".npmrc"), "//registry/:_authToken=planted\n");
    writeWorkspace("22.x", "      - run: test ! -e \"$HOME/.npmrc\"\n");
    expect((await build()).ok).toBe(true);
  });
});

describe("the launcher's own inputs", () => {
  test("probeActualVersions looks node and bun up on the child's PATH", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), "#!/bin/sh\necho v22.22.1\n", { mode: 0o755 });
    writeFileSync(join(bin, "bun"), "#!/bin/sh\necho 1.3.10\n", { mode: 0o755 });
    expect(probeActualVersions({ PATH: bin })).toEqual({ node: "22.22.1", bun: "1.3.10" });
    expect(probeActualVersions({ PATH: join(root, "empty") })).toEqual({ node: null, bun: null });
  });

  test("self-check verifies the actual runtimes against the baked entry", () => {
    const ok = selfCheck({ trustedDir: trusted, parentEnv: { PATH: "/x" }, probe: actual22 });
    expect(ok.ok).toBe(true);
    const bad = selfCheck({ trustedDir: trusted, parentEnv: { PATH: "/x" }, probe: () => ({ node: "22.22.0", bun: "1.3.10" }) });
    expect(bad.ok).toBe(false);
  });

  test("the CLI takes no table override and refuses unknown arguments", () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    const matrix = run(["--matrix", join(trusted, "runtime-matrix.json")]);
    expect(matrix.status).toBe(2);
    expect(matrix.stderr).toContain("usage:");
    // With no host-named job the build path refuses by name: outside an image
    // at the identity check (no /opt/reviewer), inside one at the job check.
    const outside = run(["--workspace", workspace]);
    expect(outside.status).toBe(1);
    expect(outside.stderr).toMatch(/refused: (image-identity|no-ci-job): /);
    expect(JSON.parse(outside.stdout.trim()).status).toBe("refused");
  });
});

describe("A2 — build args come from the table", () => {
  test("pins linux/amd64 and passes the exact versions and checksums, including the launcher's js-yaml", () => {
    const args = buildArgsFor(node22, table);
    expect(args.slice(0, 2)).toEqual(["--platform", "linux/amd64"]);
    const joined = args.join(" ");
    expect(joined).toContain(`BASE_REF=${table.base.image}@${table.base.digest}`);
    expect(joined).toContain(`NODE_VERSION=${node22.node}`);
    expect(joined).toContain(`NODE_SHA256=${table.artifacts.node[node22.node].sha256}`);
    expect(joined).toContain(`BUN_SHA256=${table.artifacts.bun[node22.bun].sha256}`);
    expect(joined).toContain(`GH_SHA256=${table.artifacts.gh[node22.gh].sha256}`);
    expect(joined).toContain(`JSYAML_VERSION=${table.launcherDeps["js-yaml"].version}`);
    expect(joined).toContain(`JSYAML_SHA256=${table.launcherDeps["js-yaml"].sha256}`);
    expect(joined).toContain(`REVIEWER_IMAGE_ID=${node22.id}`);
  });

  test("refuses an image pinning a runtime absent from the table, or another platform", () => {
    expect(() => buildArgsFor({ ...node22, id: "x", node: "99.0.0" }, table)).toThrow();
    expect(() => buildArgsFor({ ...node22, platform: "linux/arm64" }, table)).toThrow();
    expect(() => buildArgsFor(node22, { ...table, launcherDeps: {} })).toThrow(/launcherDeps js-yaml/);
  });
});
