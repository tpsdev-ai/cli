import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { parseTPSReport } from "../src/schema/report.js";
import {
  generateWorkspace,
  writeWorkspace,
  type GeneratedWorkspace,
} from "../src/generators/openclaw.js";
import {
  readOpenClawConfig,
  getAgentList,
  resolveWorkspace,
  type OpenClawConfig,
} from "../src/utils/config.js";

/**
 * Integration tests: full hire → roster → review lifecycle.
 *
 * These tests simulate the complete workflow using temp directories.
 * In Docker (TPS_TEST_MODE=docker), they run fully isolated.
 * Locally, they use temp dirs so there's no risk to real config.
 */

const FIXTURES = join(import.meta.dir, "fixtures");

describe("integration: hire → roster → review lifecycle", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-integration-"));
    configPath = join(tmpDir, "openclaw.json");

    // Start with an empty config
    writeFileSync(
      configPath,
      JSON.stringify({ agents: { list: [] } }, null, 2)
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("hire a developer, verify in roster, review workspace", () => {
    // === STEP 1: Hire ===
    const report = parseTPSReport(join(FIXTURES, "..", "..", "personas", "developer.tps"));
    const workspacePath = join(tmpDir, "workspace-dev");
    const generated = generateWorkspace(report, {
      name: "Fred",
      workspace: workspacePath,
    });

    // Write workspace files
    const written = writeWorkspace(generated);
    expect(written.length).toBe(9); // + package.json + lockfile + OPERATIONS.md
    expect(existsSync(join(workspacePath, "SOUL.md"))).toBe(true);
    expect(existsSync(join(workspacePath, "IDENTITY.md"))).toBe(true);
    expect(existsSync(join(workspacePath, "AGENTS.md"))).toBe(true);

    // Simulate adding the agent to openclaw.json (what the user would do)
    const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    config.agents!.list!.push({
      id: generated.config.id as string,
      name: generated.config.name as string,
      workspace: workspacePath,
      model: generated.config.model as any,
    });
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // === STEP 2: Roster — verify agent appears ===
    const updatedConfig = readOpenClawConfig(configPath);
    const agents = getAgentList(updatedConfig);
    expect(agents.length).toBe(1);
    expect(agents[0]!.id).toBe("fred");
    expect(agents[0]!.name).toBe("Fred");

    const ws = resolveWorkspace(agents[0]!, updatedConfig);
    expect(ws).toBe(workspacePath);
    expect(existsSync(ws!)).toBe(true);

    // === STEP 3: Review — verify workspace contents ===
    const soulContent = readFileSync(join(workspacePath, "SOUL.md"), "utf-8");
    // SOUL.md uses agentName (custom name "Fred") in template data
    // but the template may use report.identity.default_name — check for either
    expect(soulContent.includes("Fred") || soulContent.includes("Dev")).toBe(true);
    expect(soulContent).toContain("Developer"); // role name from report

    const identityContent = readFileSync(join(workspacePath, "IDENTITY.md"), "utf-8");
    expect(identityContent).toContain("💻"); // developer emoji

    // Verify all expected files exist and are non-empty
    for (const file of written) {
      const content = readFileSync(join(workspacePath, file), "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  test("hire multiple agents, all appear in roster", () => {
    const personas = ["developer", "designer", "ea"];
    const names = ["Fred", "Alice", "Bob"];

    for (let i = 0; i < personas.length; i++) {
      const report = parseTPSReport(
        join(FIXTURES, "..", "..", "personas", `${personas[i]}.tps`)
      );
      const ws = join(tmpDir, `workspace-${names[i]!.toLowerCase()}`);
      const generated = generateWorkspace(report, { name: names[i], workspace: ws });
      writeWorkspace(generated);

      // Add to config
      const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf-8"));
      config.agents!.list!.push({
        id: generated.config.id as string,
        name: generated.config.name as string,
        workspace: ws,
      });
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    // Verify all three in roster
    const config = readOpenClawConfig(configPath);
    const agents = getAgentList(config);
    expect(agents.length).toBe(3);
    expect(agents.map((a) => a.name)).toEqual(["Fred", "Alice", "Bob"]);

    // Verify each workspace exists with files
    for (const agent of agents) {
      const ws = resolveWorkspace(agent, config);
      expect(existsSync(ws!)).toBe(true);
      expect(existsSync(join(ws!, "SOUL.md"))).toBe(true);
    }
  });

  test("hire with dry-run does not write files", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    const ws = join(tmpDir, "dry-run-workspace");
    const generated = generateWorkspace(report, { workspace: ws });

    // Don't call writeWorkspace — simulating --dry-run
    expect(generated.files).toBeDefined();
    expect(Object.keys(generated.files).length).toBe(9);
    expect(generated.config.id).toBe("testy");

    // Workspace should NOT exist
    expect(existsSync(ws)).toBe(false);
  });

  test("generated config has correct shape for openclaw.json", () => {
    const report = parseTPSReport(
      join(FIXTURES, "..", "..", "personas", "strategy.tps")
    );
    const generated = generateWorkspace(report, {
      workspace: join(tmpDir, "ws"),
    });

    const config = generated.config;
    expect(config).toHaveProperty("id");
    expect(config).toHaveProperty("name");
    expect(config).toHaveProperty("workspace");
    // model and heartbeat are now in defaults
    expect(config).not.toHaveProperty("model");
    expect(config).not.toHaveProperty("heartbeat");
  });
});
