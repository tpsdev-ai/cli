/**
 * resolve-runtime.test.ts — the trusted runtime matrix and the requirement
 * resolver (cli#425 acceptance A2). Every refusal kind is exercised by name, the
 * range matcher is pinned to npm semver's answers, and the matrix's integrity
 * (platform, base, the launcher's js-yaml pin) is asserted against the files it
 * must agree with.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planJob } from "../../../../scripts/reviewer/ci-job.mjs";
import { isSemverRange, resolveRuntime, satisfiesRange } from "../../../../scripts/reviewer/resolve-runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const table = JSON.parse(readFileSync(resolve(repo, "docker", "reviewer", "runtime-matrix.json"), "utf8"));
const dockerfile = readFileSync(resolve(repo, "docker", "reviewer", "Dockerfile"), "utf8");

function refusal(r: ReturnType<typeof resolveRuntime>) {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected a refusal");
  return r.refusal;
}

describe("A2 — the trusted runtime table is self-consistent", () => {
  test("every matrix image pins runtimes present in the table, with 64-hex checksums and exact versions", () => {
    expect(table.images.length).toBeGreaterThan(0);
    for (const img of table.images) {
      expect(img.platform).toBe("linux/amd64");
      for (const tool of ["node", "bun", "gh"]) {
        expect(img[tool]).toMatch(/^\d+\.\d+\.\d+$/);
        const entry = table.artifacts[tool]?.[img[tool]];
        expect(entry).toBeDefined();
        expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.url.startsWith("https://")).toBe(true);
      }
    }
  });

  test("the base is digest-pinned, linux/amd64, labelled as what it is, and the Dockerfile agrees", () => {
    expect(table.base.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(table.base.platform).toBe("linux/amd64");
    expect(table.base.family).not.toContain("openclaw");
    expect(table.base.image).toBe("debian:bookworm-slim");
    expect(dockerfile).toContain(`${table.base.image}@${table.base.digest}`);
    expect(dockerfile).toContain("FROM --platform=linux/amd64 ${BASE_REF}");
  });

  test("the launcher's js-yaml is the version and integrity bun.lock pins", () => {
    const lock = readFileSync(resolve(repo, "bun.lock"), "utf8");
    const m = /^\s*"js-yaml": \["js-yaml@([^"]+)", .*"(sha512-[A-Za-z0-9+/=]+)"\],?$/m.exec(lock);
    expect(m).not.toBeNull();
    const dep = table.launcherDeps["js-yaml"];
    expect(dep.version).toBe(m?.[1]);
    expect(dep.integrity).toBe(m?.[2]);
    expect(dep.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dep.url).toBe(`https://registry.npmjs.org/js-yaml/-/js-yaml-${dep.version}.tgz`);
  });
});

describe("A2 — requirement resolution", () => {
  test("selects the single matching image from packageManager, engines and CI pins", () => {
    const r = resolveRuntime({
      table,
      manifest: { packageManager: "bun@1.3.10", engines: { node: ">=22 <24" } },
      ciConstraints: [{ tool: "bun", range: "1.3.10", source: "ci.yml job review bun-version" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.id).toBe("reviewer-node22-bun1310");
      expect(r.requirements.map((c) => c.source)).toEqual(["engines.node", "packageManager", "ci.yml job review bun-version"]);
    }
  });

  test("this repository resolves to exactly one image from its own package.json and its test job's pins", () => {
    const manifest = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8"));
    const plan = planJob({
      workflowText: readFileSync(resolve(repo, ".github", "workflows", "test.yml"), "utf8"),
      workflowFile: ".github/workflows/test.yml",
      jobId: "test",
      baseBranch: "main",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const r = resolveRuntime({ table, manifest, runtimeFiles: {}, ciConstraints: plan.pins });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.id).toBe("reviewer-node22-bun1310");
  });

  test("a runtime outside the matrix refuses and NAMES the missing image by its requirements", () => {
    const withBun = refusal(resolveRuntime({ table, manifest: { packageManager: "bun@1.3.10", engines: { node: ">=25" } } }));
    expect(withBun.kind).toBe("out-of-matrix");
    expect(withBun.message).toContain("missing image: node >=25 with bun 1.3.10");
    expect(withBun.message).toContain("required by engines.node");
    expect(withBun.message).not.toContain("the missing image is named");

    const nodeOnly = refusal(resolveRuntime({ table, manifest: { engines: { node: ">=25" } } }));
    expect(nodeOnly.kind).toBe("out-of-matrix");
    expect(nodeOnly.message).toContain("missing image: node >=25 (");
  });

  test("two individually trusted runtimes no image combines are a missing image", () => {
    const t = {
      ...table,
      artifacts: { ...table.artifacts, bun: { ...table.artifacts.bun, "1.2.0": { url: "https://x", sha256: "0".repeat(64) } } },
      images: [
        { id: "a", platform: "linux/amd64", node: "22.22.1", bun: "1.2.0", gh: "2.101.0" },
        { id: "b", platform: "linux/amd64", node: "24.21.0", bun: "1.3.10", gh: "2.101.0" },
      ],
    };
    const r = refusal(resolveRuntime({ table: t, manifest: { packageManager: "bun@1.2.0", engines: { node: "24.21.0" } } }));
    expect(r.kind).toBe("out-of-matrix");
    expect(r.message).toContain("missing image: node 24.21.0 with bun 1.2.0");
  });

  test("a packageManager the matrix cannot provide is a named missing image", () => {
    const r = refusal(resolveRuntime({ table, manifest: { packageManager: "pnpm@9.0.0" } }));
    expect(r.kind).toBe("out-of-matrix");
    expect(r.message).toContain("missing image: pnpm 9.0.0");
  });

  test("a range matching two trusted versions is ambiguous", () => {
    expect(refusal(resolveRuntime({ table, manifest: { engines: { node: ">=22" } } })).kind).toBe("ambiguous");
  });

  test("a bun-only repository matches both images: image-level ambiguity refuses", () => {
    const r = refusal(resolveRuntime({ table, manifest: { packageManager: "bun@1.3.10" } }));
    expect(r.kind).toBe("ambiguous");
    expect(r.message).toContain("matches more than one image (reviewer-node22-bun1310, reviewer-node24-bun1310)");
  });

  test("mutually unsatisfiable requirements conflict", () => {
    const r = refusal(resolveRuntime({ table, manifest: { engines: { node: "22.22.1" } }, runtimeFiles: { ".nvmrc": "24.21.0" } }));
    expect(r.kind).toBe("conflicting");
  });

  test("no requirement at all is ambiguous (never a default runtime)", () => {
    expect(refusal(resolveRuntime({ table, manifest: {} })).kind).toBe("ambiguous");
  });

  test("floating aliases and dist-tags refuse: lts/*, latest, a CI pin of latest", () => {
    expect(refusal(resolveRuntime({ table, manifest: {}, runtimeFiles: { ".nvmrc": "lts/*" } })).kind).toBe("ambiguous");
    const latest = refusal(
      resolveRuntime({ table, manifest: {}, runtimeFiles: { ".bun-version": "latest", ".nvmrc": "22.22.1" } }),
    );
    expect(latest.kind).toBe("ambiguous");
    expect(latest.message).toContain('"latest"');
    const ciLatest = refusal(
      resolveRuntime({
        table,
        manifest: { engines: { node: "22.22.1" } },
        ciConstraints: [{ tool: "bun", range: "latest", source: "ci.yml bun-version" }],
      }),
    );
    expect(ciLatest.kind).toBe("ambiguous");
  });

  test("a prerelease pin is a different version: it never selects the release", () => {
    const canary = refusal(
      resolveRuntime({ table, manifest: {}, runtimeFiles: { ".bun-version": "1.3.10-canary.7", ".nvmrc": "22.22.1" } }),
    );
    expect(canary.kind).toBe("out-of-matrix");
    expect(canary.message).toContain("missing image: node 22.22.1 with bun 1.3.10-canary.7");
    const beta = refusal(
      resolveRuntime({ table, manifest: { packageManager: "bun@1.3.10-beta.1" }, runtimeFiles: { ".nvmrc": "24.21.0" } }),
    );
    expect(beta.kind).toBe("out-of-matrix");
  });

  test("partial comparators follow npm semver: >22 excludes 22.x, <=24 includes 24.x", () => {
    const gt = refusal(
      resolveRuntime({ table, manifest: { packageManager: "bun@1.3.10", engines: { node: ">22" } }, runtimeFiles: { ".nvmrc": "22.22.1" } }),
    );
    expect(gt.kind).toBe("conflicting");
    const both = refusal(resolveRuntime({ table, manifest: { packageManager: "bun@1.3.10", engines: { node: ">=22 <=24" } } }));
    expect(both.kind).toBe("ambiguous");
    const r = resolveRuntime({ table, manifest: { packageManager: "bun@1.3.10", engines: { node: ">22 <=24" } } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.id).toBe("reviewer-node24-bun1310");
  });

  test(".tool-versions is read, with comments stripped", () => {
    const r = resolveRuntime({
      table,
      manifest: {},
      runtimeFiles: { ".tool-versions": "# runtimes\nnodejs 22.22.1 # the LTS line\nbun 1.3.10\n" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.id).toBe("reviewer-node22-bun1310");
    // The comment is not a version: 24.21.0 is read and conflicts with engines.node 22.
    const c = refusal(
      resolveRuntime({
        table,
        manifest: { packageManager: "bun@1.3.10", engines: { node: "22" } },
        runtimeFiles: { ".tool-versions": "nodejs 24.21.0 # prod" },
      }),
    );
    expect(c.kind).toBe("conflicting");
  });

  test("a .tool-versions line with several versions (an asdf fallback list) refuses by name", () => {
    const r = refusal(
      resolveRuntime({
        table,
        manifest: { packageManager: "bun@1.3.10" },
        runtimeFiles: { ".tool-versions": "nodejs 24.21.0 22.22.1", ".nvmrc": "22.22.1" },
      }),
    );
    expect(r.kind).toBe("ambiguous");
    expect(r.message).toContain('"nodejs 24.21.0 22.22.1"');
  });

  test("a .tool-versions tool line with no version refuses", () => {
    expect(refusal(resolveRuntime({ table, manifest: {}, runtimeFiles: { ".tool-versions": "nodejs\n" } })).kind).toBe(
      "invalid-declaration",
    );
  });

  test("a version file listing two versions refuses; a commented one is read", () => {
    expect(refusal(resolveRuntime({ table, manifest: {}, runtimeFiles: { ".nvmrc": "22\n24\n" } })).kind).toBe("ambiguous");
    const r = resolveRuntime({ table, manifest: { packageManager: "bun@1.3.10" }, runtimeFiles: { ".nvmrc": "# team pin\n24\n" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.id).toBe("reviewer-node24-bun1310");
  });

  test("non-string engines / packageManager values refuse by name, never skipped", () => {
    const numeric = refusal(
      resolveRuntime({ table, manifest: { packageManager: "bun@1.3.10", engines: { node: 24 } }, runtimeFiles: { ".nvmrc": "22.22.1" } }),
    );
    expect(numeric.kind).toBe("invalid-declaration");
    expect(numeric.message).toContain("engines.node");
    expect(refusal(resolveRuntime({ table, manifest: { engines: { bun: ["1.3.10"] } } })).kind).toBe("invalid-declaration");
    expect(refusal(resolveRuntime({ table, manifest: { engines: ">=22" } })).kind).toBe("invalid-declaration");
    expect(refusal(resolveRuntime({ table, manifest: { packageManager: { name: "bun" } } })).kind).toBe(
      "invalid-declaration",
    );
  });
});

describe("A2 — the range matcher agrees with npm semver", () => {
  // Each expectation is node-semver 7.8.5's satisfies(version, range).
  const cases: [string, string, boolean][] = [
    ["22.22.1", "22.22.1", true],
    ["22.22.1", "22.22", true],
    ["22.22.1", "22", true],
    ["22.22.1", "22.x", true],
    ["22.22.1", "*", true],
    ["22.22.1", "", true],
    ["22.22.1", ">=22", true],
    ["22.22.1", ">22", false],
    ["23.0.0", ">22", true],
    ["22.22.1", ">22.22", false],
    ["22.23.0", ">22.22", true],
    ["22.22.1", ">22.22.0", true],
    ["24.21.0", "<=24", true],
    ["25.0.0", "<=24", false],
    ["24.21.0", "<=24.20", false],
    ["24.21.0", "<24", false],
    ["23.9.9", "<24", true],
    ["22.22.1", ">=22 <25", true],
    ["24.21.0", ">=22 <24", false],
    ["22.22.1", "^22.0.0", true],
    ["23.0.0", "^22.0.0", false],
    ["0.2.5", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["0.0.4", "^0.0.3", false],
    ["22.22.1", "~22.22.0", true],
    ["22.23.0", "~22.22.0", false],
    ["22.9.0", "~22", true],
    ["22.22.1", "~>22.22", true],
    ["22.22.1", "22 - 24", true],
    ["24.21.0", "22 - 24", true],
    ["25.0.0", "22 - 24", false],
    ["24.21.0", "22.22.1 - 24.20", false],
    ["22.22.1", "20 || 22", true],
    ["21.0.0", "20 || 22", false],
    ["22.22.1", ">= 22", true],
    ["22.22.1", "=22.22.1", true],
    ["22.22.1", "v22.22.1", true],
    ["1.3.10", "1.3.10+sha512.abc", true],
    ["1.3.10", ">=1.3.10-canary.7", true],
    ["1.3.10", "1.3.10-canary.7", false],
    ["1.3.10", "<1.3.10-canary.7", false],
    ["22.22.1", "1.3.10", false],
  ];
  for (const [version, range, want] of cases) {
    test(`satisfies(${version}, ${JSON.stringify(range)}) === ${want}`, () => {
      expect(satisfiesRange(version, range)).toBe(want);
    });
  }

  test("text that is not a semver range never matches and is reported unreadable", () => {
    for (const range of ["latest", "lts/*", "lts/iron", "node", "stable", "system", "01.2.3", ">=22.22.1<25", "22.22.1.1"]) {
      expect(isSemverRange(range)).toBe(false);
      expect(satisfiesRange("22.22.1", range)).toBe(false);
    }
  });

  test("an empty || alternative, which npm widens to '*', is refused rather than widened", () => {
    for (const range of ["22 ||", "|| 22", "||"]) {
      expect(isSemverRange(range)).toBe(false);
      expect(satisfiesRange("24.21.0", range)).toBe(false);
    }
  });

  test("a tested version must be a full release", () => {
    expect(satisfiesRange("22.22", "22")).toBe(false);
    expect(satisfiesRange("22.22.1-rc.1", "22")).toBe(false);
  });
});
