// Test: hung child timeout fires and loop continues
import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { watchMail } from "../src/index.js";
import { cleanupTestInbox, setupTestInbox, writeTestMessage, TEMP_ROOT, INBOX_CUR } from "./fixtures.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

describe("hung child timeout", () => {
  beforeAll(async () => {
    await setupTestInbox();
  });

  afterAll(async () => {
    await cleanupTestInbox();
  });

  it.skip("kills hung process and continues loop", async () => {
    // TODO(v0.2): test spawn dispatch when pi test env exposes PATH or we can use absolute launcher paths
    // Use /bin/sleep as a launcher that will hang
    const launcherPath = "/bin/sleep";
    const launcherArgs = ["30"];  // Sleep for 30 seconds

    const watcher = watchMail({
      inboxRoot: TEMP_ROOT,
      launcher: launcherPath,
      launcherArgs: launcherArgs,  // Pass args to sleep
      timeoutMs: 2000,  // 2 second timeout - shorter than launcher's 30s
    });

    // Write a test message that will be killed by timeout
    const msgId = `hung-${Date.now()}`;
    await writeTestMessage(msgId, "flint", "Test message");

    // Wait for polling to pick it up and timeout to fire
    await setTimeout(4000);

    // Check that message was processed (moved to cur/) despite timeout
    const curPath = join(INBOX_CUR, `${msgId}.json`);
    expect(existsSync(curPath)).toBeTrue();

    // Verify watcher is still running by writing another message
    const msgId2 = `hung-2-${Date.now()}`;
    await writeTestMessage(msgId2, "flint", "Test message 2");
    
    await setTimeout(4000);
    expect(existsSync(join(INBOX_CUR, `${msgId2}.json`))).toBeTrue();

    watcher.stop();
  }, 15_000);  // Extended timeout for polling
});
