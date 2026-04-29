// Test: round-trip dispatch works correctly
import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { watchMail } from "../src/index.js";
import { cleanupTestInbox, setupTestInbox, writeTestMessage, TEMP_ROOT, INBOX_CUR } from "./fixtures.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

describe("round-trip dispatch", () => {
  beforeAll(async () => {
    await setupTestInbox();
  });

  afterAll(async () => {
    await cleanupTestInbox();
  });

  it.skip("dispatches valid messages and sends reply/ack", async () => {
    // TODO(v0.2): test spawn dispatch when pi test env exposes PATH or we can use absolute launcher paths
    // Use a pre-existing executable as the launcher
    const launcherPath = "/usr/bin/true";  // Always exits 0

    const watcher = watchMail({
      inboxRoot: TEMP_ROOT,
      launcher: launcherPath,
      timeoutMs: 1000,  // Fast timeout for test
    });

    // Write a test message
    const msgId = `test-${Date.now()}`;
    await writeTestMessage(msgId, "flint", "Test message body");

    // Wait for polling to pick it up (poll interval is 5s)
    await setTimeout(6000);

    // Check that message was moved to cur/
    const curPath = join(INBOX_CUR, `${msgId}.json`);
    expect(existsSync(curPath)).toBeTrue();

    watcher.stop();
  }, 10_000); // Extended timeout for the 5s poll + processing
});
