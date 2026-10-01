import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe("root dependency audit (cli#390)", () => {
  it("`bun run audit` runs exactly what CI's Dependency Audit runs", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/test.yml"), "utf8");
    expect(pkg.scripts.audit).toBe("bun audit");
    expect(workflow).toContain(`run: ${pkg.scripts.audit}`);
  });

  it("every override of a root direct dependency has the identical spec", () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const mismatched = Object.entries(pkg.overrides ?? {})
      .filter(([name, spec]) => name in deps && deps[name] !== spec)
      .map(([name, spec]) => `${name}: dependency ${deps[name]} vs override ${spec}`);
    expect(mismatched).toEqual([]);
  });
});
