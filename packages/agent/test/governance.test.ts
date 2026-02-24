import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoundaryManager } from "../src/governance/boundary.js";
import { ReviewGate } from "../src/governance/review-gate.js";
import { MailClient } from "../src/io/mail.js";
import { ToolRegistry } from "../src/tools/registry.js";

describe("BoundaryManager", () => {
  test("allows registered network host", () => {
    const mgr = new BoundaryManager();
    mgr.addNetworkHost("api.anthropic.com");
    expect(mgr.isNetworkAllowed("api.anthropic.com")).toBe(true);
    expect(mgr.isNetworkAllowed("evil.com")).toBe(false);
  });

  test("wildcard allows any host", () => {
    const mgr = new BoundaryManager();
    mgr.addNetworkHost("*");
    expect(mgr.isNetworkAllowed("api.anthropic.com")).toBe(true);
  });

  test("allows registered path prefix", () => {
    const mgr = new BoundaryManager();
    mgr.addPath("/workspace");
    expect(mgr.isPathAllowed("/workspace/src")).toBe(true);
    expect(mgr.isPathAllowed("/etc/passwd")).toBe(false);
  });

  test("describeCapabilities returns readable string", () => {
    const mgr = new BoundaryManager();
    mgr.addNetworkHost("api.anthropic.com");
    mgr.addPath("/workspace");
    const desc = mgr.describeCapabilities();
    expect(desc).toContain("api.anthropic.com");
    expect(desc).toContain("/workspace");
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

  test("identifies high-risk tools", () => {
    const gate = new ReviewGate(mail, "host@tps");
    expect(gate.isHighRisk("git_push")).toBe(true);
    expect(gate.isHighRisk("file_delete")).toBe(true);
    expect(gate.isHighRisk("fs_read")).toBe(false);
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
      parameters: { input: { type: "string", description: "text to echo" } },
      async execute(args) {
        return String(args.input);
      },
    });

    const result = await registry.execute("echo", { input: "hello" });
    expect(result).toBe("hello");
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
      parameters: {},
      async execute() { return ""; },
    });
    expect(registry.list().length).toBe(1);
    expect(registry.list()[0]!.name).toBe("echo");
  });
});
