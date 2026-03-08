import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("tps agent logs runtime tail", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalTpsHome: string | undefined;
  let originalWrite: typeof process.stdout.write;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  function writeSessionLog(agentId: string, content: string): void {
    const logDir = join(tempHome, ".tps", "agents", agentId);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "session.log"), content, "utf-8");
  }

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tps-agent-runtime-logs-"));
    originalHome = process.env.HOME;
    originalTpsHome = process.env.TPS_HOME;
    originalWrite = process.stdout.write.bind(process.stdout);
    originalError = console.error;
    originalExit = process.exit;
    process.env.HOME = tempHome;
    process.env.TPS_HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalTpsHome === undefined) delete process.env.TPS_HOME;
    else process.env.TPS_HOME = originalTpsHome;
    process.stdout.write = originalWrite;
    console.error = originalError;
    process.exit = originalExit;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("shows the last 50 lines by default", async () => {
    const { runAgent } = await import("../src/commands/agent.js");
    const output: string[] = [];
    writeSessionLog(
      "ember",
      Array.from({ length: 60 }, (_, index) => `line-${index + 1}`).join("\n") + "\n",
    );
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stdout.write;

    await runAgent({ action: "logs", id: "ember" });

    expect(output.join("")).toBe(
      Array.from({ length: 50 }, (_, index) => `line-${index + 11}\n`).join(""),
    );
  });

  test("respects a custom line count", async () => {
    const { runAgent } = await import("../src/commands/agent.js");
    const output: string[] = [];
    writeSessionLog(
      "ember",
      ["alpha", "beta", "gamma", "delta"].join("\n"),
    );
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stdout.write;

    await runAgent({ action: "logs", id: "ember", lines: 2 });

    expect(output.join("")).toBe("gamma\ndelta\n");
  });

  test("fails when the runtime log does not exist", async () => {
    const { runAgent } = await import("../src/commands/agent.js");
    const errors: string[] = [];
    console.error = ((value?: unknown) => {
      errors.push(String(value ?? ""));
    }) as typeof console.error;
    process.exit = (((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    await expect(runAgent({ action: "logs", id: "ember" })).rejects.toThrow("exit:1");
    expect(errors.join("\n")).toContain("No log file found for ember");
  });
});
