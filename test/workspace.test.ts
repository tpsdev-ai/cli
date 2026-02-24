import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveTeamId, branchRoot } from "../src/utils/workspace.js";

// Mock branchRoot to use our temp dir
const originalHome = process.env.HOME;

describe("resolveTeamId", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-team-test-"));
    // Override HOME so branchRoot() points to our temp dir
    process.env.HOME = tmpDir;
    
    // Create the branch-office structure
    mkdirSync(join(tmpDir, ".tps", "branch-office"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  test("returns agent ID for standalone agent", () => {
    const root = branchRoot();
    mkdirSync(join(root, "standalone-agent"), { recursive: true });
    
    expect(resolveTeamId("standalone-agent")).toBe("standalone-agent");
  });

  test("returns team ID when passed the team ID itself", () => {
    const root = branchRoot();
    const teamDir = join(root, "my-team");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "team.json"), JSON.stringify({ members: ["member1"] }));
    
    expect(resolveTeamId("my-team")).toBe("my-team");
  });

  test("returns team ID when passed a member agent ID", () => {
    const root = branchRoot();
    const teamDir = join(root, "my-team");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "team.json"), JSON.stringify({ members: ["team-member-1", "team-member-2"] }));
    
    // Member 1 should resolve to my-team
    expect(resolveTeamId("team-member-1")).toBe("my-team");
    // Member 2 should resolve to my-team
    expect(resolveTeamId("team-member-2")).toBe("my-team");
  });

  test("returns agent ID if team.json is malformed or missing members", () => {
    const root = branchRoot();
    const teamDir = join(root, "bad-team");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "team.json"), "invalid-json");
    
    expect(resolveTeamId("some-agent")).toBe("some-agent");
  });
});
