import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import { snapshotSoulToDisk } from "../src/utils/agent-lifecycle.js";
import { runGeminiRuntime } from "../src/utils/gemini-runtime.js";
import { FlairClient } from "../src/utils/flair-client.js";
import * as runtimeMail from "../src/utils/runtime-mail.js";

// spyOn needs a top-level restore (mock-restore-guard).
afterEach(() => {
  mock.restore();
});

describe("gemini runtime fallback SOUL under the current HOME (cli#800)", () => {
  it("reads the fallback SOUL.md written at a HOME set after module load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli800-gemini-home-"));
    const savedHome = process.env.HOME;
    const workspace = join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    const soulPath = join(dir, ".tps", "agents", "agent-a", "fallback", "SOUL.md");
    const prompt = { text: "" };
    // The boot preflight answers, then the prompt build's own Flair check
    // fails, which is the branch that reads the disk fallback.
    let pings = 0;
    const pingSpy = spyOn(FlairClient.prototype, "ping").mockImplementation(async () => {
      pings++;
      if (pings === 1) return true;
      throw new Error("fixture flair failure");
    });
    let polls = 0;
    const pollSpy = spyOn(runtimeMail, "pollRuntimeMail").mockImplementation(async () => {
      polls++;
      if (polls > 1) throw new Error("fixture stop");
      return [{
        id: "mail-1",
        from: "agent-b",
        to: "agent-a",
        body: "fixture task",
        timestamp: new Date().toISOString(),
      }];
    });
    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation((() => {
      const proc = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      proc.stdin.on("data", (chunk: Buffer) => {
        prompt.text += chunk.toString();
      });
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("fixture answer\n"));
        proc.emit("close", 0);
      }, 0);
      return proc;
    }) as never);
    try {
      // The modules above were imported under the launcher's HOME; the writer
      // and the runtime's fallback read must both use the fresh HOME set here.
      process.env.HOME = dir;

      const flair = { getSoul: async () => [{ key: "name", value: "agent-a" }] } as unknown as FlairClient;
      await snapshotSoulToDisk(flair, "agent-a");
      expect(readFileSync(soulPath, "utf-8")).toContain("**name:** agent-a");

      await expect(
        runGeminiRuntime({
          agentId: "agent-a",
          workspace,
          mailDir: join(dir, "mail"),
          flairKeyPath: join(dir, "agent-a.key"),
          sessionLogPath: join(dir, "session.log"),
          supervisorId: "host",
          pollIntervalMs: 1,
        }),
      ).rejects.toThrow("fixture stop");

      expect(prompt.text).toContain("**name:** agent-a");
      expect(prompt.text).not.toContain("You are agent-a.");
    } finally {
      spawnSpy.mockRestore();
      pollSpy.mockRestore();
      pingSpy.mockRestore();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
