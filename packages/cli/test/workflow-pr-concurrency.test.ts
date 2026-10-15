/**
 * workflow-pr-concurrency.test.ts — the pull-request load cut's two behaviours,
 * checked semantically against the workflow files themselves.
 *
 * cli#643 gives `.github/workflows/test.yml` and `.github/workflows/smoke.yml` a
 * workflow-level `concurrency` block (a newer push to a PR cancels that PR's
 * pending or in-progress run; a main push keeps a group unique per run) and makes
 * `smoke.yml`'s compiled-binary matrix linux-x64 only on a pull request.
 * actionlint parses the workflow for structure, not for what its expressions
 * select: `cancel-in-progress: false`, or a matrix that keeps all four targets on
 * a pull request, still parses and still passes every other test. This file
 * evaluates the expressions the workflows actually carry and holds them to that
 * behaviour — the real workflow text, not a fixture copy of it.
 *
 * This is a detective, not a boundary: a pull request can edit the workflow and
 * this test together, and the boundary is review of the diff. What it holds is
 * that the behaviour cannot change silently.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

interface Concurrency {
  group?: string;
  "cancel-in-progress"?: string;
}

interface Workflow {
  name?: string;
  concurrency?: Concurrency;
  jobs?: Record<string, { strategy?: { matrix?: { include?: unknown } } }>;
}

const WORKFLOW_DIR = join(import.meta.dir, "..", "..", "..", ".github", "workflows");

function load(file: string): Workflow {
  return yaml.load(readFileSync(join(WORKFLOW_DIR, file), "utf8")) as Workflow;
}

interface Ctx {
  event: "pull_request" | "push";
  prNumber: number;
  runId: number;
  workflow: string;
}

/**
 * Resolve one GitHub expression for the two events this change distinguishes.
 * Only the forms these workflows carry are understood; anything else throws, so
 * an expression rewritten into a shape this test cannot read fails rather than
 * passing unread.
 */
function resolve(expr: string, ctx: Ctx): string {
  const e = expr.trim();
  const ternary = /^github\.event_name == 'pull_request' && (.+?) \|\| (.+)$/.exec(e);
  if (ternary) {
    return resolve(ctx.event === "pull_request" ? ternary[1] : ternary[2], ctx);
  }
  const fromJson = /^fromJSON\('(.*)'\)$/.exec(e);
  if (fromJson) return fromJson[1];
  if (e === "github.run_id") return String(ctx.runId);
  if (e === "github.workflow") return ctx.workflow;
  const prFormat = /^format\('pr-\{0\}', github\.event\.pull_request\.number\)$/.exec(e);
  if (prFormat) return `pr-${ctx.prNumber}`;
  if (e === "github.event_name == 'pull_request'") {
    return ctx.event === "pull_request" ? "true" : "false";
  }
  throw new Error(`workflow expression not understood by this test: ${e}`);
}

/** Resolve a `${{ … }}`-bearing string (the concurrency group or its flag). */
function interpolate(value: string, ctx: Ctx): string {
  const re = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;
  let out = "";
  let last = 0;
  for (let m = re.exec(value); m !== null; m = re.exec(value)) {
    out += value.slice(last, m.index) + resolve(m[1], ctx);
    last = re.lastIndex;
  }
  return out + value.slice(last);
}

function matrixTargets(file: string, ctx: Ctx): string[] {
  const include = load(file).jobs?.smoke?.strategy?.matrix?.include;
  expect(include, `${file}: the smoke matrix include is present`).toBeTruthy();
  const parsed = JSON.parse(interpolate(String(include), ctx)) as Array<{ target: string }>;
  return parsed.map((m) => m.target);
}

function prCtx(file: string): Ctx {
  return { event: "pull_request", prNumber: 42, runId: 7001, workflow: load(file).name ?? "" };
}

function pushCtx(file: string): Ctx {
  return { event: "push", prNumber: 42, runId: 7001, workflow: load(file).name ?? "" };
}

describe("PR load cut — smoke matrix selection (cli#643)", () => {
  test("a pull request smokes linux-x64 alone", () => {
    expect(matrixTargets("smoke.yml", prCtx("smoke.yml"))).toEqual(["linux-x64"]);
  });

  test("a push to main smokes all four targets", () => {
    expect(matrixTargets("smoke.yml", pushCtx("smoke.yml"))).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
    ]);
  });
});

describe("PR load cut — concurrency-group separation (cli#643)", () => {
  for (const file of ["test.yml", "smoke.yml"]) {
    test(`${file}: a pull request cancels its own run; a main push is grouped per run`, () => {
      const wf = load(file);
      const pr = prCtx(file);
      const push = pushCtx(file);
      const group = wf.concurrency?.group;
      const cancel = wf.concurrency?.["cancel-in-progress"];
      expect(group, `${file}: a concurrency group is present`).toBeTruthy();
      expect(cancel, `${file}: a cancel-in-progress flag is present`).toBeTruthy();

      expect(interpolate(group as string, pr)).toBe(`${wf.name}-pr-42`);
      expect(interpolate(group as string, push)).toBe(`${wf.name}-7001`);
      // The two events never share a group, so a main push cannot cancel a PR's
      // run (or the reverse).
      expect(interpolate(group as string, pr)).not.toBe(interpolate(group as string, push));

      expect(interpolate(cancel as string, pr)).toBe("true");
      expect(interpolate(cancel as string, push)).toBe("false");
    });
  }
});
