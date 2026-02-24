import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { sendInternalMessage, checkInternalMessages, getInternalInbox } from "../src/utils/internal-mail.js";

describe("internal-mail", () => {
  let tempHome: string;
  let officeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tps-imail-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    
    // Create valid branch office structure
    const branchRoot = join(tempHome, ".tps", "branch-office");
    require("node:fs").mkdirSync(branchRoot, { recursive: true });
    officeDir = join(branchRoot, "test-team");
    require("node:fs").mkdirSync(officeDir, { recursive: true });
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("send and check internal message", () => {
    const msg = sendInternalMessage(officeDir, "manager", "alpha", "Build the auth module");
    expect(msg.from).toBe("manager");
    expect(msg.to).toBe("alpha");
    expect(msg.body).toBe("Build the auth module");

    const messages = checkInternalMessages(officeDir, "alpha");
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("Build the auth module");
    expect(messages[0].read).toBe(true);
  });

  test("check moves messages from new to cur", () => {
    sendInternalMessage(officeDir, "manager", "beta", "Write tests");
    const inbox = getInternalInbox(officeDir, "beta");

    // Before check: message in new/
    expect(readdirSync(inbox.fresh).filter((f: string) => f.endsWith(".json"))).toHaveLength(1);
    expect(readdirSync(inbox.cur).filter((f: string) => f.endsWith(".json"))).toHaveLength(0);

    checkInternalMessages(officeDir, "beta");

    // After check: message in cur/
    expect(readdirSync(inbox.fresh).filter((f: string) => f.endsWith(".json"))).toHaveLength(0);
    expect(readdirSync(inbox.cur).filter((f: string) => f.endsWith(".json"))).toHaveLength(1);
  });

  test("rejects invalid agent id", () => {
    expect(() => sendInternalMessage(officeDir, "../escape", "alpha", "bad")).toThrow();
  });

  test("rejects oversized body", () => {
    const big = "x".repeat(65 * 1024);
    expect(() => sendInternalMessage(officeDir, "manager", "alpha", big)).toThrow(/maximum size/);
  });
});
