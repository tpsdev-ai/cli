/**
 * resolve-runtime.test.ts — the trusted runtime matrix and the requirement
 * resolver (cli#425 acceptance A2). Every refusal is exercised; the matrix
 * integrity is asserted; and each control fails if the resolver stops refusing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ciConstraintsFromLanes, resolveRuntime, satisfiesRange } from "../../../../scripts/reviewer/resolve-runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..", "..");
const table = JSON.parse(readFileSync(resolve(repo, "docker", "reviewer", "runtime-matrix.json"), "utf8"));

describe("A2 — the trusted runtime table is self-consistent", () => {
  test("every matrix image pins runtimes present in the table, with 64-hex checksums", () => {
    expect(table.images.length).toBeGreaterThan(0);
    for (const img of table.images) {
      for (const tool of ["node", "bun", "gh"]) {
        const entry = table.artifacts[tool]?.[img[tool]];
        expect(entry).toBeDefined();
        expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.url.startsWith("https://")).toBe(true);
      }
    }
  });

  test("the base image is digest-pinned and the Dockerfile default matches", () => {
    expect(table.base.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const dockerfile = readFileSync(resolve(repo, "docker", "reviewer", "Dockerfile"), "utf8");
    expect(dockerfile).toContain(`${table.base.image}@${table.base.digest}`);
  });
});

describe("A2 — requirement resolution", () => {
  test("selects the single matching image from packageManager, engines and CI lanes", () => {
    const ci = ciConstraintsFromLanes([{ file: "test.yml", text: 'node-version: "22.22.1"\nbun-version: "1.3.10"' }]);
    const r = resolveRuntime({
      table,
      manifest: { packageManager: "bun@1.3.10", engines: { node: ">=22 <25" } },
      ciConstraints: ci,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.id).toBe("reviewer-node22-bun1310");
  });

  test("a runtime outside the matrix refuses and NAMES the missing image", () => {
    const r = resolveRuntime({ table, manifest: { engines: { node: ">=25" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("out-of-matrix");
      expect(r.refusal.message).toContain("Available images:");
    }
  });

  test("a packageManager outside the matrix refuses", () => {
    const r = resolveRuntime({ table, manifest: { packageManager: "pnpm@9.0.0" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe("out-of-matrix");
  });

  test("a range matching two matrix entries is ambiguous", () => {
    const r = resolveRuntime({ table, manifest: { engines: { node: ">=22" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe("ambiguous");
  });

  test("mutually unsatisfiable requirements conflict", () => {
    const r = resolveRuntime({
      table,
      manifest: { engines: { node: "22.22.1" } },
      runtimeFiles: { ".nvmrc": "24.21.0" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe("conflicting");
  });

  test("a non-explicit version (lts/*) is ambiguous, never 'latest'", () => {
    const r = resolveRuntime({ table, manifest: {}, runtimeFiles: { ".nvmrc": "lts/*" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["ambiguous", "out-of-matrix"]).toContain(r.refusal.kind);
  });

  test("no requirement at all is ambiguous (never a default runtime)", () => {
    const r = resolveRuntime({ table, manifest: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe("ambiguous");
  });

  test(".tool-versions is read", () => {
    const r = resolveRuntime({
      table,
      manifest: {},
      runtimeFiles: { ".tool-versions": "nodejs 22.22.1\nbun 1.3.10" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.id).toBe("reviewer-node22-bun1310");
  });
});

describe("A2 — the range matcher", () => {
  test("exact, partial, comparator, caret and tilde forms", () => {
    expect(satisfiesRange("22.22.1", "22.22.1")).toBe(true);
    expect(satisfiesRange("22.22.1", "22.22")).toBe(true);
    expect(satisfiesRange("22.22.1", "22")).toBe(true);
    expect(satisfiesRange("22.22.1", ">=22")).toBe(true);
    expect(satisfiesRange("22.22.1", ">=22 <25")).toBe(true);
    expect(satisfiesRange("24.21.0", ">=22 <25")).toBe(true);
    expect(satisfiesRange("24.21.0", ">=22 <24")).toBe(false);
    expect(satisfiesRange("22.22.1", "^22.0.0")).toBe(true);
    expect(satisfiesRange("22.22.1", "~22.22.0")).toBe(true);
    expect(satisfiesRange("22.22.1", "1.3.10")).toBe(false);
  });
});
