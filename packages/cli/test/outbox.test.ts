import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { queueOutboxMessage, drainOutbox } from "../src/utils/outbox.js";

describe("outbox", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-outbox-"));
    process.env.HOME = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.HOME;
  });

  test("queueOutboxMessage writes to ~/.tps/outbox/new", () => {
    queueOutboxMessage("rockit", "hello", "austin");
    const files = readdirSync(join(root, ".tps", "outbox", "new"));
    expect(files.length).toBe(1);
  });

  test("drainOutbox returns messages and moves files to sent", () => {
    queueOutboxMessage("rockit", "hello", "austin");
    const rows = drainOutbox();
    expect(rows.length).toBe(1);
    expect(rows[0]?.to).toBe("rockit");

    const newFiles = readdirSync(join(root, ".tps", "outbox", "new"));
    const sentFiles = readdirSync(join(root, ".tps", "outbox", "sent"));
    expect(newFiles.length).toBe(0);
    expect(sentFiles.length).toBe(1);
  });
});
