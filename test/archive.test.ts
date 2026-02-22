import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logEvent, queryArchive } from "../src/utils/archive.js";

describe("communication archive", () => {
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

  test("logEvent appends to archive.jsonl", () => {
    logEvent({ event: "sent", from: "flint", to: "kern", messageId: "abc-123" }, "hello kern");

    const raw = readFileSync(join(tempDir, "archive.jsonl"), "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.event).toBe("sent");
    expect(entry.from).toBe("flint");
    expect(entry.to).toBe("kern");
    expect(entry.messageId).toBe("abc-123");
    expect(entry.bodyPreview).toBe("hello kern");
    expect(entry.timestamp).toBeDefined();
  });

  test("logEvent truncates long body preview", () => {
    const longBody = "a".repeat(200) + "\nsecond line";
    logEvent({ event: "sent", from: "a", to: "b", messageId: "x" }, longBody);

    const raw = readFileSync(join(tempDir, "archive.jsonl"), "utf-8");
    const entry = JSON.parse(raw.trim());
    expect(entry.bodyPreview.length).toBeLessThanOrEqual(101); // 100 + ellipsis
  });

  test("queryArchive returns events filtered by agent", () => {
    logEvent({ event: "sent", from: "flint", to: "kern", messageId: "1" });
    logEvent({ event: "sent", from: "flint", to: "sherlock", messageId: "2" });
    logEvent({ event: "read", from: "kern", to: "kern", messageId: "3" });

    const kernEvents = queryArchive({ agent: "kern" });
    expect(kernEvents).toHaveLength(2); // sent to kern + read by kern

    const sherlockEvents = queryArchive({ agent: "sherlock" });
    expect(sherlockEvents).toHaveLength(1);
  });

  test("queryArchive respects limit", () => {
    for (let i = 0; i < 10; i++) {
      logEvent({ event: "sent", from: "a", to: "b", messageId: String(i) });
    }

    const limited = queryArchive({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  test("queryArchive returns empty for missing archive", () => {
    const events = queryArchive();
    expect(events).toHaveLength(0);
  });

  test("queryArchive filters by event type", () => {
    logEvent({ event: "sent", from: "a", to: "b", messageId: "1" });
    logEvent({ event: "read", from: "b", to: "b", messageId: "2" });

    const sent = queryArchive({ event: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toBe("sent");
  });
});
