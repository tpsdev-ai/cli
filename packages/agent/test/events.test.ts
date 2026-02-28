import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLogger } from "../src/telemetry/events.js";

describe("EventLogger", () => {
  test("writes jsonl events with 0600 permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "tps-events-"));
    const logger = new EventLogger("anvil", root);
    logger.emit({ type: "tool.call", tool: "read", durationMs: 5, status: "ok" });

    const day = new Date().toISOString().slice(0, 10);
    const path = join(root, `events-${day}.jsonl`);
    const content = readFileSync(path, "utf-8").trim();
    const obj = JSON.parse(content);
    expect(obj.agent).toBe("anvil");
    expect(obj.type).toBe("tool.call");

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("rotates by event day", () => {
    const root = mkdtempSync(join(tmpdir(), "tps-events-"));
    const logger = new EventLogger("anvil", root);
    logger.emit({ type: "session.start", model: "m1", ts: "2026-02-28T00:00:00.000Z" });
    logger.emit({ type: "session.end", model: "m1", ts: "2026-03-01T00:00:00.000Z" });

    expect(() => readFileSync(join(root, "events-2026-02-28.jsonl"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(root, "events-2026-03-01.jsonl"), "utf-8")).not.toThrow();
  });
});
