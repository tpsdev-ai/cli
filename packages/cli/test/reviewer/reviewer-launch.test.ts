/**
 * reviewer-launch.test.ts — the trusted launcher's decision functions and the
 * build-arg composer (cli#425 acceptance A2, A3). Each control is asserted so
 * that removing it fails the test.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArgsFor, loadTable } from "../../../../scripts/reviewer/build-reviewer-image.mjs";
import {
  deriveCiPlan,
  hermeticEnv,
  verifyArtifact,
  verifyRuntime,
} from "../../../../scripts/reviewer/reviewer-launch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const table = loadTable(resolve(repo, "docker", "reviewer", "runtime-matrix.json"));

describe("A3 — hermetic environment", () => {
  test("forces container-local HOME/tmp/caches regardless of the host", () => {
    const env = hermeticEnv({ HOME: "/root", TMPDIR: "/host/tmp", npm_config_cache: "/host/npm", PATH: "/usr/bin" });
    expect(env.HOME).toBe("/home/reviewer");
    expect(env.USERPROFILE).toBe("/home/reviewer");
    expect(env.TMPDIR).toBe("/tmp/review");
    expect(env.npm_config_cache).toBe("/tmp/review/npm-cache");
    expect(env.BUN_INSTALL_CACHE_DIR).toBe("/tmp/review/bun-cache");
    expect(env.XDG_CACHE_HOME).toBe("/tmp/review/.cache");
    // Non-isolation values pass through.
    expect(env.PATH).toBe("/usr/bin");
  });

  test("drops host credential-shaped variables", () => {
    const env = hermeticEnv({ GH_TOKEN: "x", GITHUB_TOKEN: "y", SSH_AUTH_SOCK: "/tmp/sock", KEEP: "1" });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.KEEP).toBe("1");
  });
});

describe("A2 — runtime verification", () => {
  const image = table.images[0];

  test("accepts actual versions matching the selected entry and requirements", () => {
    const r = verifyRuntime({ image, actual: { node: image.node, bun: image.bun }, requirements: { node: ">=22" } });
    expect(r.ok).toBe(true);
  });

  test("stops on a node version mismatch", () => {
    const r = verifyRuntime({ image, actual: { node: "24.21.0", bun: image.bun } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe("version-mismatch");
  });

  test("stops when the actual runtime does not satisfy the repository requirement", () => {
    const r = verifyRuntime({ image, actual: { node: image.node, bun: image.bun }, requirements: { node: ">=25" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe("unsupported");
  });

  test("checksum verification fails closed", () => {
    expect(verifyArtifact({ sha256: "a".repeat(64) }, "a".repeat(64)).ok).toBe(true);
    const bad = verifyArtifact({ sha256: "a".repeat(64) }, "b".repeat(64));
    expect(bad.ok).toBe(false);
  });
});

describe("A2 — CI-equivalent plan", () => {
  test("derives the repository's OWN frozen install, build and test commands", () => {
    const yml = readFileSync(resolve(repo, ".github", "workflows", "test.yml"), "utf8");
    const plan = deriveCiPlan([{ file: ".github/workflows/test.yml", text: yml }]);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.steps).toEqual(["bun install --frozen-lockfile", "bun run build", "bun run test"]);
    }
  });

  test("refuses when a stage is missing rather than substituting a blanket command", () => {
    const plan = deriveCiPlan([{ file: "ci.yml", text: "jobs:\n  a:\n    steps:\n      - run: echo hi" }]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.refusal.kind).toBe("no-ci-plan");
  });

  test("refuses an unfrozen install", () => {
    const text =
      "jobs:\n  a:\n    steps:\n      - run: bun install\n      - run: bun run build\n      - run: bun run test\n";
    const plan = deriveCiPlan([{ file: "ci.yml", text }]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.refusal.kind).toBe("unfrozen-install");
  });
});

describe("A2 — build args come from the table", () => {
  test("passes the exact versions and checksums for the image", () => {
    const image = table.images[0];
    const args = buildArgsFor(image, table);
    const joined = args.join(" ");
    expect(joined).toContain(`BASE_REF=${table.base.image}@${table.base.digest}`);
    expect(joined).toContain(`NODE_VERSION=${image.node}`);
    expect(joined).toContain(`NODE_SHA256=${table.artifacts.node[image.node].sha256}`);
    expect(joined).toContain(`BUN_SHA256=${table.artifacts.bun[image.bun].sha256}`);
    expect(joined).toContain(`GH_SHA256=${table.artifacts.gh[image.gh].sha256}`);
  });

  test("refuses an image pinning a runtime absent from the table", () => {
    expect(() => buildArgsFor({ id: "x", node: "99.0.0", bun: "1.3.10", gh: "2.101.0" }, table)).toThrow();
  });
});
