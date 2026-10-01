import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe("root dependency audit (cli#390)", () => {
  it("`bun run audit` runs exactly the command of CI's live Dependency Audit step", () => {
    const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/test.yml"), "utf8")) as {
      jobs: Record<string, { if?: unknown; "continue-on-error"?: unknown; steps: Array<Record<string, unknown>> }>;
    };
    const job = workflow.jobs.audit;
    expect(job).toBeDefined();
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    const steps = job.steps.filter((s) => s.run === pkg.scripts.audit);
    expect(pkg.scripts.audit).toBe("bun audit");
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBeUndefined();
    expect(steps[0]["continue-on-error"]).toBeUndefined();
  });

  it("every override of a root direct dependency has the identical spec", () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const mismatched = Object.entries(pkg.overrides ?? {})
      .filter(([name, spec]) => name in deps && deps[name] !== spec)
      .map(([name, spec]) => `${name}: dependency ${deps[name]} vs override ${spec}`);
    expect(mismatched).toEqual([]);
  });
});
