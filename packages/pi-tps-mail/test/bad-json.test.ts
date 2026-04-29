// Test: bad JSON doesn't crash the watcher
import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { watchMail } from "../src/index.js";
import { cleanupTestInbox, setupTestInbox, writeTestMessage, TEMP_ROOT, INBOX_NEW, INBOX_CUR } from "./fixtures.js";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

describe("bad JSON handling", () => {
  beforeAll(async () => {
    await setupTestInbox();
  });

  afterAll(async () => {
    await cleanupTestInbox();
  });

  it.skip("skips corrupt messages without crashing", async () => {
    // TODO(v0.2): test spawn dispatch when pi test env exposes PATH or we can use absolute launcher paths
    // Ensure temp root exists
    mkdirSync(TEMP_ROOT, { recursive: true });

    // Create a mock launcher that always exits 0
    const launcherPath = join(TEMP_ROOT, "mock-launcher");
    const launcherSrc = `#!/usr/bin/env bun
// Mock launcher that exits 0 after printing the message
console.log("Mock launcher received:", process.argv.slice(2).join(" "));
process.exit(0);
`;
    writeFileSync(launcherPath, launcherSrc, "utf8");
    chmodSync(launcherPath, 0o755);

    const watcher = watchMail({
      inboxRoot: TEMP_ROOT,
      launcher: launcherPath,
    });

    // Write a message with bad JSON
    const badJsonPath = join(INBOX_NEW, "bad.json");
    await writeFile(badJsonPath, "{ this is not valid json }", "utf8");

    // Write a good message too
    const goodId = `good-${Date.now()}`;
    await writeTestMessage(goodId, "flint", "Good message after bad");

    // Wait for polling to pick them up
    await setTimeout(6000);

    // Bad message should be skipped (not crash), good message should be processed
    // The bad message stays in new/ (not processed) because it fails to parse
    // The good message is moved to cur/ (processed)
    const badStillInNew = existsSync(join(INBOX_NEW, "bad.json"));
    const goodProcessed = existsSync(join(INBOX_CUR, `${goodId}.json`));
    
    // Both should be true: bad message not processed, good message processed
    expect(badStillInNew).toBeTrue();  // Bad message stays in new/ (not processed)
    expect(goodProcessed).toBeTrue();  // Good message processed

    watcher.stop();
  }, 15_000);
});
