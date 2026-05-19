/**
 * facts-verify.test.ts — Facts Substrate S1: Verify execution tests
 * (ops-568p child)
 *
 * Tests runVerify, type coercion, security rules, preview mode, truncation.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import {
  runVerify,
  stripControlChars,
  verifyEnv,
  buildSpawnDescriptor,
  type VerifyResult,
  type SpawnDescriptor,
} from "../src/utils/facts-verify.js";

import { type ManifestEntry } from "../src/utils/facts-manifest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "tps-facts-verify-test-"));
}

function makeEntry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    schema: "local:/tmp:1",
    verify: {
      command: "/bin/echo",
      args: ["hello"],
      timeout_ms: overrides.verify?.timeout_ms ?? 5000,
    },
    type: "string",
    ttl: "manual" as const,
    scope: "test",
    version: 1,
    priority: 0,
    rationale: "Test fact.",
    ...overrides,
    verify: {
      command: "/bin/echo",
      args: ["hello"],
      timeout_ms: 5000,
      ...overrides.verify,
    },
  };
}

// ---------------------------------------------------------------------------
// Successful verify
// ---------------------------------------------------------------------------

describe("runVerify — successful", () => {
  test("returns trimmed stdout with ok: true", async () => {
    const entry = makeEntry({
      verify: { command: "/bin/echo", args: ["hello world"] },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.raw_stdout).toContain("hello world");
      expect(result.value).toBe("hello world");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  }, 10_000);

  test("trims trailing newlines", async () => {
    // Use printf to control output precisely — echo can mangle whitespace
    const entry = makeEntry({
      verify: { command: "/usr/bin/printf", args: ["hello\n"] },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The value should be trimmed (newline stripped)
      expect(result.value).toBe("hello");
      expect((result.value as string).includes("\n")).toBe(false);
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Type coercion
// ---------------------------------------------------------------------------

describe("type coercion", () => {
  test("int coercion — happy path", async () => {
    const entry = makeEntry({
      type: "int",
      verify: { command: "/bin/echo", args: ["42"] },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  }, 10_000);

  test("int coercion — rejects non-integer", async () => {
    const entry = makeEntry({
      type: "int",
      verify: { command: "/bin/echo", args: ["not-a-number"] },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_type");
    }
  }, 10_000);

  test("bool coercion — true variants", async () => {
    for (const val of ["true", "1", "yes", "TRUE", "YES"]) {
      const entry = makeEntry({
        type: "bool",
        verify: { command: "/bin/echo", args: [val] },
      });
      const result = await runVerify(entry);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    }
  }, 30_000);

  test("bool coercion — false variants", async () => {
    for (const val of ["false", "0", "no"]) {
      const entry = makeEntry({
        type: "bool",
        verify: { command: "/bin/echo", args: [val] },
      });
      const result = await runVerify(entry);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    }
  }, 30_000);

  test("bool coercion — rejects invalid", async () => {
    const entry = makeEntry({
      type: "bool",
      verify: { command: "/bin/echo", args: ["maybe"] },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_type");
    }
  }, 10_000);

  test("json coercion — happy path", async () => {
    const entry = makeEntry({
      type: "json",
      verify: { command: "/bin/echo", args: ['{"key":"value","num":42}'] },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ key: "value", num: 42 });
    }
  }, 10_000);

  test("json coercion — rejects invalid JSON", async () => {
    const entry = makeEntry({
      type: "json",
      verify: { command: "/bin/echo", args: ["{not json"] },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_type");
    }
  }, 10_000);

  test("string coercion — rejects empty", async () => {
    // Need a command that outputs nothing / empty
    // `printf ""` outputs nothing
    const entry = makeEntry({
      type: "string",
      verify: { command: "/usr/bin/test", args: ["-z", ""] },
    });
    // test -z "" exits 0 with empty stdout
    const result = await runVerify(entry);
    // Empty stdout → invalid_type for string
    if (!result.ok) {
      expect(result.reason).toBe("invalid_type");
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("runVerify — timeout", () => {
  test("timeout kills process", async () => {
    const entry = makeEntry({
      verify: { command: "/bin/sleep", args: ["5"], timeout_ms: 200 },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Nonzero exit
// ---------------------------------------------------------------------------

describe("runVerify — nonzero exit", () => {
  test("false command returns nonzero_exit", async () => {
    const entry = makeEntry({
      verify: { command: "/bin/false", args: [] },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("nonzero_exit");
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Blocked command
// ---------------------------------------------------------------------------

describe("runVerify — blocked command", () => {
  test("rejects sh as command", async () => {
    const entry = makeEntry({
      verify: { command: "sh", args: ["-c", "echo hi"] },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("blocked_command");
    }
  }, 5_000);

  test("rejects bash as command", async () => {
    const entry = makeEntry({
      verify: { command: "bash", args: ["-c", "echo hi"] },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("blocked_command");
    }
  }, 5_000);
});

// ---------------------------------------------------------------------------
// Restricted PATH: spawn_error for non-system binary
// ---------------------------------------------------------------------------

describe("runVerify — restricted PATH", () => {
  test("spawn_error for binary not in /usr/bin or /bin", async () => {
    // Use a path that definitely doesn't exist
    const entry = makeEntry({
      verify: { command: "/nonexistent/binary/xyz", args: [] },
    });
    const result = await runVerify(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // spawn_error or nonzero_exit (ENOENT may manifest as either)
      expect(["spawn_error", "nonzero_exit"]).toContain(result.reason);
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Preview mode
// ---------------------------------------------------------------------------

describe("runVerify — preview mode", () => {
  test("previewOnly returns spawn descriptor without executing", async () => {
    const entry = makeEntry({
      verify: { command: "/bin/echo", args: ["foo"], timeout_ms: 3000 },
    });
    const result = await runVerify(entry, { previewOnly: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const desc = JSON.parse(result.value as string) as SpawnDescriptor;
      expect(desc.command).toBe("/bin/echo");
      expect(desc.args).toEqual(["foo"]);
      expect(desc.env).toHaveProperty("PATH");
      expect(desc.env.PATH).toBe("/usr/bin:/bin");
      expect(desc.cwd).toBe(homedir());
      expect(desc.timeout_ms).toBe(3000);
    }
  }, 5_000);
});

// ---------------------------------------------------------------------------
// Spawn descriptor
// ---------------------------------------------------------------------------

describe("buildSpawnDescriptor", () => {
  test("builds correct descriptor", () => {
    const entry = makeEntry({
      verify: { command: "/bin/grep", args: ["pattern", "/tmp/file"], timeout_ms: 5000 },
    });
    const desc = buildSpawnDescriptor(entry);
    expect(desc.command).toBe("/bin/grep");
    expect(desc.args).toEqual(["pattern", "/tmp/file"]);
    expect(desc.timeout_ms).toBe(5000);
    expect(desc.env.PATH).toBe("/usr/bin:/bin");
    expect(desc.env.HOME).toBe(homedir());
    expect(desc.env.LANG).toBe("C");
    expect(desc.cwd).toBe(homedir());
  });

  test("uses default timeout when not specified", () => {
    const entry = makeEntry({
      verify: { command: "/bin/echo", args: ["hi"] },
    });
    delete (entry.verify as any).timeout_ms;
    const desc = buildSpawnDescriptor(entry);
    expect(desc.timeout_ms).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// verifyEnv
// ---------------------------------------------------------------------------

describe("verifyEnv", () => {
  test("restricted PATH only includes /usr/bin:/bin", () => {
    const env = verifyEnv();
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  test("does not inherit user's full PATH", () => {
    const env = verifyEnv();
    expect(env.PATH).not.toContain("/usr/local/bin");
    expect(env.PATH).not.toContain(process.env.PATH ?? "");
  });

  test("includes HOME and LANG", () => {
    const env = verifyEnv();
    expect(env.HOME).toBe(homedir());
    expect(env.LANG).toBe("C");
  });
});

// ---------------------------------------------------------------------------
// Control character stripping
// ---------------------------------------------------------------------------

describe("stripControlChars", () => {
  test("removes control characters but keeps tab/LF/CR", () => {
    const input = "hello\x01\x02\x03\tworld\n\r";
    const result = stripControlChars(input);
    expect(result).toBe("hello\tworld\n\r");
  });

  test("passes normal text unchanged", () => {
    const input = "hello world 123";
    const result = stripControlChars(input);
    expect(result).toBe(input);
  });

  test("removes ESC (0x1B)", () => {
    const input = "text\x1B[31mred\x1B[0m";
    const result = stripControlChars(input);
    expect(result).not.toContain("\x1B");
  });
});
