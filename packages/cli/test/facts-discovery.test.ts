/**
 * facts-discovery.test.ts — Facts Substrate S2: Schema discovery tests
 * (ops-nmoe)
 *
 * Covers: discoverSchemas, resolveConflicts, isNamespaceAllowed,
 * the 3 seed schemas (host, service, agents), --strict mode rejection,
 * refresh add/update/remove lifecycle, which command resolution chain.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";

import {
  discoverSchemas,
  resolveConflicts,
  isNamespaceAllowed,
  type DiscoveredSchema,
  type DiscoveryResult,
} from "../src/utils/facts-discovery";

import {
  validateEntry,
  type ManifestEntry,
} from "../src/utils/facts-manifest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "tps-facts-discovery-test-"));
}

/** Create a mock node_modules structure with fact schemas. */
function createMockNodeModules(
  root: string,
  pkgs: Array<{
    dir: string;   // e.g., "@tpsdev-ai/tps"
    version: string;
    schemas: Array<{
      file: string;       // e.g., "host.json"
      facts: Record<string, unknown>[];  // array of fact declarations
    }>;
  }>,
): void {
  const nm = join(root, "node_modules");
  mkdirSync(nm, { recursive: true, mode: 0o755 });

  for (const pkg of pkgs) {
    const pkgDir = join(nm, pkg.dir);
    mkdirSync(pkgDir, { recursive: true, mode: 0o755 });

    // Write package.json
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: pkg.dir, version: pkg.version }),
    );

    const schemasDir = join(pkgDir, "schemas", "facts");
    mkdirSync(schemasDir, { recursive: true, mode: 0o755 });

    for (const schema of pkg.schemas) {
      writeFileSync(
        join(schemasDir, schema.file),
        JSON.stringify(schema.facts, null, 2),
      );
    }
  }
}

/** Create a minimal valid fact declaration. */
function makeFactDecl(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "test.fact",
    scope: "test",
    version: 1,
    type: "string",
    verify: { command: "echo", args: ["hello"] },
    rationale: "A test fact for unit testing.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Namespace allowlist tests
// ---------------------------------------------------------------------------

describe("isNamespaceAllowed", () => {
  test("matches exact package name", () => {
    expect(isNamespaceAllowed("@tpsdev-ai/tps", ["@tpsdev-ai/tps"])).toBe(true);
  });

  test("matches wildcard scope", () => {
    expect(isNamespaceAllowed("@tpsdev-ai/tps", ["@tpsdev-ai/*"])).toBe(true);
    expect(isNamespaceAllowed("@tpsdev-ai/flair", ["@tpsdev-ai/*"])).toBe(true);
  });

  test("rejects non-matching scope", () => {
    expect(isNamespaceAllowed("@evilcorp/pwn", ["@tpsdev-ai/*"])).toBe(false);
  });

  test("rejects partial match", () => {
    expect(isNamespaceAllowed("@tpsdev-ai-evil/pwn", ["@tpsdev-ai/*"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Discovery: finds the 3 seed schemas
// ---------------------------------------------------------------------------

describe("discoverSchemas", () => {
  test("discovers fact schemas from allowed namespaces", () => {
    const tmp = tmpDir();
    try {
      createMockNodeModules(tmp, [
        {
          dir: "@tpsdev-ai/tps",
          version: "1.2.3",
          schemas: [
            {
              file: "host.json",
              facts: [
                makeFactDecl({ name: "host.rockit.platform", scope: "host" }),
                makeFactDecl({ name: "host.rockit.transport", scope: "host" }),
              ],
            },
            {
              file: "agents.json",
              facts: [
                makeFactDecl({ name: "agent.ember.primary_model", scope: "agent:ember" }),
              ],
            },
          ],
        },
        {
          dir: "@harperfast/harper",
          version: "0.5.0",
          schemas: [
            {
              file: "service.json",
              facts: [
                makeFactDecl({ name: "service.flair.port", scope: "service:flair" }),
              ],
            },
          ],
        },
      ]);

      const result = discoverSchemas(tmp);

      expect(result.discovered.length).toBe(4); // 2+1+1 facts
      expect(result.errors.length).toBe(0);

      const names = result.discovered.map(d => d.name);
      expect(names).toContain("host.rockit.platform");
      expect(names).toContain("host.rockit.transport");
      expect(names).toContain("agent.ember.primary_model");
      expect(names).toContain("service.flair.port");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("ignores schemas from non-allowed namespaces", () => {
    const tmp = tmpDir();
    try {
      createMockNodeModules(tmp, [
        {
          dir: "@evilcorp/malware",
          version: "1.0.0",
          schemas: [
            {
              file: "bad.json",
              facts: [makeFactDecl({ name: "evil.bad_thing", scope: "evil" })],
            },
          ],
        },
        {
          dir: "@tpsdev-ai/tps",
          version: "1.0.0",
          schemas: [
            {
              file: "host.json",
              facts: [makeFactDecl({ name: "host.safe", scope: "host" })],
            },
          ],
        },
      ]);

      const result = discoverSchemas(tmp);

      expect(result.discovered.length).toBe(1);
      expect(result.discovered[0].name).toBe("host.safe");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns empty when no node_modules exists", () => {
    const tmp = tmpDir();
    try {
      const result = discoverSchemas(tmp);
      expect(result.discovered.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("handles missing schemas/facts directory gracefully", () => {
    const tmp = tmpDir();
    try {
      const nm = join(tmp, "node_modules", "@tpsdev-ai", "tps");
      mkdirSync(nm, { recursive: true, mode: 0o755 });
      writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "@tpsdev-ai/tps", version: "1.0.0" }));
      // No schemas/facts dir

      const result = discoverSchemas(tmp);
      expect(result.discovered.length).toBe(0);
      expect(result.errors.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--strict mode requires exact package matching", () => {
    const tmp = tmpDir();
    try {
      createMockNodeModules(tmp, [
        {
          dir: "@tpsdev-ai/tps",
          version: "1.0.0",
          schemas: [
            {
              file: "host.json",
              facts: [makeFactDecl({ name: "host.ok", scope: "host" })],
            },
          ],
        },
      ]);

      // Strict with no allowlist entries → nothing discovered
      const result = discoverSchemas(tmp, { allowlist: [], strict: true });
      expect(result.discovered.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("records parse errors for invalid JSON", () => {
    const tmp = tmpDir();
    try {
      const nm = join(tmp, "node_modules", "@tpsdev-ai", "tps", "schemas", "facts");
      mkdirSync(nm, { recursive: true, mode: 0o755 });
      writeFileSync(join(dirname(dirname(dirname(nm))), "package.json"), JSON.stringify({ name: "@tpsdev-ai/tps", version: "1.0.0" }));
      writeFileSync(join(nm, "bad.json"), "not json at all");

      const result = discoverSchemas(tmp);
      expect(result.discovered.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].reason).toContain("invalid JSON");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("records validation errors for invalid entries", () => {
    const tmp = tmpDir();
    try {
      createMockNodeModules(tmp, [
        {
          dir: "@tpsdev-ai/tps",
          version: "1.0.0",
          schemas: [
            {
              file: "bad.json",
              facts: [
                // Missing required fields (rationale)
                { name: "bad.fact", scope: "test", type: "string", version: 1, verify: { command: "echo", args: ["x"] } },
              ],
            },
          ],
        },
      ]);

      const result = discoverSchemas(tmp);
      expect(result.discovered.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].reason).toContain("rationale");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// conflict resolution
// ---------------------------------------------------------------------------

describe("resolveConflicts", () => {
  function makeDiscovered(name: string, pkg: string, relPath: string, priority = 0): DiscoveredSchema {
    return {
      name,
      package: pkg,
      version: "1.0.0",
      relPath,
      absPath: `/tmp/node_modules/${pkg}/${relPath}`,
      entry: {
        name,
        schema: `${pkg}@1.0.0/${relPath}`,
        verify: { command: "echo", args: ["x"] },
        type: "string",
        scope: "test",
        version: 1,
        priority,
        rationale: "Test.",
      } as unknown as ManifestEntry,
    };
  }

  test("detects conflict between two schemas for same fact", () => {
    const discovered: DiscoveredSchema[] = [
      makeDiscovered("host.platform", "@tpsdev-ai/tps", "schemas/facts/host.json", 0),
      makeDiscovered("host.platform", "@harperfast/harper", "schemas/facts/host.json", 5),
    ];

    const conflicts = resolveConflicts(discovered);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].factName).toBe("host.platform");
    expect(conflicts[0].declarations.length).toBe(2);
    // Higher priority wins
    expect(conflicts[0].declarations[0].isWinner).toBe(true);
    expect(conflicts[0].declarations[0].priority).toBe(5);
    expect(conflicts[0].declarations[0].package).toBe("@harperfast/harper");
  });

  test("tie-breaks by alphabetical schema path", () => {
    const discovered: DiscoveredSchema[] = [
      makeDiscovered("agent.model", "@tpsdev-ai/tps", "schemas/facts/agents-b.json", 0),
      makeDiscovered("agent.model", "@tpsdev-ai/tps", "schemas/facts/agents-a.json", 0),
    ];

    const conflicts = resolveConflicts(discovered);
    expect(conflicts.length).toBe(1);
    // agents-a.json comes before agents-b.json alphabetically
    expect(conflicts[0].declarations[0].relPath).toBe("schemas/facts/agents-a.json");
    expect(conflicts[0].declarations[0].isWinner).toBe(true);
  });

  test("returns empty for no conflicts", () => {
    const discovered: DiscoveredSchema[] = [
      makeDiscovered("host.platform", "@tpsdev-ai/tps", "schemas/facts/host.json"),
      makeDiscovered("service.port", "@tpsdev-ai/tps", "schemas/facts/service.json"),
    ];

    expect(resolveConflicts(discovered).length).toBe(0);
  });

  test("winner resolution chain is inspectable", () => {
    const discovered: DiscoveredSchema[] = [
      makeDiscovered("shared.fact", "@tpsdev-ai/tps", "schemas/facts/a.json", 0),
      makeDiscovered("shared.fact", "@tpsdev-ai/flair", "schemas/facts/b.json", 10),
      makeDiscovered("shared.fact", "@harperfast/harper", "schemas/facts/c.json", 5),
    ];

    const conflicts = resolveConflicts(discovered);
    expect(conflicts.length).toBe(1);
    // Winner should be @tpsdev-ai/flair (priority 10)
    expect(conflicts[0].declarations[0].isWinner).toBe(true);
    expect(conflicts[0].declarations[0].priority).toBe(10);
    // Chain should be sorted by priority desc
    expect(conflicts[0].declarations.map(d => d.priority)).toEqual([10, 5, 0]);
  });
});
