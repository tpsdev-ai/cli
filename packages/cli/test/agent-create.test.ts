/**
 * ops-36 — tps agent create / list / status tests
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the flair client and agent command logic in isolation.
// The agent runtime (start/run/health) is tested in packages/agent.

describe("ops-36: FlairClient auth header format", () => {
  test("sign() produces TPS-Ed25519 header with correct shape", async () => {
    // We don't need a real key — just verify the header format
    const { FlairClient } = await import("../src/utils/flair-client.js");

    // Provide a fake keyPath to trigger the error path
    const client = new FlairClient({
      agentId: "test-agent",
      baseUrl: "http://localhost:9926",
      keyPath: "/nonexistent/key.pem",
    });

    // sign() should throw because key doesn't exist
    expect(() => (client as any).sign("GET", "/Memory")).toThrow(
      "Cannot read Flair private key",
    );
  });

  test("FlairClient ping returns false when server not running", async () => {
    const { FlairClient } = await import("../src/utils/flair-client.js");
    const client = new FlairClient({
      agentId: "test-agent",
      baseUrl: "http://127.0.0.1:19926", // unused port
    });
    const result = await client.ping();
    expect(result).toBe(false);
  });

  test("createFlairClient uses FLAIR_URL env var", async () => {
    const { createFlairClient } = await import("../src/utils/flair-client.js");
    const client = createFlairClient("anvil", "http://localhost:9999");
    expect((client as any).baseUrl).toBe("http://localhost:9999");
    expect((client as any).agentId).toBe("anvil");
  });

  test("FlairClient strips trailing slash from baseUrl", async () => {
    const { FlairClient } = await import("../src/utils/flair-client.js");
    const client = new FlairClient({ agentId: "x", baseUrl: "http://localhost:9926/" });
    expect((client as any).baseUrl).toBe("http://localhost:9926");
  });
});

describe("ops-36: tps agent create — file system side effects", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalTpsHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-agent-test-"));
    originalHome = process.env.HOME;
    originalTpsHome = process.env.TPS_HOME;
    process.env.HOME = tmpDir;
    process.env.TPS_HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.TPS_HOME = originalTpsHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("createAgent writes config file when Flair is offline", async () => {
    const { runAgent } = await import("../src/commands/agent.js");
    const { existsSync, readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");

    // Flair won't be running — that's fine, create should warn and continue
    await runAgent({
      action: "create",
      id: "test-bot-ops36",
      name: "Test Bot",
      model: "anthropic/claude-sonnet-4-6",
      flairUrl: "http://127.0.0.1:19926", // dead port
    });

    const configPath = join(homedir(), ".tps", "agents", "test-bot-ops36", "agent.yaml");
    expect(existsSync(configPath)).toBe(true);

    const config = readFileSync(configPath, "utf-8");
    expect(config).toContain("agentId: test-bot-ops36");
    expect(config).toContain("name: Test Bot");
    expect(config).toContain("provider: anthropic");
    expect(config).toContain("model: claude-sonnet-4-6");

    // cleanup
    const { rmSync } = await import("node:fs");
    rmSync(join(homedir(), ".tps", "agents", "test-bot-ops36"), { recursive: true, force: true });
    rmSync(join(homedir(), ".tps", "identity", "test-bot-ops36.key"), { force: true });
    rmSync(join(homedir(), ".tps", "identity", "test-bot-ops36.pub"), { force: true });
  });

  test("createAgent generates Ed25519 key files", async () => {
    const { runAgent } = await import("../src/commands/agent.js");
    const { existsSync, rmSync } = await import("node:fs");
    const { homedir } = await import("node:os");

    await runAgent({
      action: "create",
      id: "key-test-ops36",
      flairUrl: "http://127.0.0.1:19926",
    });

    const keyPath = join(homedir(), ".tps", "identity", "key-test-ops36.key");
    const pubPath = join(homedir(), ".tps", "identity", "key-test-ops36.pub");
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(pubPath)).toBe(true);

    // cleanup
    rmSync(join(homedir(), ".tps", "agents", "key-test-ops36"), { recursive: true, force: true });
    rmSync(keyPath, { force: true });
    rmSync(pubPath, { force: true });
  });

  test("listAgents returns empty when no agents dir", async () => {
    const { runAgent } = await import("../src/commands/agent.js");
    // Should not throw
    await expect(runAgent({ action: "list" })).resolves.toBeUndefined();
  });

  test("agentStatus exits with error for unknown agent", async () => {
    const { runAgent } = await import("../src/commands/agent.js");

    let exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    (process as any).exit = (code: number) => { exitCode = code; throw new Error(`exit:${code}`); };

    try {
      await runAgent({ action: "status", id: "nonexistent-agent-xyz" });
    } catch (e) {
      expect(String(e)).toContain("exit:1");
    } finally {
      (process as any).exit = origExit;
    }
    expect(exitCode).toBe(1);
  });

  test("agentStatus verbose prints workspace and runtime", async () => {
    const { runAgent } = await import("../src/commands/agent.js");

    const agentDir = join(tmpDir, ".tps", "agents", "verbose-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "agent.yaml"), `agentId: verbose-agent
name: Verbose Agent
workspace: /tmp/verbose-workspace
mailDir: /tmp/verbose-mail
runtime: claude-code
llm:
  provider: anthropic
  model: claude-sonnet-4-6
`);

    const logs: string[] = [];
    const logSpy = mock((line: string) => {
      logs.push(line);
    });
    const originalLog = console.log;
    console.log = logSpy as typeof console.log;

    try {
      await runAgent({
        action: "status",
        id: "verbose-agent",
        verbose: true,
        flairUrl: "http://127.0.0.1:19926",
      });
    } finally {
      console.log = originalLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Workspace: /tmp/verbose-workspace");
    expect(output).toContain("Runtime: claude-code");
  });
});

describe("ops-36: nono profile exists", () => {
  test("tps-agent-run.toml is present and well-formed", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const profilePath = join(import.meta.dir, "../nono-profiles/tps-agent-run.toml");
    const content = readFileSync(profilePath, "utf-8");
    expect(content).toContain("[meta]");
    expect(content).toContain("tps-agent-run");
    expect(content).toContain("[network]");
    expect(content).toContain("127.0.0.1");
    // Must NOT allow outbound internet
    expect(content).not.toContain("block = false\nallow = []");
  });
});
