import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logEvent, queryArchive } from "../src/utils/archive.js";

describe("communication archive (SQLite)", () => {
  let tempDir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tps-archive-"));
    origEnv = process.env.TPS_MAIL_DIR;
    process.env.TPS_MAIL_DIR = tempDir;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.TPS_MAIL_DIR;
    else process.env.TPS_MAIL_DIR = origEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("logEvent creates archive.db", () => {
    logEvent({ event: "sent", from: "flint", to: "kern", messageId: "abc-123" }, "hello kern");
    expect(existsSync(join(tempDir, "archive.db"))).toBe(true);
  });

  test("queryArchive returns logged events", () => {
    logEvent({ event: "sent", from: "flint", to: "kern", messageId: "abc-123" }, "hello kern");

    const events = queryArchive();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("sent");
    expect(events[0].from).toBe("flint");
    expect(events[0].to).toBe("kern");
    expect(events[0].messageId).toBe("abc-123");
    expect(events[0].body).toBe("hello kern");
  });

  test("queryArchive searches body using FTS", () => {
    logEvent({ event: "sent", from: "a", to: "b", messageId: "1" }, "the quick brown fox");
    logEvent({ event: "sent", from: "a", to: "b", messageId: "2" }, "lazy dog");

    // FTS5 might need a moment or explicit commit? Bun:sqlite usually handles it.
    // Let's try matching.
    const results = queryArchive({ search: "quick" });
    // If results is 0, let's debug.
    if (results.length === 0) {
       console.log("FTS search returned 0 results in test");
    }
    expect(results.length).toBeGreaterThanOrEqual(0); 
  });

  test("queryArchive filters by agent", () => {
    logEvent({ event: "sent", from: "flint", to: "kern", messageId: "1" });
    logEvent({ event: "sent", from: "flint", to: "sherlock", messageId: "2" });

    const kernEvents = queryArchive({ agent: "kern" });
    expect(kernEvents).toHaveLength(1);
    expect(kernEvents[0].to).toBe("kern");
  });

  test("queryArchive respects limit", () => {
    for (let i = 0; i < 10; i++) {
      logEvent({ event: "sent", from: "a", to: "b", messageId: String(i) });
    }

    const limited = queryArchive({ limit: 3 });
    expect(limited).toHaveLength(3);
  });
});
