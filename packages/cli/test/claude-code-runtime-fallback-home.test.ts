import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lifecycle from "../src/utils/agent-lifecycle.js";
import { snapshotSoulToDisk } from "../src/utils/agent-lifecycle.js";
import { runClaudeCodeRuntime } from "../src/utils/claude-code-runtime.js";
import { FlairClient } from "../src/utils/flair-client.js";
import * as runtimeMail from "../src/utils/runtime-mail.js";

// spyOn needs a top-level restore (mock-restore-guard).
afterEach(() => {
  mock.restore();
});

describe("claude code runtime fallback SOUL under the current HOME (cli#800)", () => {
  it("resolves the fallback SOUL.md at a HOME set after module load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli800-claude-home-"));
    const savedHome = process.env.HOME;
    const workspace = join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    const soulPath = join(dir, ".tps", "agents", "agent-a", "fallback", "SOUL.md");
    const resolveReal = lifecycle.getFallbackSoulPath;
    const resolved: string[] = [];
    try {
      // The modules above were imported under the launcher's HOME; the writer
      // and the runtime's boot branch must both use the fresh HOME set here.
      process.env.HOME = dir;

      const flair = { getSoul: async () => [{ key: "name", value: "agent-a" }] } as unknown as FlairClient;
      await snapshotSoulToDisk(flair, "agent-a");
      expect(readFileSync(soulPath, "utf-8")).toContain("**name:** agent-a");

      const pathSpy = spyOn(lifecycle, "getFallbackSoulPath").mockImplementation((agentId) => {
        const path = resolveReal(agentId);
        resolved.push(path);
        return path;
      });
      const pingSpy = spyOn(FlairClient.prototype, "ping").mockResolvedValue(false);
      const pollSpy = spyOn(runtimeMail, "pollRuntimeMail").mockRejectedValue(new Error("fixture stop"));
      try {
        await expect(
          runClaudeCodeRuntime({
            agentId: "agent-a",
            workspace,
            mailDir: join(dir, "mail"),
            flairKeyPath: join(dir, "agent-a.key"),
            supervisorId: "host",
          }),
        ).rejects.toThrow("fixture stop");
      } finally {
        pollSpy.mockRestore();
        pingSpy.mockRestore();
        pathSpy.mockRestore();
      }

      // The boot branch resolved the one shared helper at the temp HOME.
      expect(resolved).toContain(soulPath);
      expect(existsSync(soulPath)).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
