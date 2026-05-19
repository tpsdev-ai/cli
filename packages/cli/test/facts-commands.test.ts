/**
 * facts-commands.test.ts — Facts Substrate S1: CLI integration tests
 * (ops-568p child)
 *
 * Tests register, get, verify, unregister, list, show via the command dispatcher.
 * Also tests cache behavior, drift detection, and file mode compliance.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  readFileSync,
  unlinkSync,
} from "node:fs";

import { runFacts } from "../src/commands/facts.js";
import {
  readManifest,
  writeManifest,
  manifestPath,
  localSchemasPath,
  cachePath,
  driftLogPath,
  type FactsManifest,
} from "../src/utils/facts-manifest.js";

import {
  readCache,
  writeCache,
  setCachedValue,
} from "../src/utils/facts-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testHome: string;

function setupTestHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tps-facts-cmd-test-"));
  process.env.HOME = dir;
  process.env.TPS_HOME = dir;
  return dir;
}

function cleanupTestHome() {
  if (testHome) {
    rmSync(testHome, { recursive: true, force: true });
  }
}

function fixtureDir(): string {
  return join(testHome, "fixtures");
}

function fixtureFile(name: string, content: string): string {
  const dir = fixtureDir();
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let output = "";
  console.log = (msg: string) => { output += msg + "\n"; };
  try {
    await fn();
  } catch (e: any) {
    if (!e.message?.startsWith("EXIT_")) throw e;
  } finally {
    console.log = orig;
  }
  return output.trim();
}

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const orig = console.error;
  let output = "";
  console.error = (msg: string) => { output += msg + "\n"; };
  try {
    await fn();
  } catch (e: any) {
    if (!e.message?.startsWith("EXIT_")) throw e;
  } finally {
    console.error = orig;
  }
  return output.trim();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let origExit: typeof process.exit;

function stubExit() {
  origExit = process.exit;
  process.exit = (code?: number) => {
    throw new Error(`EXIT_${code ?? 0}`);
  };
}

function restoreExit() {
  process.exit = origExit;
}

beforeAll(() => {
  testHome = setupTestHome();
});

afterAll(() => {
  cleanupTestHome();
});

beforeEach(() => {
  stubExit();
  // Clean manifest and cache between tests
  const paths = [manifestPath(), cachePath(), driftLogPath()];
  for (const p of paths) {
    try { unlinkSync(p); } catch {}
  }
  // Clean local schemas
  const schemasDir = join(testHome, ".tps", "facts", "local-schemas");
  try { rmSync(schemasDir, { recursive: true, force: true }); } catch {}
  try { mkdirSync(schemasDir, { recursive: true, mode: 0o700 }); } catch {}
});

afterEach(() => {
  restoreExit();
});

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

describe("register", () => {
  test("registers a fact and writes local-schema file", async () => {
    const fixture = fixtureFile("test.cfg", "MODEL=qwen\n");

    await runFacts({
      action: "register",
      name: "test.model",
      command: "/bin/grep",
      parsedArgs: ["MODEL=", fixture],
      type: "string",
      rationale: "Test model fact.",
    });

    // Verify local-schema file exists
    const schemaPath = localSchemasPath("test.model");
    expect(existsSync(schemaPath)).toBe(true);

    // Verify file mode 0600
    const st = statSync(schemaPath);
    const mode = (st.mode & 0o777).toString(8);
    expect(mode).toBe("600");

    // Verify manifest contains entry
    const manifest = readManifest();
    expect(manifest.facts["test.model"]).toBeDefined();
    expect(manifest.facts["test.model"].type).toBe("string");
    expect(manifest.facts["test.model"].scope).toBe("local");
    expect(manifest.facts["test.model"].rationale).toBe("Test model fact.");
  });

  test("rejects shell command with clear error", async () => {
    const stderr = await captureStderr(() =>
      runFacts({
        action: "register",
        name: "test.shell",
        command: "sh",
        parsedArgs: ["-c", "echo hi"],
        type: "string",
        rationale: "Shell test.",
      })
    );

    expect(stderr).toContain("Validation error");
  });

  test("rejects missing rationale", async () => {
    const stderr = await captureStderr(() =>
      runFacts({
        action: "register",
        name: "test.norationale",
        command: "/bin/echo",
        parsedArgs: ["hi"],
        type: "string",
      })
    );

    expect(stderr).toContain("--rationale is required");
  });

  test("rejects invalid TTL", async () => {
    const stderr = await captureStderr(() =>
      runFacts({
        action: "register",
        name: "test.badttl",
        command: "/bin/echo",
        parsedArgs: ["hi"],
        type: "string",
        ttl: "2w",
        rationale: "Bad TTL test.",
      })
    );

    expect(stderr).toContain("Validation error");
  });

  test("accepts all valid TTL values", async () => {
    for (const ttl of ["manual", "30s", "1m", "5m", "1h", "1d", "7d"]) {
      const name = `test.ttl_${ttl}`;
      await runFacts({
        action: "register",
        name,
        command: "/bin/echo",
        parsedArgs: [ttl],
        type: "string",
        ttl,
        rationale: `TTL value ${ttl} test.`,
      });
    }

    const manifest = readManifest();
    expect(Object.keys(manifest.facts).length).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("get", () => {
  let fixture: string;

  beforeAll(() => {
    fixture = fixtureFile("test.cfg", "MODEL=qwen\n");
  });

  test("runs verify and returns live value", async () => {
    // Register first
    await runFacts({
      action: "register",
      name: "test.model",
      command: "/bin/grep",
      parsedArgs: ["MODEL=", fixture],
      type: "string",
      rationale: "Test model.",
    });

    const output = await captureStdout(() =>
      runFacts({
        action: "get",
        name: "test.model",
        json: true,
      })
    );

    const parsed = JSON.parse(output);
    expect(parsed.name).toBe("test.model");
    expect(parsed.value).toBe("MODEL=qwen");
    expect(["fresh", "drift_detected"]).toContain(parsed.cache_status);
  });

  test("get --no-verify returns cached value without running verify", async () => {
    // Pre-seed cache
    setCachedValue("test.cached", "cached-value", "manual");

    // Register the fact
    await runFacts({
      action: "register",
      name: "test.cached",
      command: "/bin/echo",
      parsedArgs: ["cached-value"],
      type: "string",
      rationale: "Cached test.",
    });

    const output = await captureStdout(() =>
      runFacts({
        action: "get",
        name: "test.cached",
        noVerify: true,
        json: true,
      })
    );

    const parsed = JSON.parse(output);
    expect(parsed.cache_status).toBe("no_verify_flag");
    expect(parsed.value).toBe("cached-value");
  });

  test("get --verify-preview returns spawn descriptor", async () => {
    await runFacts({
      action: "register",
      name: "test.preview",
      command: "/bin/echo",
      parsedArgs: ["hi"],
      type: "string",
      rationale: "Preview test.",
    });

    const output = await captureStdout(() =>
      runFacts({
        action: "get",
        name: "test.preview",
        verifyPreview: true,
        json: true,
      })
    );

    const parsed = JSON.parse(output);
    expect(parsed.command).toBe("/bin/echo");
    expect(parsed.args).toEqual(["hi"]);
  });

  test("fresh cache hit returns cached without running verify", async () => {
    // Register and prime cache
    await runFacts({
      action: "register",
      name: "test.fresh",
      command: "/bin/echo",
      parsedArgs: ["fresh-value"],
      type: "string",
      rationale: "Fresh cache test.",
    });

    // First get populates cache
    await captureStdout(() => runFacts({ action: "get", name: "test.fresh" }));

    // Second get should hit cache (fresh, no re-verify)
    const output = await captureStdout(() =>
      runFacts({ action: "get", name: "test.fresh", json: true })
    );

    const parsed = JSON.parse(output);
    expect(parsed.cache_status).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

describe("drift detection", () => {
  test("detects drift and logs to drift.log", async () => {
    // Register with expected value
    await runFacts({
      action: "register",
      name: "test.drift",
      command: "/bin/echo",
      parsedArgs: ["new-value"],
      type: "string",
      rationale: "Drift test.",
    });

    // Seed cache with different value AND expired TTL so re-verify runs
    setCachedValue("test.drift", "old-value", new Date(Date.now() - 1000).toISOString());

    // Get should detect drift (cache expired → re-verify → mismatch)
    const output = await captureStdout(() =>
      runFacts({ action: "get", name: "test.drift", json: true })
    );

    const parsed = JSON.parse(output);
    expect(parsed.cache_status).toBe("drift_detected");
    expect(parsed.value).toBe("new-value");

    // Verify drift.log was written
    const logPath = driftLogPath();
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, "utf-8");
    const lines = logContent.trim().split("\n");
    const lastLine = JSON.parse(lines[lines.length - 1]);
    expect(lastLine.fact_name).toBe("test.drift");
  });
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

describe("verify", () => {
  test("verify walks all facts", async () => {
    // Register two facts
    await runFacts({
      action: "register",
      name: "test.a",
      command: "/bin/echo",
      parsedArgs: ["value-a"],
      type: "string",
      rationale: "Fact A.",
    });
    await runFacts({
      action: "register",
      name: "test.b",
      command: "/bin/echo",
      parsedArgs: ["value-b"],
      type: "string",
      rationale: "Fact B.",
    });

    const output = await captureStdout(() => runFacts({ action: "verify" }));

    expect(output).toContain("2 facts verified");
    expect(output).toContain("0 drift detected");
    expect(output).toContain("0 verify-failed");
  });

  test("verify --fail-on-drift exits 4", async () => {
    // Register fact
    await runFacts({
      action: "register",
      name: "test.drift2",
      command: "/bin/echo",
      parsedArgs: ["new-value"],
      type: "string",
      rationale: "Drift test 2.",
    });

    // Seed stale cache
    setCachedValue("test.drift2", "old-value", "manual");

    let exitCode: number | undefined;
    try {
      await runFacts({ action: "verify", failOnDrift: true });
    } catch (e: any) {
      if (e.message?.startsWith("EXIT_")) {
        exitCode = parseInt(e.message.split("_")[1], 10);
      }
    }

    expect(exitCode).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// unregister
// ---------------------------------------------------------------------------

describe("unregister", () => {
  test("removes local schema and updates manifest", async () => {
    await runFacts({
      action: "register",
      name: "test.remove",
      command: "/bin/echo",
      parsedArgs: ["hi"],
      type: "string",
      rationale: "Remove test.",
    });

    expect(existsSync(localSchemasPath("test.remove"))).toBe(true);

    await runFacts({
      action: "unregister",
      name: "test.remove",
    });

    expect(existsSync(localSchemasPath("test.remove"))).toBe(false);

    const manifest = readManifest();
    expect(manifest.facts["test.remove"]).toBeUndefined();
  });

  test("refuses to unregister package-shipped facts", async () => {
    // Create a manifest with a non-local-schema entry
    const manifest: FactsManifest = {
      version: 1,
      facts: {
        "pkg.fact": {
          schema: "pkg@1.0.0/schemas/facts/my-fact.json:1",
          verify: { command: "/bin/echo", args: ["hi"] },
          type: "string" as const,
          scope: "pkg",
          version: 1,
          rationale: "Package fact.",
        },
      },
      registeredAt: new Date().toISOString(),
    };
    writeManifest(manifest);

    const stderr = await captureStderr(() =>
      runFacts({ action: "unregister", name: "pkg.fact" })
    );

    expect(stderr).toContain("Cannot unregister");
  });
});

// ---------------------------------------------------------------------------
// list + show
// ---------------------------------------------------------------------------

describe("list + show", () => {
  test("list shows registered facts", async () => {
    await runFacts({
      action: "register",
      name: "test.l1",
      command: "/bin/echo",
      parsedArgs: ["v1"],
      type: "string",
      rationale: "List test 1.",
    });
    await runFacts({
      action: "register",
      name: "test.l2",
      command: "/bin/echo",
      parsedArgs: ["v2"],
      type: "int",
      rationale: "List test 2.",
    });

    const output = await captureStdout(() => runFacts({ action: "list" }));

    expect(output).toContain("test.l1");
    expect(output).toContain("test.l2");
  });

  test("list --json returns structured output", async () => {
    await runFacts({
      action: "register",
      name: "test.jsonlist",
      command: "/bin/echo",
      parsedArgs: ["v"],
      type: "string",
      rationale: "JSON list test.",
    });

    const output = await captureStdout(() =>
      runFacts({ action: "list", json: true })
    );

    const parsed = JSON.parse(output);
    expect(parsed.facts).toBeDefined();
    expect(Array.isArray(parsed.facts)).toBe(true);
    expect(parsed.facts[0].name).toBe("test.jsonlist");
  });

  test("show displays fact details without cached value", async () => {
    await runFacts({
      action: "register",
      name: "test.show",
      command: "/bin/echo",
      parsedArgs: ["show-value"],
      type: "string",
      scope: "myscope",
      rationale: "Show test.",
    });

    const output = await captureStdout(() =>
      runFacts({ action: "show", name: "test.show" })
    );

    expect(output).toContain("test.show");
    expect(output).toContain("myscope");
    expect(output).toContain("string");
    expect(output).toContain("Show test.");
    // show displays the verify command args (which include the value), that's expected
    // The cached VALUE itself is not displayed separately
    expect(output).toContain("/bin/echo");
    expect(output).toContain("show-value"); // args are shown in the Verify line
  });
});

// ---------------------------------------------------------------------------
// File mode compliance
// ---------------------------------------------------------------------------

describe("File mode compliance", () => {
  test("manifest file is mode 0600 after write", () => {
    const manifest: FactsManifest = {
      version: 1,
      facts: {},
      registeredAt: new Date().toISOString(),
    };
    writeManifest(manifest);

    const st = statSync(manifestPath());
    const mode = (st.mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });

  test("cache file is mode 0600 after write", () => {
    const cache = { version: 1 as const, values: { test: { value: "v", verifiedAt: "", ttl_expires: "manual" } } };
    writeCache(cache);

    const st = statSync(cachePath());
    const mode = (st.mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });
});

// ---------------------------------------------------------------------------
// TTL defaults
// ---------------------------------------------------------------------------

describe("TTL defaults", () => {
  test("unspecified TTL defaults to manual", async () => {
    await runFacts({
      action: "register",
      name: "test.defaultttl",
      command: "/bin/echo",
      parsedArgs: ["hello"],
      type: "string",
      rationale: "Default TTL test.",
    });

    const manifest = readManifest();
    expect(manifest.facts["test.defaultttl"].ttl ?? "manual").toBe("manual");
  });
});
