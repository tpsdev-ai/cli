import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initWall, postToWall, readWall } from "../src/utils/wall.js";

describe("wall", () => {
  let tempHome: string;
  let officeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tps-wall-home-"));
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

  test("init creates wall file", () => {
    initWall(officeDir, "test-team");
    const content = readWall(officeDir);
    expect(content).toContain("test-team");
    expect(content).toContain("Broadcast Wall");
  });

  test("post appends to wall", () => {
    initWall(officeDir, "test-team");
    postToWall(officeDir, "manager", "Starting work on auth module");
    postToWall(officeDir, "alpha", "Picked up auth implementation");

    const content = readWall(officeDir);
    expect(content).toContain("manager");
    expect(content).toContain("Starting work on auth module");
    expect(content).toContain("alpha");
    expect(content).toContain("Picked up auth implementation");
  });

  test("post rejects without init", () => {
    expect(() => postToWall(officeDir, "manager", "hello")).toThrow(/not initialized/);
  });

  test("post rejects oversized message", () => {
    initWall(officeDir, "test-team");
    const big = "x".repeat(5000);
    expect(() => postToWall(officeDir, "manager", big)).toThrow(/4KB/);
  });

  test("readWall returns empty string if no wall", () => {
    expect(readWall(officeDir)).toBe("");
  });
});
