import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import { FlairClient } from "../src/utils/flair-client.js";
import * as runtimeMail from "../src/utils/runtime-mail.js";

const startHome = process.env.HOME;

// spyOn needs a top-level restore whose only statement is mock.restore() (mock-restore-guard).
afterEach(() => {
  mock.restore();
});

afterEach(() => {
  process.env.HOME = startHome;
});

let homeA: string;
let homeB: string;

beforeAll(() => {
  homeA = mkdtempSync(join(tmpdir(), "cli822-home-a-"));
  homeB = mkdtempSync(join(tmpdir(), "cli822-home-b-"));
});

afterAll(() => {
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });
});

/** A spawned runtime child that writes one result and closes cleanly. */
function fakeChild(output: string): EventEmitter {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  proc.stdout.on("data", () => {});
  setTimeout(() => {
    proc.stdout.emit("data", Buffer.from(output));
    proc.emit("close", 0);
  }, 0);
  return proc;
}

/** One fixture message, then a terminal error so the runtime loop stops. */
function oneMessageThenStop(): () => Promise<Array<Record<string, string>>> {
  let polls = 0;
  return async () => {
    polls++;
    if (polls > 1) throw new Error("fixture stop");
    return [{
      id: "mail-1",
      from: "agent-b",
      to: "agent-a",
      body: "fixture task",
      timestamp: new Date().toISOString(),
    }];
  };
}

describe("cli#822: the runtimes resolve paths under the HOME in effect at the call", () => {
  it("claude code writes its default session log under a HOME set after module load", async () => {
    process.env.HOME = homeA;
    // The module loads under homeA; the paths it acts on must follow homeB.
    const mod = await import("../src/utils/claude-code-runtime.js?runtime-paths-822");
    process.env.HOME = homeB;

    const workspace = join(homeB, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "SOUL.md"), "fixture soul\n");
    mkdirSync(join(homeB, ".tps", "agents", "agent-a"), { recursive: true });

    spyOn(FlairClient.prototype, "ping").mockResolvedValue(false);
    spyOn(FlairClient.prototype, "writeMemory").mockResolvedValue(undefined);
    spyOn(runtimeMail, "pollRuntimeMail").mockImplementation(oneMessageThenStop());
    spyOn(childProcess, "spawn").mockImplementation((() =>
      fakeChild(`${JSON.stringify({ type: "result", result: "fixture answer" })}\n`)) as never);

    await expect(
      mod.runClaudeCodeRuntime({
        agentId: "agent-a",
        workspace,
        mailDir: join(homeB, "mail"),
        flairKeyPath: join(homeB, "agent-a.key"),
        supervisorId: "host",
      }),
    ).rejects.toThrow("fixture stop");

    expect(existsSync(join(homeB, ".tps", "agents", "agent-a", "session.log"))).toBe(true);
    expect(existsSync(join(homeA, ".tps", "agents", "agent-a", "session.log"))).toBe(false);
  }, 30_000);

  it("gemini writes its default session log and tps shim PATH under that HOME", async () => {
    process.env.HOME = homeA;
    const mod = await import("../src/utils/gemini-runtime.js?runtime-paths-822");
    process.env.HOME = homeB;

    const workspace = join(homeB, "workspace");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(homeB, ".tps", "agents", "agent-a"), { recursive: true });
    const environments: NodeJS.ProcessEnv[] = [];

    spyOn(FlairClient.prototype, "ping").mockResolvedValue(false);
    spyOn(FlairClient.prototype, "writeMemory").mockResolvedValue(undefined);
    spyOn(runtimeMail, "pollRuntimeMail").mockImplementation(oneMessageThenStop());
    spyOn(childProcess, "spawn").mockImplementation(((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      if (opts?.env) environments.push(opts.env);
      return fakeChild("fixture answer\n");
    }) as never);

    await expect(
      mod.runGeminiRuntime({
        agentId: "agent-a",
        workspace,
        mailDir: join(homeB, "mail"),
        flairKeyPath: join(homeB, "agent-a.key"),
        supervisorId: "host",
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("fixture stop");

    expect(existsSync(join(homeB, ".tps", "agents", "agent-a", "session.log"))).toBe(true);
    expect(existsSync(join(homeA, ".tps", "agents", "agent-a", "session.log"))).toBe(false);
    expect(environments.length).toBeGreaterThan(0);
    expect(String(environments[0]?.PATH ?? "").split(":")[0]).toBe(join(homeB, ".tps", "bin"));
  }, 30_000);
});
