/**
 * ci-job.test.ts — the review build's step plan comes from ONE named job of the
 * reviewed commit's workflow, parsed as YAML (cli#425 section A: CI-equivalent
 * install/build/test; no blanket command, no dropped stage, no skipped stage
 * counted as evidence). What the planner runs, skips and refuses is asserted
 * case by case.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { condition, planJob } from "../../../../scripts/reviewer/ci-job.mjs";
import { RESERVED_ENV_KEYS } from "../../../../scripts/reviewer/reviewer-launch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");

function plan(workflowText: string, jobId = "t") {
  return planJob({ workflowText, workflowFile: ".github/workflows/ci.yml", jobId, reservedEnvKeys: RESERVED_ENV_KEYS });
}

function refused(workflowText: string, jobId = "t") {
  const p = plan(workflowText, jobId);
  expect(p.ok).toBe(false);
  if (p.ok) throw new Error("expected a refusal");
  return p.refusal;
}

/** A one-job workflow around the given step lines (already indented as list items). */
const job = (steps: string, extra = "") => `on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;

describe("this repository's test job", () => {
  const p = planJob({
    workflowText: readFileSync(resolve(repo, ".github", "workflows", "test.yml"), "utf8"),
    workflowFile: ".github/workflows/test.yml",
    jobId: "test",
    reservedEnvKeys: RESERVED_ENV_KEYS,
  });

  test("every run: step, in order, in its working directory — including the plugin launcher and the report guard", () => {
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.steps.map((s) => [s.index, s.workingDirectory, s.always])).toEqual([
      [4, ".", false],
      [5, ".", false],
      [6, ".", false],
      [7, ".", false],
      [8, "plugins/openclaw-tps-mail", false],
      [9, ".", true],
    ]);
    expect(p.steps[0].script).toBe("sfw bun install --frozen-lockfile");
    expect(p.steps[1].script).toBe("bun run build");
    expect(p.steps[3].script).toBe("bun run test");
    expect(p.steps[4].script).toContain("npm ci --ignore-scripts");
    expect(p.steps[4].script).toContain("npm run build");
    expect(p.steps[4].script).toContain("bun run test");
    expect(p.steps[5].script).toBe("node scripts/check-test-reports.mjs");
  });

  test("the setup actions are skipped by name, their pins kept, and sfw is shimmed", () => {
    if (!p.ok) throw new Error("plan refused");
    expect(p.skipped.map((s) => s.uses.split("@")[0])).toEqual(["actions/checkout", "oven-sh/setup-bun", "socketdev/action"]);
    expect(p.pins).toEqual([{ tool: "bun", range: "1.3.10", source: '.github/workflows/test.yml job "test" step 2 bun-version' }]);
    expect(p.shims).toEqual(["sfw"]);
  });
});

describe("the host names the job; the planner never picks one", () => {
  const decoy = `on: push
jobs:
  decoy:
    if: false
    runs-on: ubuntu-latest
    steps:
      - run: bun install --frozen-lockfile && echo DECOY
  real:
    runs-on: ubuntu-latest
    steps:
      - run: bun install --frozen-lockfile
      - run: bun run build
      - run: |
          # run: bun run not-a-step
          bun run test
`;

  test("the named job's steps, not the first job's and not text inside a script", () => {
    const p = plan(decoy, "real");
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.steps.map((s) => s.script.trim())).toEqual([
        "bun install --frozen-lockfile",
        "bun run build",
        "# run: bun run not-a-step\nbun run test",
      ]);
    }
  });

  test("a job CI never runs (if: false) refuses", () => {
    const r = refused(decoy, "decoy");
    expect(r.kind).toBe("ci-unhonourable");
    expect(r.message).toContain("if: false");
  });

  test("a missing job refuses and lists the jobs", () => {
    const r = refused(decoy, "tests");
    expect(r.kind).toBe("no-ci-job");
    expect(r.message).toContain("jobs: decoy, real");
  });

  test("invalid YAML and duplicate keys refuse", () => {
    expect(refused("jobs: [unclosed").kind).toBe("ci-unreadable");
    expect(refused(job("      - run: a\n", "    env:\n      A: 1\n    env:\n      A: 2\n")).kind).toBe("ci-unreadable");
  });

  test("a job with no run: step has nothing to build", () => {
    expect(refused(job("      - uses: actions/checkout@v4\n")).kind).toBe("no-ci-plan");
  });
});

describe("working directories, shells and env", () => {
  test("a step's working-directory is kept; defaults.run.working-directory applies", () => {
    const p = plan(
      job("      - run: bun run test\n        working-directory: packages/x\n      - run: bun run build\n", "    defaults:\n      run:\n        working-directory: ./packages/y/\n"),
    );
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.steps.map((s) => s.workingDirectory)).toEqual(["packages/x", "packages/y"]);
  });

  test("a working directory outside the workspace refuses", () => {
    expect(refused(job("      - run: a\n        working-directory: /etc\n")).message).toContain("leaves the workspace");
    expect(refused(job("      - run: a\n        working-directory: packages/../../x\n")).message).toContain("leaves the workspace");
  });

  test("only bash is reproduced", () => {
    expect(plan(job("      - run: a\n        shell: bash\n")).ok).toBe(true);
    expect(refused(job("      - run: print(1)\n        shell: python\n")).message).toContain("only bash");
    expect(refused(job("      - run: a\n", "    defaults:\n      run:\n        shell: sh\n")).message).toContain("only bash");
  });

  test("plain env is honoured, workflow < job < step", () => {
    const p = plan(
      `env:\n  A: wf\n  B: wf\n  N: 3\njobs:\n  t:\n    runs-on: ubuntu-24.04\n    env:\n      B: job\n      C: job\n    steps:\n      - run: a\n        env:\n          C: step\n`,
    );
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.steps[0].env).toEqual({ A: "wf", B: "job", N: "3", C: "step" });
  });

  test("env the launcher owns, or that needs an expression, refuses", () => {
    for (const key of ["HOME", "TMPDIR", "PATH", "npm_config_cache", "BUN_INSTALL_CACHE_DIR", "CI"]) {
      expect(refused(job(`      - run: a\n        env:\n          ${key}: /x\n`)).message).toContain(`sets ${key}`);
    }
    expect(refused(job("      - run: a\n        env:\n          T: ${{ secrets.T }}\n")).message).toContain("expression");
  });

  test("an expression in a script refuses", () => {
    expect(refused(job("      - run: echo ${{ github.sha }}\n")).message).toContain("expression");
  });
});

describe("if:, continue-on-error and job keys", () => {
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
    const p = plan(job("      - run: a\n      - run: b\n        if: always()\n"));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.steps.map((s) => s.always)).toEqual([false, true]);
  });

  test("continue-on-error would count a failure as success: refused on steps and jobs", () => {
    expect(refused(job("      - run: a\n        continue-on-error: true\n")).message).toContain("continue-on-error");
    expect(refused(job("      - run: a\n", "    continue-on-error: true\n")).message).toContain("continue-on-error");
    expect(plan(job("      - run: a\n        continue-on-error: false\n")).ok).toBe(true);
  });

  test("strategy, container, services, environment and reusable workflows refuse", () => {
    expect(refused(job("      - run: a\n", "    strategy:\n      matrix:\n        n: [22, 24]\n")).message).toContain('"strategy"');
    expect(refused(job("      - run: a\n", "    container: node:22\n")).message).toContain('"container"');
    expect(refused(job("      - run: a\n", "    services:\n      db:\n        image: pg\n")).message).toContain('"services"');
    expect(refused(job("      - run: a\n", "    environment: prod\n")).message).toContain('"environment"');
    expect(refused("jobs:\n  t:\n    uses: org/repo/.github/workflows/x.yml@main\n").message).toContain('"uses"');
  });

  test("runs-on must be an x86_64 ubuntu runner", () => {
    expect(plan(job("      - run: a\n").replace("ubuntu-latest", "ubuntu-24.04")).ok).toBe(true);
    for (const runner of ["macos-14", "ubuntu-24.04-arm", "windows-latest", "${{ matrix.os }}", "self-hosted"]) {
      expect(refused(job("      - run: a\n").replace("ubuntu-latest", JSON.stringify(runner))).message).toContain("runs-on");
    }
  });

  test("ignored job keys are accepted: name, needs, permissions, concurrency, outputs, timeout-minutes", () => {
    const extra = "    name: T\n    needs: build\n    permissions: {}\n    concurrency: x\n    outputs:\n      o: v\n    timeout-minutes: 5\n";
    expect(plan(job("      - run: a\n        timeout-minutes: 1\n", extra)).ok).toBe(true);
  });
});

describe("uses: — skipped by name or refused", () => {
  test("an action the launcher does not know refuses, naming it", () => {
    const r = refused(job("      - uses: actions/github-script@v7\n      - run: a\n"));
    expect(r.kind).toBe("ci-unhonourable");
    expect(r.message).toContain("actions/github-script@v7");
    expect(refused(job("      - uses: ./.github/actions/setup\n      - run: a\n")).kind).toBe("ci-unhonourable");
    expect(refused(job("      - uses: docker://alpine:3\n      - run: a\n")).kind).toBe("ci-unhonourable");
    const unpinned = refused(job("      - uses: actions/checkout\n      - run: a\n"));
    expect(unpinned.message).toContain('uses "actions/checkout", which the review launcher cannot reproduce');
  });

  test("a step key the launcher does not know refuses", () => {
    expect(refused(job("      - run: a\n        entrypoint: /bin/x\n")).message).toContain('uses "entrypoint"');
  });

  test("checkout is skipped only with inputs that do not change the tree", () => {
    expect(plan(job("      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n          fetch-depth: 0\n      - run: a\n")).ok).toBe(true);
    for (const input of ["ref: other", "submodules: true", "lfs: true", "repository: x/y", "token: t"]) {
      expect(refused(job(`      - uses: actions/checkout@v4\n        with:\n          ${input}\n      - run: a\n`)).message).toContain(
        `the input "${input.split(":")[0]}"`,
      );
    }
  });

  test("setup-bun: bun-version becomes a pin; no version, or a registry, refuses", () => {
    const p = plan(job('      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: "1.3.10"\n      - run: a\n'));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.pins).toEqual([{ tool: "bun", range: "1.3.10", source: '.github/workflows/ci.yml job "t" step 1 bun-version' }]);
    expect(refused(job("      - uses: oven-sh/setup-bun@v2\n      - run: a\n")).kind).toBe("ambiguous");
    expect(refused(job("      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: 1.3.10\n          registry-url: https://r\n      - run: a\n")).kind).toBe(
      "ci-unhonourable",
    );
    expect(plan(job("      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version-file: .bun-version\n      - run: a\n")).ok).toBe(true);
    expect(refused(job("      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version-file: tools/bun.txt\n      - run: a\n")).kind).toBe(
      "ci-unhonourable",
    );
  });

  test("setup-node: node-version becomes a pin; check-latest, a registry or an expression refuses", () => {
    const p = plan(job("      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: npm\n      - run: a\n"));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.pins.map((x) => [x.tool, x.range])).toEqual([["node", "22"]]);
    expect(refused(job("      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          check-latest: true\n      - run: a\n")).kind).toBe(
      "ambiguous",
    );
    expect(refused(job("      - uses: actions/setup-node@v4\n        with:\n          registry-url: https://r\n      - run: a\n")).kind).toBe(
      "ci-unhonourable",
    );
    expect(refused(job("      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n      - run: a\n")).message).toContain(
      "expression",
    );
  });

  test("cache and upload-artifact are skipped whole, expressions and all", () => {
    const p = plan(
      job("      - uses: actions/cache@v4\n        with:\n          key: ${{ runner.os }}-x\n      - run: a\n      - uses: actions/upload-artifact@v4\n        with:\n          path: out\n"),
    );
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.skipped.map((s) => s.uses)).toEqual(["actions/cache@v4", "actions/upload-artifact@v4"]);
  });

  test("a scalar run: is text, as Actions reads it; an empty or mapping run: refuses", () => {
    const p = plan(job("      - run: true\n      - run: 42\n"));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.steps.map((s) => s.script)).toEqual(["true", "42"]);
    expect(refused(job("      - run:\n")).message).toContain("not a script");
    expect(refused(job("      - run:\n          a: b\n")).message).toContain("not a script");
  });

  test("a step with both uses: and run:, or neither, refuses", () => {
    expect(refused(job("      - uses: actions/checkout@v4\n        run: a\n")).message).toContain("exactly one");
    expect(refused(job("      - name: nothing\n      - run: a\n")).message).toContain("exactly one");
  });
});
