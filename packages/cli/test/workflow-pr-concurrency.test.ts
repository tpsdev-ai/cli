/**
 * Check workflow concurrency and, when the smoke workflow starts, its matrix.
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
 * Handles the current patterns and `github.workflow` for regression detection.
 * Throws on unsupported patterns.
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
  test("a pull request smokes linux-x64 alone when the smoke workflow starts", () => {
    expect(matrixTargets("smoke.yml", prCtx("smoke.yml"))).toEqual(["linux-x64"]);
  });

  test("a push to main smokes all four targets when the smoke workflow starts", () => {
    expect(matrixTargets("smoke.yml", pushCtx("smoke.yml"))).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
    ]);
  });
});

describe("PR load cut — concurrency-group separation (cli#643)", () => {
  for (const [file, prefix, otherFile] of [
    ["test.yml", "test", "smoke.yml"],
    ["smoke.yml", "smoke", "test.yml"],
  ]) {
    test(`${file}: PR keys survive workflow renames and differ from main keys`, () => {
      const wf = load(file);
      const pr = prCtx(file);
      const nextPr = { ...pr, runId: pr.runId + 1, workflow: `${pr.workflow} renamed` };
      const push = pushCtx(file);
      const group = wf.concurrency?.group;
      const cancel = wf.concurrency?.["cancel-in-progress"];
      expect(group, `${file}: a concurrency group is present`).toBeTruthy();
      expect(cancel, `${file}: a cancel-in-progress flag is present`).toBeTruthy();

      const prKey = interpolate(group as string, pr);
      const mainKey = interpolate(group as string, push);
      const otherGroup = load(otherFile).concurrency?.group;
      expect(otherGroup, `${otherFile}: a concurrency group is present`).toBeTruthy();
      const otherPrKey = interpolate(otherGroup as string, prCtx(otherFile));

      expect(prKey).toBe(`${prefix}-pr-42`);
      expect(interpolate(group as string, nextPr)).toBe(prKey);
      expect(prKey).not.toBe(otherPrKey);
      expect(mainKey).toBe(`${prefix}-7001`);
      expect(mainKey).not.toBe(prKey);
      expect(mainKey).not.toBe(otherPrKey);
      expect(interpolate(group as string, { ...push, runId: push.runId + 1 })).not.toBe(mainKey);

      expect(interpolate(cancel as string, pr)).toBe("true");
      expect(interpolate(cancel as string, nextPr)).toBe("true");
      expect(interpolate(cancel as string, push)).toBe("false");
    });
  }
});
