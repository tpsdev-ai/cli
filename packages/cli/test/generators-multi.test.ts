import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { parseTPSReport } from "../src/schema/report.js";
import { generateClaudeCode } from "../src/generators/claude-code.js";
import { generateOllama } from "../src/generators/ollama.js";
import { generateCodex } from "../src/generators/codex.js";

const FIXTURES = join(import.meta.dir, "..", "personas");

describe("claude-code generator", () => {
  test("generates CLAUDE.md and settings", () => {
    const report = parseTPSReport(join(FIXTURES, "developer.tps"));
    const result = generateClaudeCode(report, { name: "Scout", workspace: "/tmp/test-cc" });

    expect(result.agentId).toBe("scout");
    expect(result.agentName).toBe("Scout");
    expect(result.files["CLAUDE.md"]).toContain("Scout");
    expect(result.files["CLAUDE.md"]).toContain("Developer");
    expect(result.files[".claude/settings.json"]).toContain("permissions");
  });

  test("uses custom name in output", () => {
    const report = parseTPSReport(join(FIXTURES, "developer.tps"));
    const result = generateClaudeCode(report, { name: "Blade" });

    expect(result.agentId).toBe("blade");
    expect(result.files["CLAUDE.md"]).toContain("Blade");
  });
});

describe("ollama generator", () => {
  test("generates Modelfile and README", () => {
    const report = parseTPSReport(join(FIXTURES, "ops.tps"));
    const result = generateOllama(report, { name: "Monitor", workspace: "/tmp/test-ollama" });

    expect(result.agentId).toBe("monitor");
    expect(result.modelTag).toBe("tps-monitor");
    expect(result.files["Modelfile"]).toContain("FROM llama3.1:8b");
    expect(result.files["Modelfile"]).toContain("SYSTEM");
    expect(result.files["Modelfile"]).toContain("Monitor");
    expect(result.files["README.md"]).toContain("ollama create tps-monitor");
  });

  test("uses custom base model", () => {
    const report = parseTPSReport(join(FIXTURES, "developer.tps"));
    const result = generateOllama(report, { name: "Dev", baseModel: "qwen2.5:14b" });

    expect(result.files["Modelfile"]).toContain("FROM qwen2.5:14b");
  });
});

describe("codex generator", () => {
  test("generates AGENTS.md and config", () => {
    const report = parseTPSReport(join(FIXTURES, "developer.tps"));
    const result = generateCodex(report, { name: "Coder", workspace: "/tmp/test-codex" });

    expect(result.agentId).toBe("coder");
    expect(result.files["AGENTS.md"]).toContain("Coder");
    expect(result.files["AGENTS.md"]).toContain("Developer");
    const config = JSON.parse(result.files[".codex/config.json"]);
    expect(config.model).toBe("o3");
    expect(config.instructions_file).toBe("AGENTS.md");
  });
});
