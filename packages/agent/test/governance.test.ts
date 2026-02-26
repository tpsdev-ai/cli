import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BoundaryManager } from "../src/governance/boundary.js";
import { ReviewGate } from "../src/governance/review-gate.js";
import { MailClient } from "../src/io/mail.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { makeReadTool, makeWriteTool, makeEditTool } from "../src/tools/index.js";

describe("BoundaryManager", () => {
  let workspace: string;
  let boundary: BoundaryManager;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "tps-boundary-"));
    boundary = new BoundaryManager(workspace);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("allows registered network host", () => {
    boundary.addNetworkHost("api.openai.com");
    expect(boundary.isNetworkAllowed("api.openai.com")).toBe(true);
    expect(boundary.isNetworkAllowed("evil.com")).toBe(false);
  });

  test("blocks path traversal", () => {
    expect(() => boundary.resolveWorkspacePath("../secret.txt")).toThrow();
  });

  test("describeCapabilities returns readable string", () => {
    boundary.addNetworkHost("api.anthropic.com");
    const desc = boundary.describeCapabilities();
    expect(desc).toContain("api.anthropic.com");
    expect(desc).toContain(workspace);
  });
});

describe("ReviewGate", () => {
  let tmpDir: string;
  let mail: MailClient;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-gate-test-"));
    mail = new MailClient(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("requestApproval sends mail to approver", async () => {
    const gate = new ReviewGate(mail, "host@tps");
    await gate.requestApproval("git_push", { branch: "main" });
    const { readdirSync } = await import("node:fs");
    const outbox = join(tmpDir, "outbox", "new");
    expect(readdirSync(outbox).length).toBe(1);
  });
});

describe("ToolRegistry", () => {
  test("registers and executes a tool", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echo input",
      input_schema: { input: { type: "string" } },
      async execute(args) {
        return { content: String((args as any).input) };
      },
    });

    const result = await registry.execute("echo", { input: "hello" });
    expect(result.content).toBe("hello");
  });

  test("throws for unknown tool", async () => {
    const registry = new ToolRegistry();
    await expect(registry.execute("noop", {})).rejects.toThrow("Unknown tool: noop");
  });

  test("lists registered tools", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echo input",
      input_schema: { input: { type: "string" } },
      async execute() {
        return { content: "" };
      },
    });
    expect(registry.list().length).toBe(1);
    expect(registry.list()[0]!.name).toBe("echo");
  });
});

describe("Read/Write/Edit tools", () => {
  let tmpDir: string;
  let boundary: BoundaryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-tools-"));
    boundary = new BoundaryManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("edit fails if old_string appears more than once", async () => {
    const tool = makeEditTool(boundary);
    const file = join(tmpDir, "a.txt");
    writeFileSync(file, "abc abc", "utf-8");
    const out = await tool.execute({ path: file, old_string: "abc", new_string: "xyz" });
    expect(out.isError).toBe(true);
  });

  test("write/read round trip", async () => {
    const read = makeReadTool(boundary);
    const write = makeWriteTool(boundary);

    const result = await write.execute({ path: "foo.txt", content: "hello" });
    expect(result.isError).toBe(false);
    const readResult = await read.execute({ path: "foo.txt" });
    expect(readResult.content).toContain("hello");
  });
});
