import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getContextDir, listContexts, readContext, writeContext } from "../src/utils/context.js";

describe("context utils", () => {
  const originalHome = process.env.HOME;
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tps-context-test-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("write context and read it back", () => {
    const written = writeContext("ops-13-1", { summary: "Initial context summary" });
    expect(written.workstream).toBe("ops-13-1");

    const loaded = readContext("ops-13-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.summary).toBe("Initial context summary");
    expect(loaded!.workstream).toBe("ops-13-1");
    expect(loaded!.updatedAt).toBeTruthy();
  });

  test("list contexts returns names and timestamps", () => {
    writeContext("alpha", { summary: "A" });
    writeContext("beta", { summary: "B" });

    const listed = listContexts();
    const names = listed.map((r) => r.workstream);

    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(listed[0]!.updatedAt).toBeTruthy();
  });

  test("readContext returns null for missing workstream", () => {
    expect(readContext("does-not-exist")).toBeNull();
  });

  test("rejects invalid workstream names (path traversal)", () => {
    expect(() => writeContext("../../etc/passwd", { summary: "bad" })).toThrow(/Invalid workstream/);
    expect(() => readContext("../../etc/passwd")).toThrow(/Invalid workstream/);
  });

  test("rejects overly long workstream names", () => {
    const longName = "a".repeat(10_000);
    expect(() => writeContext(longName, { summary: "too long" })).toThrow(/max length is 64/);
  });

  test("context dir resolves under ~/.tps/context", () => {
    const dir = getContextDir();
    expect(dir.startsWith(tempHome)).toBe(true);
    expect(dir.endsWith("/.tps/context")).toBe(true);
  });
});
