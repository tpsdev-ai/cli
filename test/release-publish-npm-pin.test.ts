import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { readNpmPin } from "../scripts/check-npm-pin-release-age.mjs";

const REPO = join(import.meta.dir, "..");
const UPGRADE = "Upgrade npm to an OIDC/staging-capable version";
const CHECK = "bun --no-install scripts/check-npm-pin-release-age.mjs";
type Step = { name?: string; run?: string; uses?: string; if?: unknown; "continue-on-error"?: unknown };
type Job = { steps: Step[]; if?: unknown; "continue-on-error"?: unknown };

function jobs(file: string): Record<string, Job> {
  return (load(readFileSync(join(REPO, ".github/workflows", file), "utf8")) as { jobs: Record<string, Job> }).jobs;
}

function assertGates(job: Job, release: boolean) {
  const checks = job.steps.filter((step) => step.run?.trim() === CHECK);
  expect(checks, "expected one npm pin release-age step").toHaveLength(1);
  const check = checks[0];
  const targets = release ? [check, job.steps.find((step) => step.name === UPGRADE)] : [check];
  for (const target of [job, ...targets]) {
    expect(target).toBeDefined();
    expect(target).not.toHaveProperty("if");
    expect(target).not.toHaveProperty("continue-on-error");
  }
  const index = job.steps.indexOf(check);
  expect(job.steps.slice(0, index).some((step) => step.uses?.startsWith("oven-sh/setup-bun@"))).toBe(true);
  if (release) expect(job.steps[index + 1]?.name, "age check must immediately precede npm upgrade").toBe(UPGRADE);
}

test("publish-packages checks npm age immediately before upgrading without a condition", () => {
  assertGates(jobs("release.yml")["publish-packages"], true);
  expect(readNpmPin(readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8"))).toBe("11.21.1");
});

test("publish-packages prints interruption recovery before staging", () => {
  const job = jobs("release.yml")["publish-packages"];
  const stage = job.steps.findIndex((step) => step.name === "Stage-publish all packages (OIDC trusted publishing)");
  expect(stage).toBeGreaterThan(0);
  const guidance = job.steps[stage - 1];
  expect(guidance.name).toBe("Stage interruption recovery");
  expect(guidance).not.toHaveProperty("if");
  expect(guidance).not.toHaveProperty("continue-on-error");
  for (const command of ["npm stage list", "npm stage view <stage-id>", "npm stage reject <stage-id>"]) {
    expect(guidance.run).toContain(command);
  }
  expect(guidance.run).toContain("approve them and re-run");
});

test("CI build runs the npm pin age check alongside the dependency age check", () => {
  const job = jobs("test.yml").build;
  assertGates(job, false);
  expect(job.steps.some((step) => step.run === "node scripts/check-dep-ages.mjs --ci")).toBe(true);
});

test.each(["if", "continue-on-error"] as const)("the structure guard refuses %s on the check or upgrade", (key) => {
  for (const name of [CHECK, UPGRADE]) {
    const job = jobs("release.yml")["publish-packages"];
    const step = job.steps.find((step) => step.run?.trim() === name || step.name === name);
    expect(step).toBeDefined();
    if (!step) throw new Error("missing fixture step");
    step[key] = false;
    expect(() => assertGates(job, true)).toThrow();
  }
});

test.each(["removed", "after upgrade"])("the structure guard refuses an age check %s", (mutation) => {
  const job = jobs("release.yml")["publish-packages"];
  const index = job.steps.findIndex((step) => step.run?.trim() === CHECK);
  expect(index).toBeGreaterThanOrEqual(0);
  const [check] = job.steps.splice(index, 1);
  if (mutation === "after upgrade") job.steps.splice(index + 1, 0, check);
  expect(() => assertGates(job, true)).toThrow();
});

// This case runs the real npm CLI. The Unit lane (setup-node) has npm; the Docker
// Integration image does not, so there it is skipped by name rather than failed.
const npmProbe = spawnSync("npm", ["--version"], { encoding: "utf8", timeout: 10000 });
const npmAvailable = npmProbe.error === undefined && npmProbe.status === 0;

test.skipIf(!npmAvailable)("real npm uses the workflow registry over project and environment settings (needs npm on PATH)", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-npm-registry-"));
  try {
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home);
    mkdirSync(project);
    writeFileSync(join(project, ".npmrc"), "registry=https://registry.example.invalid/\n");
    const run = jobs("release.yml")["publish-packages"].steps.find((step) => step.name === UPGRADE)?.run;
    expect(run).toBeDefined();
    const registryFlag = run?.trim().split(/\s+/).find((arg) => arg.startsWith("--registry="));
    expect(registryFlag).toBeDefined();
    const result = spawnSync("npm", ["config", "get", "registry", registryFlag as string], {
      cwd: project,
      env: {
        PATH: process.env.PATH, HOME: home,
        npm_config_registry: "https://other.example.invalid/",
        npm_config_userconfig: join(home, ".npmrc"),
        npm_config_globalconfig: join(root, "global.npmrc"),
        npm_config_update_notifier: "false",
      },
      encoding: "utf8", timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("https://registry.npmjs.org/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
