import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentConfig } from "../src/config.js";

describe("agent config env interpolation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tps-agent-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AGENT_WORKSPACE;
    delete process.env.AGENT_NAME;
  });

  test("resolves ${VAR_NAME} placeholders in string values", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.AGENT_WORKSPACE = "/tmp/ws";
    process.env.AGENT_NAME = "Coder";

    const cfg = join(dir, "agent.yaml");
    writeFileSync(
      cfg,
      [
        "agentId: coder",
        "name: ${AGENT_NAME}",
        "workspace: ${AGENT_WORKSPACE}",
        "mailDir: ${AGENT_WORKSPACE}/mail",
        "llm:",
        "  provider: anthropic",
        "  model: claude-sonnet-4-6",
        "  apiKey: ${ANTHROPIC_API_KEY}",
      ].join("\n"),
      "utf-8"
    );

    const parsed = loadAgentConfig(cfg);
    expect(parsed.name).toBe("Coder");
    expect(parsed.workspace).toBe("/tmp/ws");
    expect(parsed.mailDir).toBe("/tmp/ws/mail");
    expect(parsed.llm.apiKey).toBe("test-key");
  });

  test("throws when referenced env var is missing", () => {
    const cfg = join(dir, "agent-missing.yaml");
    writeFileSync(
      cfg,
      [
        "agentId: coder",
        "name: Coder",
        "workspace: /tmp/ws",
        "llm:",
        "  provider: anthropic",
        "  model: claude-sonnet-4-6",
        "  apiKey: ${MISSING_API_KEY}",
      ].join("\n"),
      "utf-8"
    );

    expect(() => loadAgentConfig(cfg)).toThrow("Missing environment variable: MISSING_API_KEY");
  });

  test("resolves a relative workspace against the config directory", () => {
    const configDir = join(dir, "config");
    mkdirSync(configDir);
    const cfg = join(configDir, "agent.yaml");
    writeFileSync(cfg, "agentId: probe\nworkspace: worktree\n", "utf-8");

    const parsed = loadAgentConfig(cfg);
    const workspace = join(configDir, "worktree");
    expect(parsed.workspace).toBe(workspace);
    expect(isAbsolute(parsed.workspace)).toBe(true);
    expect(parsed.mailDir).toBe(join(workspace, "mail"));
    expect(parsed.memoryPath).toBe(join(workspace, ".openclaw", "agent.memory.jsonl"));
  });

  test("normalizes an absolute workspace before deriving the default paths", () => {
    const cfg = join(dir, "agent.yaml");
    writeFileSync(cfg, `agentId: probe\nworkspace: ${dir}/elsewhere/../other\n`, "utf-8");

    const parsed = loadAgentConfig(cfg);
    expect(parsed.workspace).toBe(join(dir, "other"));
    expect(parsed.mailDir).toBe(join(dir, "other", "mail"));
    expect(parsed.memoryPath).toBe(join(dir, "other", ".openclaw", "agent.memory.jsonl"));
  });

  test("refuses a workspace starting with ~", () => {
    const cfg = join(dir, "agent.yaml");
    writeFileSync(cfg, "agentId: probe\nworkspace: ~/work\n", "utf-8");

    expect(() => loadAgentConfig(cfg)).toThrow(
      "workspace '~/work' starts with '~', which is not expanded: use an absolute path or a path relative to the config file",
    );
  });
});
