import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

describe("roster command", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tps-roster-test-"));
    configPath = join(tempDir, "openclaw.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            list: [
              {
                id: "flint",
                name: "Flint",
                model: { primary: "anthropic/claude-opus-4-6" },
                contacts: {
                  discord: { id: "1472818438786383993", mention: "<@1472818438786383993>" },
                  openclaw: "agent:flint",
                },
                capabilities: {
                  can_receive: ["discord", "openclaw"],
                  can_send: ["discord", "openclaw"],
                },
              },
              {
                id: "kern",
                name: "Kern",
                model: { primary: "google-gemini-cli/gemini-3-pro-preview" },
                contacts: {
                  openclaw: "agent:kern",
                },
                capabilities: {
                  can_receive: ["openclaw"],
                  can_send: ["openclaw"],
                },
              },
            ],
          },
        },
        null,
        2
      ),
      "utf-8"
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function run(args: string[]) {
    return spawnSync("node", [TPS_BIN, ...args], {
      encoding: "utf-8",
      cwd: tempDir,
      env: { ...process.env },
    });
  }

  test("list returns all agents in json", () => {
    const r = run(["roster", "list", "--config", configPath, "--json"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(2);
    expect(out.map((x: any) => x.id)).toEqual(["flint", "kern"]);
  });

  test("show returns contact card with json flag", () => {
    const r = run(["roster", "show", "flint", "--config", configPath, "--json"]);
    expect(r.status).toBe(0);
    const card = JSON.parse(r.stdout);
    expect(card.id).toBe("flint");
    expect(card.contacts.discord.id).toBe("1472818438786383993");
    expect(card.capabilities.can_receive).toContain("discord");
  });

  test("show unknown agent exits with error", () => {
    const r = run(["roster", "show", "ghost", "--config", configPath]);
    expect(r.status).not.toBe(0);
    expect((r.stderr || "") + (r.stdout || "")).toContain('Agent "ghost" not found');
  });

  test("find by channel filters correctly", () => {
    const r = run(["roster", "find", "--channel", "discord", "--config", configPath, "--json"]);
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("flint");
  });

  test("show rejects traversal-like agent ids", () => {
    const r = run(["roster", "show", "../../etc/passwd", "--config", configPath]);
    expect(r.status).not.toBe(0);
    expect((r.stderr || "") + (r.stdout || "")).toContain("Invalid agent id");
  });
});
