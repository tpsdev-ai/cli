import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
});
