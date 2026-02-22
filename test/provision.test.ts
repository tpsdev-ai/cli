import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { provisionTeam } from "../src/utils/provision.js";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("provisionTeam", () => {
  let tempHome: string;
  let branchRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tps-provision-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    branchRoot = join(tempHome, ".tps", "branch-office");
    require("node:fs").mkdirSync(branchRoot, { recursive: true });
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("provisions a team workspace", () => {
    const manifestPath = join(tempHome, "office.yaml");
    writeFileSync(manifestPath, `
name: test-team
purpose: development
manager:
  persona: ops
  name: Manager
agents:
  - persona: developer
    name: Dev
`, "utf-8");

    // We need to mock resolveReportPath to find built-in personas if they aren't in the test environment correctly.
    // However, the test environment (bun test) runs from repo root, so it should find ../personas.
    // Let's rely on standard resolution.

    provisionTeam(manifestPath, branchRoot);

    const teamDir = join(branchRoot, "test-team");
    expect(existsSync(teamDir)).toBe(true);

    const openclawJsonPath = join(teamDir, ".openclaw", "openclaw.json");
    expect(existsSync(openclawJsonPath)).toBe(true);
    
    const config = JSON.parse(readFileSync(openclawJsonPath, "utf-8"));
    expect(config.agents.list.length).toBe(2);
    expect(config.agents.defaults).toBeDefined();
    expect(config.agents.defaults.model.primary).toContain("anthropic");
    
    // Check IDs (sanitized)
    const ids = config.agents.list.map((a: any) => a.id).sort();
    expect(ids).toEqual(["dev", "manager"]);

    // Check agent files
    const managerDir = join(teamDir, ".openclaw", "agents", "manager", "agent");
    expect(existsSync(join(managerDir, "SOUL.md"))).toBe(true);
    
    const devDir = join(teamDir, ".openclaw", "agents", "dev", "agent");
    expect(existsSync(join(devDir, "SOUL.md"))).toBe(true);

    // Check shared workspace
    const sharedWorkspace = join(teamDir, "workspace");
    expect(existsSync(join(sharedWorkspace, "package.json"))).toBe(true);

    // Check internal mail and wall are in shared workspace (not team root)
    expect(existsSync(join(sharedWorkspace, "mail", "internal", "manager"))).toBe(true);
    expect(existsSync(join(sharedWorkspace, "mail", "internal", "dev"))).toBe(true);
    expect(existsSync(join(sharedWorkspace, "WALL.md"))).toBe(true);
  });

  test("rejects adversarial purpose", () => {
    const manifestPath = join(tempHome, "adversarial.yaml");
    writeFileSync(manifestPath, `
name: red-team
purpose: adversarial
manager:
  name: Boss
  persona: ops
agents:
  - name: Red
    persona: developer
`, "utf-8");
    expect(() => provisionTeam(manifestPath, branchRoot)).toThrow(/not yet implemented/);
  });

  test("writes CONTEXT.md from briefs", () => {
    const manifestPath = join(tempHome, "context-briefs.yaml");
    writeFileSync(manifestPath, `
name: context-team
manager:
  persona: ops
  name: Manager
agents:
  - persona: developer
    name: Dev
context:
  briefs:
    - "Docker sandbox exec is broken on v0.11.0. Use tps office exec."
    - "This repo uses Bun, not npm."
`, "utf-8");

    const teamDir = provisionTeam(manifestPath, branchRoot);
    const contextPath = join(teamDir, "workspace", "CONTEXT.md");
    expect(existsSync(contextPath)).toBe(true);
    const content = readFileSync(contextPath, "utf-8");
    expect(content).toContain("Docker sandbox exec is broken");
    expect(content).toContain("This repo uses Bun, not npm");
  });

  test("copies mount files into workspace target", () => {
    const sourceDir = join(tempHome, "mounts");
    mkdirSync(sourceDir, { recursive: true });
    const source = join(sourceDir, "decisions.md");
    writeFileSync(source, "# Decisions\n- Keep it simple\n", "utf-8");

    const manifestPath = join(tempHome, "context-mount.yaml");
    writeFileSync(manifestPath, `
name: mount-team
manager:
  persona: ops
  name: Manager
agents:
  - persona: developer
    name: Dev
context:
  mounts:
    - host: ${source}
      target: DECISIONS.md
      readonly: true
`, "utf-8");

    const teamDir = provisionTeam(manifestPath, branchRoot);
    const mounted = join(teamDir, "workspace", "DECISIONS.md");
    expect(existsSync(mounted)).toBe(true);
    expect(readFileSync(mounted, "utf-8")).toContain("Keep it simple");
  });

  test("rejects mount target traversal", () => {
    const source = join(tempHome, "safe.md");
    writeFileSync(source, "safe", "utf-8");

    const manifestPath = join(tempHome, "bad-target.yaml");
    writeFileSync(manifestPath, `
name: bad-target
manager:
  persona: ops
  name: Manager
agents:
  - persona: developer
    name: Dev
context:
  mounts:
    - host: ${source}
      target: ../escape.md
      readonly: true
`, "utf-8");

    expect(() => provisionTeam(manifestPath, branchRoot)).toThrow(/relative workspace path|escapes workspace/);
  });

  test("rejects mount host outside HOME", () => {
    const manifestPath = join(tempHome, "bad-host.yaml");
    writeFileSync(manifestPath, `
name: bad-host
manager:
  persona: ops
  name: Manager
agents:
  - persona: developer
    name: Dev
context:
  mounts:
    - host: /etc/hosts
      target: HOSTS.md
      readonly: true
`, "utf-8");

    expect(() => provisionTeam(manifestPath, branchRoot)).toThrow(/within HOME/);
  });
});
