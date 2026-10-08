/**
 * ci-job.test.ts — the review build's plan comes from ONE host-named job of the
 * reviewed commit's workflow and the jobs it needs, parsed as bounded YAML
 * (cli#425 section A: CI-equivalent install/build/test; no blanket command, no
 * dropped stage, no skipped stage counted as evidence). What the planner runs,
 * skips and refuses is asserted case by case.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkTrigger,
  condition,
  forbiddenEnvReason,
  MAX_WORKFLOW_BYTES,
  planJob,
  SKIPPED_ACTIONS,
} from "../../../../scripts/reviewer/ci-job.mjs";
import { RESERVED_ENV_KEYS } from "../../../../scripts/reviewer/reviewer-launch.mjs";
import yaml from "js-yaml";

const SUITE_STEP = "Unit + integration tests, HOME-isolated (cli#430)";

/** Whether this repository's HOME-isolated suite step declares an env key, read with the planner's YAML schema. */
function suiteStepDeclaresEnv(workflowText: string): boolean {
  const wf = yaml.load(workflowText, { schema: yaml.CORE_SCHEMA }) as { jobs: { test: { steps: Array<Record<string, unknown>> } } };
  const step = wf.jobs.test.steps.find((s) => s.name === SUITE_STEP);
  if (!step) throw new Error(`no step named ${SUITE_STEP}`);
  return Object.hasOwn(step, "env");
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");

const CHECKOUT = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683";
const SETUP_BUN = "oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76";
const SETUP_NODE = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const SOCKET = "socketdev/action@ba6de6cc0565af1f42295590380973573297e31f";
const CACHE = "actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830";
const UPLOAD = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";

function plan(workflowText: string, jobId = "t", baseBranch = "main") {
  return planJob({ workflowText, workflowFile: ".github/workflows/ci.yml", jobId, baseBranch, reservedEnvKeys: RESERVED_ENV_KEYS });
}

function refused(workflowText: string, jobId = "t", baseBranch = "main") {
  const p = plan(workflowText, jobId, baseBranch);
  expect(p.ok).toBe(false);
  if (p.ok) throw new Error("expected a refusal");
  return p.refusal;
}

/** The planned job `id` of an accepted plan. */
function jobOf(p: ReturnType<typeof planJob>, id = "t") {
  expect(p.ok).toBe(true);
  if (!p.ok) throw new Error(p.refusal.message);
  const j = p.jobs.find((x: { id: string }) => x.id === id);
  if (!j) throw new Error(`no job ${id}`);
  return j;
}

/** A one-job pull_request workflow around the given step lines (already indented as list items), with no checkout added. */
const bare = (steps: string, extra = "", on = "on: pull_request\n") =>
  `${on}jobs:\n  t:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;
/** The same, beginning with the reviewed checkout, as every job must. */
const job = (steps: string, extra = "", on = "on: pull_request\n") => bare(`      - uses: ${CHECKOUT}\n${steps}`, extra, on);
/** An extra job (for needs) that begins with the reviewed checkout. */
const extraJob = (id: string, body: string, runsOn = "ubuntu-latest") =>
  `  ${id}:\n    runs-on: ${runsOn}\n${body}`;

describe("this repository's test job", () => {
  const p = planJob({
    workflowText: readFileSync(resolve(repo, ".github", "workflows", "test.yml"), "utf8"),
    workflowFile: ".github/workflows/test.yml",
    jobId: "test",
    baseBranch: "main",
    reservedEnvKeys: RESERVED_ENV_KEYS,
  });

  test("runs its needs closure dependencies first: build, then test", () => {
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.jobs.map((j: { id: string; needs: string[] }) => [j.id, j.needs])).toEqual([["build", []], ["test", ["build"]]]);
  });

  test("every run: step of test, in order, in its working directory — including the HOME-isolated suite, both plugin launchers and the report guard", () => {
    const t = jobOf(p, "test");
    expect(t.steps.map((s: { index: number; workingDirectory: string; always: boolean }) => [s.index, s.workingDirectory, s.always])).toEqual([
      [4, ".", false],
      [6, ".", false],
      [7, ".", false],
      [8, ".", false],
      [9, ".", false],
      [10, "plugins/openclaw-tps-mail", false],
      [11, "plugins/openclaw-github-review", false],
      [12, ".", true],
    ]);
    expect(t.steps[0].script).toBe("node scripts/check-dep-ages.mjs --ci");
    expect(t.steps[1].script).toBe("sfw bun install --frozen-lockfile");
    // cli#430: the monorepo suite runs with HOME at an empty mktemp dir, and the
    // step fails if that dir gains a `.tps`. Pinned whole: the planner hands the
    // script to bash unchanged, so every line of it is what the review build
    // runs. HOME is set inside the script, not by an env: key (the launcher owns
    // HOME and refuses a workflow that sets it), so the step carries no env.
    expect(t.steps[4].name).toBe("Unit + integration tests, HOME-isolated (cli#430)");
    expect(t.steps[4].script).toBe(
      [
        `iso_home="$(mktemp -d)"`,
        `HOME="$iso_home" bun run test`,
        `if [ -e "$iso_home/.tps" ]; then`,
        `  echo "::error::the suite wrote $iso_home/.tps — HOME is not isolated"`,
        "  exit 1",
        "fi",
        "",
      ].join("\n"),
    );
    expect(t.steps[4].env).toEqual({});
    // The planner maps an absent env: and an empty `env: {}` to the same {}, so
    // the planned env alone cannot show the step declares none: parse the
    // workflow the way the planner does and require no env key on the step.
    expect(suiteStepDeclaresEnv(readFileSync(resolve(repo, ".github", "workflows", "test.yml"), "utf8"))).toBe(false);
    expect(t.steps[5].script).toContain("npm ci --ignore-scripts");
    expect(t.steps[6].script).toContain("npm ci --ignore-scripts");
    expect(t.steps[6].script).toContain("bun run test");
    expect(t.steps[7].script).toBe("node scripts/check-test-reports.mjs");
  });

  test("the no-env check on the HOME-isolated step sees every YAML spelling of an env key", () => {
    const base = readFileSync(resolve(repo, ".github", "workflows", "test.yml"), "utf8");
    const at = "        run: |\n          iso_home=";
    expect(base.split(at).length).toBe(2);
    expect(suiteStepDeclaresEnv(base)).toBe(false);
    for (const spelling of ["env: {}", '"env": {}', "env : {}", "'env': {}", "env: {FOO: bar}"]) {
      expect(suiteStepDeclaresEnv(base.replace(at, `        ${spelling}\n${at}`))).toBe(true);
    }
  });

  test("the setup actions are skipped by name at their reviewed tags, their pins kept, and sfw is shimmed", () => {
    const t = jobOf(p, "test");
    expect(t.skipped.map((s: { uses: string; tag: string }) => `${s.uses.split("@")[0]}@${s.tag}`)).toEqual([
      "actions/checkout@v4.2.2",
      "actions/setup-node@v4.4.0",
      "oven-sh/setup-bun@v2.0.2",
      "socketdev/action@v1.3.2",
    ]);
    if (!p.ok) return;
    expect(p.pins.map((x: { range: string }) => x.range)).toEqual(["24.21.0", "1.3.10", "24.21.0", "1.3.10"]);
    expect(p.shims).toEqual(["sfw"]);
  });

  test("every run: step of the test job is planned on Node 24.21.0", () => {
    const t = jobOf(p, "test");
    expect(t.steps.map((s: { index: number; node: string }) => [s.index, s.node])).toEqual([
      [4, "24.21.0"],
      [6, "24.21.0"],
      [7, "24.21.0"],
      [8, "24.21.0"],
      [9, "24.21.0"],
      [10, "24.21.0"],
      [11, "24.21.0"],
      [12, "24.21.0"],
    ]);
  });

  test("every ref this repository's workflows use for a skipped action is in the reviewed allowlist", () => {
    const dir = resolve(repo, ".github", "workflows");
    for (const file of readdirSync(dir)) {
      for (const m of readFileSync(resolve(dir, file), "utf8").matchAll(/uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([0-9a-f]{40})/g)) {
        const action = (SKIPPED_ACTIONS as Record<string, { refs: Record<string, string> }>)[m[1].toLowerCase()];
        if (action) expect(Object.keys(action.refs)).toContain(m[2]);
      }
    }
  });
});

describe("the reviewed allowlist of skipped-action refs", () => {
  test("every ref is a full 40-hex commit SHA with its release tag", () => {
    for (const [name, action] of Object.entries(SKIPPED_ACTIONS as Record<string, { refs: Record<string, string> }>)) {
      expect(Object.keys(action.refs).length).toBeGreaterThan(0);
      for (const [sha, tag] of Object.entries(action.refs)) {
        expect(`${name}@${sha}`).toMatch(/@[0-9a-f]{40}$/);
        expect(tag).toMatch(/^v\d+\.\d+\.\d+$/);
      }
    }
  });

  test("a tag, a branch, a short SHA or an unreviewed SHA refuses", () => {
    for (const ref of ["actions/checkout@v4", "actions/checkout@main", "actions/checkout@11bd719", "actions/checkout@arbitrary-ref", `actions/checkout@${"a".repeat(40)}`]) {
      const r = refused(bare(`      - uses: ${ref}\n      - run: a\n`));
      expect(r.kind).toBe("ci-unhonourable");
      expect(r.message).toContain("not a reviewed immutable ref");
    }
  });

  test("a reviewed SHA is skipped and named with its tag", () => {
    const t = jobOf(plan(bare(`      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n          fetch-depth: 0\n      - run: a\n`)));
    expect(t.skipped).toEqual([{ index: 1, uses: CHECKOUT, tag: "v4.2.2", reason: "the workspace is the host-created clone at the assigned head, checked before the job" }]);
  });
});

describe("the trigger: CI must run the workflow for a pull request into the host-named base", () => {
  test("pull_request as a string, a list or a mapping is accepted", () => {
    expect(plan(job("      - run: a\n", "", "on: pull_request\n")).ok).toBe(true);
    expect(plan(job("      - run: a\n", "", "on: [push, pull_request]\n")).ok).toBe(true);
    expect(plan(job("      - run: a\n", "", "on:\n  pull_request:\n")).ok).toBe(true);
    expect(plan(job("      - run: a\n", "", "on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n")).ok).toBe(true);
  });

  test("an absent, push-only, manual-only or scheduled trigger refuses", () => {
    expect(refused(job("      - run: a\n", "", "")).kind).toBe("ci-not-triggered");
    for (const on of ["on: push\n", "on: workflow_dispatch\n", "on: [push, workflow_dispatch]\n", "on:\n  schedule:\n    - cron: '0 0 * * *'\n", "on:\n  pull_request_target:\n"]) {
      expect(refused(job("      - run: a\n", "", on)).kind).toBe("ci-not-triggered");
    }
  });

  test("a lookalike of on (Cyrillic о) is refused, never read as on", () => {
    const r = refused(job("      - run: a\n", "", "\u043en: pull_request\n"));
    expect(r.message).toContain("not printable ASCII");
  });

  test("a branches filter must list the base exactly; branches-ignore must not", () => {
    const on = "on:\n  pull_request:\n    branches: [main, release]\n";
    expect(plan(job("      - run: a\n", "", on), "t", "main").ok).toBe(true);
    expect(refused(job("      - run: a\n", "", on), "t", "develop").kind).toBe("ci-not-triggered");
    const ignore = "on:\n  pull_request:\n    branches-ignore: [develop]\n";
    expect(plan(job("      - run: a\n", "", ignore), "t", "main").ok).toBe(true);
    expect(refused(job("      - run: a\n", "", ignore), "t", "develop").kind).toBe("ci-not-triggered");
  });

  test("patterns, path filters and narrowed types cannot be evaluated or do not cover every head", () => {
    expect(refused(job("      - run: a\n", "", "on:\n  pull_request:\n    branches: ['releases/**']\n")).message).toContain("pattern");
    expect(refused(job("      - run: a\n", "", "on:\n  pull_request:\n    branches: ['!main']\n")).message).toContain("pattern");
    expect(refused(job("      - run: a\n", "", "on:\n  pull_request:\n    paths: [src/**]\n")).message).toContain("changed files");
    expect(refused(job("      - run: a\n", "", "on:\n  pull_request:\n    types: [labeled]\n")).kind).toBe("ci-not-triggered");
    expect(refused(job("      - run: a\n", "", "on:\n  pull_request:\n    types: [opened]\n")).kind).toBe("ci-not-triggered");
    expect(plan(job("      - run: a\n", "", "on:\n  pull_request:\n    types: [opened, synchronize, reopened]\n")).ok).toBe(true);
  });

  test("checkTrigger names the base it was given", () => {
    const r = checkTrigger({ pull_request: { branches: ["main"] } }, "next", "ci.yml");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toContain("not into next");
  });

  test("a base that is not a plain branch name refuses", () => {
    for (const base of ["", "main*", "../main", "/main", "main/"]) expect(refused(job("      - run: a\n"), "t", base).kind).toBe("no-ci-job");
  });
});

describe("needs: the dependency closure", () => {
  const wf = `on: pull_request
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: ${CHECKOUT}
      - run: exit 1
  lint:
    runs-on: ubuntu-latest
    needs: guard
    steps:
      - uses: ${CHECKOUT}
      - run: echo lint
  t:
    runs-on: ubuntu-latest
    needs: [lint, guard]
    steps:
      - uses: ${CHECKOUT}
      - run: echo test
  unrelated:
    runs-on: macos-14
    steps:
      - run: echo never planned
`;

  test("the named job and everything it needs, dependencies first; unrelated jobs are not planned", () => {
    const p = plan(wf);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.jobs.map((j: { id: string }) => j.id)).toEqual(["guard", "lint", "t"]);
  });

  test("an undefined need, a cycle, or a needed job the launcher cannot reproduce refuses", () => {
    expect(refused(job("      - run: a\n", "    needs: missing\n")).message).toContain('needs "missing"');
    const cycle = `on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    needs: t\n    steps:\n${"      - uses: " + CHECKOUT}\n      - run: a\n  t:\n    runs-on: ubuntu-latest\n    needs: a\n    steps:\n${"      - uses: " + CHECKOUT}\n      - run: b\n`;
    expect(refused(cycle).message).toContain("cycle");
    const bad = wf.replace("  guard:\n    runs-on: ubuntu-latest", "  guard:\n    runs-on: windows-latest");
    expect(refused(bad).message).toContain('job "guard" runs-on');
  });
});

describe("working directories, shells and env", () => {
  test("a step's working-directory is kept; defaults.run.working-directory applies", () => {
    const t = jobOf(
      plan(job("      - run: bun run test\n        working-directory: packages/x\n      - run: bun run build\n", "    defaults:\n      run:\n        working-directory: ./packages/y/\n")),
    );
    expect(t.steps.map((s: { workingDirectory: string }) => s.workingDirectory)).toEqual(["packages/x", "packages/y"]);
  });

  test("a working directory lexically outside the workspace refuses", () => {
    expect(refused(job("      - run: a\n        working-directory: /etc\n")).message).toContain("leaves the workspace");
    expect(refused(job("      - run: a\n        working-directory: packages/../../x\n")).message).toContain("leaves the workspace");
  });

  test("only bash is reproduced", () => {
    expect(plan(job("      - run: a\n        shell: bash\n")).ok).toBe(true);
    expect(refused(job("      - run: print(1)\n        shell: python\n")).message).toContain("only bash");
    expect(refused(job("      - run: a\n", "    defaults:\n      run:\n        shell: sh\n")).message).toContain("only bash");
  });

  test("plain env is honoured, workflow < job < step", () => {
    const t = jobOf(
      plan(`on: pull_request\nenv:\n  A: wf\n  B: wf\n  N: 3\njobs:\n  t:\n    runs-on: ubuntu-24.04\n    env:\n      B: job\n      C: job\n    steps:\n      - uses: ${CHECKOUT}\n      - run: a\n        env:\n          C: step\n          GIT_AUTHOR_NAME: ci\n`),
    );
    expect(t.steps[0].env).toEqual({ A: "wf", B: "job", N: "3", C: "step", GIT_AUTHOR_NAME: "ci" });
  });

  test("env the launcher owns, or that needs an expression, refuses", () => {
    for (const key of ["HOME", "TMPDIR", "PATH", "npm_config_cache", "BUN_INSTALL_CACHE_DIR", "CI", "LANG"]) {
      expect(refused(job(`      - run: a\n        env:\n          ${key}: /x\n`)).message).toContain(`sets ${key}`);
    }
    expect(refused(job("      - run: a\n        env:\n          T: ${{ secrets.T }}\n")).message).toContain("expression");
  });

  test("credential-shaped and config-redirecting env refuses at workflow, job and step level", () => {
    const keys = [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "MY_SECRET",
      "DEPLOY_KEY",
      "API_KEY",
      "DB_PASSWORD",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_ASKPASS",
      "GIT_SSH_COMMAND",
      "SSH_AUTH_SOCK",
      "NPM_CONFIG_USERCONFIG",
      "npm_config_registry",
      "BUN_CONFIG_REGISTRY",
      "NODE_OPTIONS",
      "BASH_ENV",
      "LD_PRELOAD",
      "HTTPS_PROXY",
      "AWS_ACCESS_KEY_ID",
      "XDG_RUNTIME_DIR",
    ];
    for (const key of keys) {
      expect(forbiddenEnvReason(key)).not.toBeNull();
      expect(refused(job(`      - run: a\n        env:\n          ${key}: fake\n`)).message).toContain(`sets ${key}:`);
    }
    expect(refused(`on: pull_request\nenv:\n  GH_TOKEN: fake\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${CHECKOUT}\n      - run: a\n`).message).toContain("GH_TOKEN");
    expect(refused(job("      - run: a\n", "    env:\n      GIT_CONFIG_GLOBAL: /x\n")).message).toContain("GIT_CONFIG_GLOBAL");
    for (const key of ["NODE_ENV", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "FORCE_COLOR", "TPS_TEST_MODE", "KEYBOARD"]) {
      expect(forbiddenEnvReason(key)).toBeNull();
    }
  });

  test("an expression in a script refuses", () => {
    expect(refused(job("      - run: echo ${{ github.sha }}\n")).message).toContain("expression");
  });
});

describe("if:, continue-on-error and keys", () => {
  test("only absent / true / success() / always() are honoured", () => {
    expect(condition(undefined)).toBe("success");
    expect(condition(true)).toBe("success");
    expect(condition("true")).toBe("success");
    expect(condition("${{ success() }}")).toBe("success");
    expect(condition("always()")).toBe("always");
    expect(condition("${{ always() }}")).toBe("always");
    for (const c of [false, "false", "failure()", "!cancelled()", "github.event_name == 'push'", "${{ matrix.os == 'x' }}", 1]) {
      expect(condition(c)).toBeNull();
    }
    expect(refused(job("      - run: a\n        if: failure()\n")).kind).toBe("ci-unhonourable");
  });

  test("an always() step is marked to run after a failure", () => {
    const t = jobOf(plan(job("      - run: a\n      - run: b\n        if: always()\n")));
    expect(t.steps.map((s: { always: boolean }) => s.always)).toEqual([false, true]);
  });

  test("a job CI never runs (if: false) refuses", () => {
    const r = refused(job("      - run: a\n", "    if: false\n"));
    expect(r.message).toContain("if: false");
  });

  test("continue-on-error would count a failure as success: refused on steps and jobs", () => {
    expect(refused(job("      - run: a\n        continue-on-error: true\n")).message).toContain("continue-on-error");
    expect(refused(job("      - run: a\n", "    continue-on-error: true\n")).message).toContain("continue-on-error");
    expect(plan(job("      - run: a\n        continue-on-error: false\n")).ok).toBe(true);
  });

  test("strategy, container, services, environment, reusable workflows and unknown top-level keys refuse", () => {
    expect(refused(job("      - run: a\n", "    strategy:\n      matrix:\n        n: [22, 24]\n")).message).toContain('"strategy"');
    expect(refused(job("      - run: a\n", "    container: node:22\n")).message).toContain('"container"');
    expect(refused(job("      - run: a\n", "    services:\n      db:\n        image: pg\n")).message).toContain('"services"');
    expect(refused(job("      - run: a\n", "    environment: prod\n")).message).toContain('"environment"');
    expect(refused("on: pull_request\njobs:\n  t:\n    uses: org/repo/.github/workflows/x.yml@main\n").message).toContain('"uses"');
    expect(refused(`defaultz: {}\n${job("      - run: a\n")}`).message).toContain('top-level key "defaultz"');
  });

  test("a lookalike key anywhere is refused (e.g. a Cyrillic і in if)", () => {
    expect(refused(job("      - run: a\n        \u0456f: failure()\n")).message).toContain("not printable ASCII");
    expect(refused(job("      - run: a\n", "    ne\u0435ds: guard\n")).message).toContain("not printable ASCII");
  });

  test("runs-on must be one of the verified GitHub-hosted labels", () => {
    expect(plan(job("      - run: a\n")).ok).toBe(true);
    expect(plan(job("      - run: a\n").replace("ubuntu-latest", "ubuntu-24.04")).ok).toBe(true);
    for (const runner of ["ubuntu-22.04", "ubuntu-20.04", "ubuntu-99.99", "macos-14", "ubuntu-24.04-arm", "windows-latest", "${{ matrix.os }}", "self-hosted", "[ubuntu-latest]"]) {
      expect(refused(job("      - run: a\n").replace("ubuntu-latest", runner.startsWith("[") ? runner : JSON.stringify(runner))).message).toContain("runs-on");
    }
  });

  test("timeout-minutes is carried for enforcement: the job's (default 360, capped at 360) and each step's", () => {
    const t = jobOf(plan(job("      - run: a\n        timeout-minutes: 2\n      - run: b\n", "    timeout-minutes: 5\n")));
    expect(t.timeoutMinutes).toBe(5);
    expect(t.steps.map((s: { timeoutMinutes: number | null }) => s.timeoutMinutes)).toEqual([2, null]);
    expect(jobOf(plan(job("      - run: a\n"))).timeoutMinutes).toBe(360);
    expect(jobOf(plan(job("      - run: a\n", "    timeout-minutes: 1000\n"))).timeoutMinutes).toBe(360);
    for (const v of ["0", "-1", "abc", "${{ inputs.t }}", "[1]"]) {
      expect(refused(job("      - run: a\n", `    timeout-minutes: ${v}\n`)).message).toContain("timeout-minutes");
      expect(refused(job(`      - run: a\n        timeout-minutes: ${v}\n`)).message).toContain("timeout-minutes");
    }
  });

  test("ignored job keys are accepted: name, permissions, concurrency, outputs", () => {
    const extra = "    name: T\n    permissions: {}\n    concurrency: x\n    outputs:\n      o: v\n";
    expect(plan(job("      - run: a\n        timeout-minutes: 1\n", extra)).ok).toBe(true);
  });
});

describe("uses: — skipped at a reviewed ref, or refused", () => {
  test("an action the launcher does not know refuses, naming it", () => {
    const r = refused(job("      - uses: actions/github-script@v7\n      - run: a\n"));
    expect(r.kind).toBe("ci-unhonourable");
    expect(r.message).toContain("actions/github-script@v7");
    expect(refused(job("      - uses: ./.github/actions/setup\n      - run: a\n")).kind).toBe("ci-unhonourable");
    expect(refused(job("      - uses: docker://alpine:3\n      - run: a\n")).kind).toBe("ci-unhonourable");
    expect(refused(job("      - uses: actions/checkout\n      - run: a\n")).message).toContain('uses "actions/checkout", which the review launcher cannot reproduce');
  });

  test("a step key the launcher does not know refuses", () => {
    expect(refused(job("      - run: a\n        entrypoint: /bin/x\n")).message).toContain('uses "entrypoint"');
  });

  test("checkout is skipped only with inputs that do not change the tree", () => {
    for (const input of ["ref: other", "submodules: true", "lfs: true", "repository: x/y", "token: t"]) {
      expect(refused(bare(`      - uses: ${CHECKOUT}\n        with:\n          ${input}\n      - run: a\n`)).message).toContain(`the input "${input.split(":")[0]}"`);
    }
  });

  test("setup-bun: an exact bun-version becomes a pin; none, a range, a file or a registry refuses", () => {
    const p = plan(job(`      - uses: ${SETUP_BUN}\n        with:\n          bun-version: "1.3.10"\n      - run: a\n`));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.pins).toEqual([{ tool: "bun", range: "1.3.10", source: '.github/workflows/ci.yml job "t" step 2 bun-version' }]);
    expect(refused(job(`      - uses: ${SETUP_BUN}\n      - run: a\n`)).message).toContain("gives oven-sh/setup-bun no bun-version");
    for (const v of ["1.x", "latest", "1.3", "^1.3.10", "canary"]) {
      expect(refused(job(`      - uses: ${SETUP_BUN}\n        with:\n          bun-version: "${v}"\n      - run: a\n`)).message).toContain("only an exact version");
    }
    expect(refused(job(`      - uses: ${SETUP_BUN}\n        with:\n          bun-version: 1.3.10\n          registry-url: https://r\n      - run: a\n`)).kind).toBe("ci-unhonourable");
    expect(refused(job(`      - uses: ${SETUP_BUN}\n        with:\n          bun-version-file: .bun-version\n      - run: a\n`)).message).toContain('input "bun-version-file"');
  });

  test("setup-node: an exact node-version becomes a pin; a range, check-latest, cache or an expression refuses", () => {
    const p = plan(job(`      - uses: ${SETUP_NODE}\n        with:\n          node-version: 22.22.1\n      - run: a\n`));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.pins.map((x: { tool: string; range: string }) => [x.tool, x.range])).toEqual([["node", "22.22.1"]]);
    expect(refused(job(`      - uses: ${SETUP_NODE}\n        with:\n          node-version: 22\n      - run: a\n`)).message).toContain("only an exact version");
    expect(refused(job(`      - uses: ${SETUP_NODE}\n        with:\n          node-version: 22.22.1\n          check-latest: true\n      - run: a\n`)).message).toContain("check-latest");
    expect(refused(job(`      - uses: ${SETUP_NODE}\n        with:\n          node-version: 22.22.1\n          cache: npm\n      - run: a\n`)).message).toContain('input "cache"');
    expect(refused(job(`      - uses: ${SETUP_NODE}\n        with:\n          registry-url: https://r\n      - run: a\n`)).kind).toBe("ci-unhonourable");
    expect(refused(job(`      - uses: ${SETUP_NODE}\n        with:\n          node-version: \${{ matrix.node }}\n      - run: a\n`)).message).toContain("uses a ${{ }} expression");
    expect(refused(job(`      - uses: ${SETUP_NODE}\n      - run: a\n`)).message).toContain("no node-version");
  });

  test("a mid-job setup-node: the plan annotates a step before it default, a step after it the pinned version", () => {
    const t = jobOf(
      plan(
        job(`      - run: before\n      - uses: ${SETUP_NODE}\n        with:\n          node-version: "24.21.0"\n      - run: after\n`),
      ),
    );
    expect(t.steps.map((s: { script: string; node: string }) => [s.script, s.node])).toEqual([
      ["before", "default"],
      ["after", "24.21.0"],
    ]);
  });

  test("a second setup-node: the plan annotates the steps after it with its version", () => {
    const t = jobOf(
      plan(
        job(
          `      - run: first\n      - uses: ${SETUP_NODE}\n        with:\n          node-version: "24.21.0"\n      - run: second\n      - uses: ${SETUP_NODE}\n        with:\n          node-version: "22.22.1"\n      - run: third\n`,
        ),
      ),
    );
    expect(t.steps.map((s: { script: string; node: string }) => [s.script, s.node])).toEqual([
      ["first", "default"],
      ["second", "24.21.0"],
      ["third", "22.22.1"],
    ]);
  });

  test("a job with no setup-node: the plan annotates every step default", () => {
    const t = jobOf(plan(job("      - run: a\n      - run: b\n")));
    expect(t.steps.map((s: { node: string }) => s.node)).toEqual(["default", "default"]);
  });

  test("socketdev is skipped only in firewall-free mode, which it must name", () => {
    expect(plan(job(`      - uses: ${SOCKET}\n        with:\n          mode: firewall-free\n      - run: a\n`)).ok).toBe(true);
    expect(refused(job(`      - uses: ${SOCKET}\n        with:\n          mode: patch\n      - run: a\n`)).message).toContain("firewall-free");
    expect(refused(job(`      - uses: ${SOCKET}\n      - run: a\n`)).message).toContain("no mode");
  });

  test("cache: path and key are required, a key the action rejects refuses, a miss may not fail the job", () => {
    const t = jobOf(plan(job(`      - uses: ${CACHE}\n        with:\n          path: x\n          key: linux-x\n          restore-keys: |\n            linux-\n            any-\n      - run: a\n`)));
    expect(t.skipped.map((s: { tag: string }) => s.tag)).toEqual(["v4.2.2", "v4.3.0"]);
    expect(refused(job(`      - uses: ${CACHE}\n      - run: a\n`)).message).toContain("no path");
    expect(refused(job(`      - uses: ${CACHE}\n        with:\n          path: x\n      - run: a\n`)).message).toContain("no key");
    expect(refused(job(`      - uses: ${CACHE}\n        with:\n          key: k\n      - run: a\n`)).message).toContain("no path");
    expect(refused(job(`      - uses: ${CACHE}\n        with:\n          path: x\n          key: a,b\n      - run: a\n`)).message).toContain("rejects");
    expect(refused(job(`      - uses: ${CACHE}\n        with:\n          path: x\n          key: ${"k".repeat(513)}\n      - run: a\n`)).message).toContain("rejects");
    expect(refused(job(`      - uses: ${CACHE}\n        with:\n          path: ""\n          key: k\n      - run: a\n`)).message).toContain("is empty");
    expect(refused(job(`      - uses: ${CACHE}\n        with:\n          path: x\n          key: k\n          fail-on-cache-miss: true\n      - run: a\n`)).message).toContain("fail-on-cache-miss");
    expect(plan(job(`      - uses: ${CACHE}\n        with:\n          path: x\n          key: k\n          lookup-only: true\n      - run: a\n`)).ok).toBe(true);
    expect(refused(job(`      - uses: ${CACHE}\n        with:\n          path: x\n          key: k\n          restore-keys: |\n            ok-\n            a,b\n      - run: a\n`)).message).toContain("restore-keys has a key actions/cache rejects");
  });

  test("a skipped action's inputs may carry no ${{ }} expression: the value (e.g. a cache key the real action rejects) cannot be checked", () => {
    // The counterexample: evaluates to "Linux,bad", which actions/cache rejects.
    const bad = refused(job(`      - uses: ${CACHE}\n        with:\n          path: x\n          key: \${{ runner.os }},bad\n      - run: a\n`));
    expect(bad.message).toContain("actions/cache input key uses a ${{ }} expression; a skipped action never evaluates it");
    expect(refused(job(`      - uses: ${CACHE}\n        with:\n          path: x\n          key: bun-\${{ hashFiles('bun.lock') }}\n      - run: a\n`)).message).toContain("input key uses a ${{ }}");
    expect(refused(job(`      - uses: ${CACHE}\n        with:\n          path: \${{ runner.temp }}/x\n          key: k\n      - run: a\n`)).message).toContain("input path uses a ${{ }}");
    expect(refused(job(`      - uses: ${CACHE}\n        with:\n          path: x\n          key: k\n          restore-keys: \${{ runner.os }}-\n      - run: a\n`)).message).toContain("input restore-keys uses a ${{ }}");
    expect(refused(job(`      - run: a\n      - uses: ${UPLOAD}\n        with:\n          path: \${{ runner.temp }}/out\n`)).message).toContain("input path uses a ${{ }}");
  });

  test("timeout-minutes on a skipped uses: step refuses: its failure behaviour at that limit cannot be reproduced", () => {
    const r = refused(job(`      - uses: ${CACHE}\n        timeout-minutes: 5\n        with:\n          path: x\n          key: k\n      - run: a\n`));
    expect(r.message).toContain("sets timeout-minutes on a skipped action");
    expect(refused(bare(`      - uses: ${CHECKOUT}\n        timeout-minutes: 1\n      - run: a\n`)).message).toContain("timeout-minutes on a skipped action");
    expect(plan(job("      - run: a\n        timeout-minutes: 1\n")).ok).toBe(true);
  });

  test("upload-artifact: path required; a missing file may not fail the job; the name must be valid and unique in the workflow", () => {
    expect(plan(job(`      - run: a\n      - uses: ${UPLOAD}\n        with:\n          name: out\n          path: out\n          retention-days: 7\n`)).ok).toBe(true);
    expect(refused(job(`      - run: a\n      - uses: ${UPLOAD}\n        with:\n          name: out\n`)).message).toContain("no path");
    expect(refused(job(`      - run: a\n      - uses: ${UPLOAD}\n        with:\n          path: out\n          if-no-files-found: error\n`)).message).toContain("if-no-files-found");
    expect(refused(job(`      - run: a\n      - uses: ${UPLOAD}\n        with:\n          name: a/b\n          path: out\n`)).message).toContain("rejects");
    expect(refused(job(`      - run: a\n      - uses: ${UPLOAD}\n        with:\n          name: \${{ github.sha }}\n          path: out\n`)).message).toContain("input name uses a ${{ }}");
    expect(refused(job(`      - run: a\n      - uses: ${UPLOAD}\n        with:\n          path: out\n          retention-days: 91\n`)).message).toContain("retention-days");
    expect(refused(job(`      - run: a\n      - uses: ${UPLOAD}\n        with:\n          path: out\n          compression-level: 10\n`)).message).toContain("compression-level");
    const twice = job(`      - run: a\n      - uses: ${UPLOAD}\n        with:\n          path: out\n      - uses: ${UPLOAD}\n        with:\n          path: other\n`);
    expect(refused(twice).message).toContain('uploads "artifact", a name the workflow uploads more than once');
    const elsewhere = `${job(`      - run: a\n      - uses: ${UPLOAD}\n        with:\n          name: logs\n          path: out\n`)}  other:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${UPLOAD}\n        with:\n          name: logs\n          path: x\n`;
    expect(refused(elsewhere).message).toContain('"logs"');
  });

  test("checkout is skipped only as a job's first step; a job without it, or a second checkout, refuses", () => {
    expect(refused(bare("      - run: a\n")).message).toContain("does not begin with actions/checkout");
    expect(refused(job(`      - run: a\n      - uses: ${CHECKOUT}\n`)).message).toContain("checks out again");
    expect(refused(bare(`      - run: a\n      - uses: ${CHECKOUT}\n`)).message).toContain("does not begin with actions/checkout");
  });

  test("checkout's fetch-depth shapes the fresh-clone check: 1 by default, 0 for full history, nothing else", () => {
    expect(jobOf(plan(job("      - run: a\n"))).fetchDepth).toBe(1);
    expect(jobOf(plan(bare(`      - uses: ${CHECKOUT}\n        with:\n          fetch-depth: 0\n      - run: a\n`))).fetchDepth).toBe(0);
    expect(refused(bare(`      - uses: ${CHECKOUT}\n        with:\n          fetch-depth: 2\n      - run: a\n`)).message).toContain("fetch-depth");
    expect(refused(bare(`      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: maybe\n      - run: a\n`)).message).toContain("persist-credentials");
  });

  test("a scalar run: is text, as Actions reads it; an empty or mapping run: refuses", () => {
    const t = jobOf(plan(job("      - run: true\n      - run: 42\n")));
    expect(t.steps.map((s: { script: string }) => s.script)).toEqual(["true", "42"]);
    expect(refused(job("      - run:\n")).message).toContain("not a script");
    expect(refused(job("      - run:\n          a: b\n")).message).toContain("not a script");
  });

  test("a step with both uses: and run:, or neither, refuses", () => {
    expect(refused(bare(`      - uses: ${CHECKOUT}\n        run: a\n`)).message).toContain("exactly one");
    expect(refused(job("      - name: nothing\n      - run: a\n")).message).toContain("exactly one");
  });
});

describe("bounded input", () => {
  test("a workflow over the byte limit refuses before parsing", () => {
    const big = job(`      - run: a\n        name: ${"x".repeat(MAX_WORKFLOW_BYTES)}\n`);
    expect(refused(big).message).toContain(`larger than ${MAX_WORKFLOW_BYTES} bytes`);
  });

  test("an alias bomb is refused by the node budget", () => {
    // Nine levels of ten aliases each: tiny as text, 10^9 nodes if walked naively.
    let anchors = "  l0: &a0 [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]\n";
    for (let i = 1; i <= 8; i++) anchors += `  l${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(", ")}]\n`;
    const r = refused(`bomb:\n${anchors}${job("      - run: a\n")}`);
    expect(r.kind).toBe("ci-unreadable");
    expect(r.message).toContain("YAML nodes");
  });

  test("nesting deeper than the limit refuses", () => {
    let nested = "a";
    for (let i = 0; i < 40; i++) nested = `[${nested}]`;
    expect(refused(`${job("      - run: a\n")}deep: ${nested}\n`).message).toContain("nests deeper");
  });

  test("invalid YAML and duplicate keys refuse", () => {
    expect(refused("jobs: [unclosed").kind).toBe("ci-unreadable");
    expect(refused(job("      - run: a\n", "    env:\n      A: 1\n    env:\n      A: 2\n")).kind).toBe("ci-unreadable");
  });

  test("a job with no run: step has nothing to build; a missing job lists the jobs", () => {
    expect(refused(bare(`      - uses: ${CHECKOUT}\n`)).kind).toBe("no-ci-plan");
    const r = refused(job("      - run: a\n"), "tests");
    expect(r.kind).toBe("no-ci-job");
    expect(r.message).toContain("jobs: t");
  });
});
