import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("soundstage", () => {
  let tempDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tps-soundstage-"));
    process.env.HOME = tempDir;
    process.env.TPS_VAULT_KEY = "test-passphrase";
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    delete process.env.TPS_VAULT_KEY;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("soundstage rewrites config to mock LLM", () => {
    const manifestPath = join(tempDir, "office.yaml");
    writeFileSync(manifestPath, `
name: stage-team
purpose: development
manager:
  name: Director
  persona: ops
agents:
  - name: Actor
    persona: developer
`, "utf-8");

    // Provision team first (soundstage needs existing workspace)
    const { provisionTeam } = require("../src/utils/provision.js");
    provisionTeam(manifestPath, join(tempDir, ".tps", "branch-office"));

    // Check that openclaw.json has real config before soundstage
    const configPath = join(tempDir, ".tps", "branch-office", "stage-team", ".openclaw", "openclaw.json");
    const beforeConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(beforeConfig.agents.defaults.model.primary).toBe("anthropic/claude-sonnet-4-6");

    // Simulate soundstage config rewrite
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.agents.defaults.model.primary = "openai-compatible/mock-soundstage";
    config.agents.defaults.model.fallbacks = [];
    config.agents.defaults.baseUrl = "http://127.0.0.1:11434/v1";
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Verify rewrite
    const afterConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(afterConfig.agents.defaults.model.primary).toBe("openai-compatible/mock-soundstage");
    expect(afterConfig.agents.defaults.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(afterConfig.agents.defaults.model.fallbacks).toEqual([]);
  });

  test("soundstage marker is outside workspace mount", () => {
    // Marker goes in team root, not workspace
    const teamRoot = join(tempDir, ".tps", "branch-office", "test-team");
    const workspace = join(teamRoot, "workspace");
    const markerPath = join(teamRoot, "soundstage.json");
    
    // Marker is NOT inside workspace
    expect(markerPath.startsWith(workspace)).toBe(false);
  });

  test("soundstage replaces __TEAM_ROOT__ in bootstrap.sh", () => {
    const manifestPath = join(tempDir, "office.yaml");
    writeFileSync(manifestPath, `
name: stage-team2
purpose: development
manager:
  name: Director
  persona: ops
agents:
  - name: Actor
    persona: developer
`, "utf-8");

    const { provisionTeam } = require("../src/utils/provision.js");
    provisionTeam(manifestPath, join(tempDir, ".tps", "branch-office"));

    const result = spawnSync(process.execPath, [
      join(import.meta.dir, "..", "dist", "bin", "tps.js"),
      "office", "start", "stage-team2",
      "--manifest", manifestPath,
      "--soundstage",
    ], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tempDir,
        TPS_OFFICE_SKIP_RELAY: "1",
        TPS_OFFICE_SKIP_VM: "1",
      },
    });

    if (result.status !== 0) {
      console.error("STDERR:", result.stderr);
      console.error("STDOUT:", result.stdout);
    }
    expect(result.status).toBe(0);

    const teamRoot = join(tempDir, ".tps", "branch-office", "stage-team2");
    const bootstrapPath = join(teamRoot, "bootstrap.sh");
    expect(existsSync(bootstrapPath)).toBe(true);

    const bootstrap = readFileSync(bootstrapPath, "utf-8");
    expect(bootstrap).not.toContain("__TEAM_ROOT__");
    expect(bootstrap).toContain(teamRoot);
  });
});
