import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");


describe("bootstrap command", () => {
  let tempRoot: string;
  let originalHome: string | undefined;
  let fakeBin = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-bootstrap-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempRoot;

    // Fake helper binaries for bootstrap health checks.
    fakeBin = mkdtempSync(join(tempRoot, "tools-"));
    mkdirSync(fakeBin, { recursive: true });

    const fakeNonoSource = join(import.meta.dir, "fakes", "nono", "bin", "nono");
    const fakeProfileSource = join(import.meta.dir, "..", "nono-profiles", "tps-bootstrap.toml");
    copyFileSync(fakeNonoSource, join(fakeBin, "nono"));

    writeFileSync(
      join(fakeBin, "openclaw"),
      `#!/usr/bin/env bash
if [[ "$1" == "gateway" && "$2" == "status" ]]; then
  echo "gateway: ok"
  exit 0
fi
exit 0
`,
      "utf-8"
    );

    chmodSync(join(fakeBin, "nono"), 0o755);
    chmodSync(join(fakeBin, "openclaw"), 0o755);

    const profileDir = join(tempRoot, ".config", "nono", "profiles");
    mkdirSync(profileDir, { recursive: true });
    copyFileSync(fakeProfileSource, join(profileDir, "tps-bootstrap.toml"));
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(tempRoot, { recursive: true, force: true });
    if (fakeBin) rmSync(fakeBin, { recursive: true, force: true });
  });

  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync("bun", [TPS_BIN, ...args], {
      encoding: "utf-8",
      cwd: tempRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TPS_BOOTSTRAP_MODEL: "anthropic/claude-sonnet-4-20250514",
        ...env,
      },
    });
  }

  test("bootstrap creates required files, updates config, and marks complete", () => {
    const agentId = "bootagent";
    const workspace = join(tempRoot, ".tps", "branch-office", agentId);
    mkdirSync(workspace, { recursive: true });

    const r = run(["bootstrap", agentId]);
    expect(r.status).toBe(0);

    expect(existsSync(join(workspace, "SOUL.md"))).toBe(true);
    expect(existsSync(join(workspace, "IDENTITY.md"))).toBe(true);
    expect(existsSync(join(workspace, "USER.md"))).toBe(true);
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(workspace, "TOOLS.md"))).toBe(true);
    expect(existsSync(join(workspace, "HEARTBEAT.md"))).toBe(true);
    expect(existsSync(join(workspace, "memory"))).toBe(true);

    const configPath = join(tempRoot, ".tps", "branch-office", agentId, ".openclaw", "openclaw.json");
    expect(existsSync(configPath)).toBe(true);

    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    const agent = cfg.agents.list.find((a: any) => a.id === agentId);
    expect(agent).toBeTruthy();
    expect(agent.workspace).toBe(workspace);
    expect(agent.channel).toBe("discord");
    expect(agent.model).toBe("anthropic/claude-sonnet-4-20250514");

    expect(existsSync(join(tempRoot, ".tps", "bootstrap-state", agentId, ".bootstrap-complete"))).toBe(true);

    const mailDir = join(workspace, "mail", "inbox", "new");
    const mailFiles = readdirSync(mailDir).filter((f) => f.endsWith(".json"));
    expect(mailFiles.length).toBeGreaterThanOrEqual(1);

    const intro = mailFiles
      .map((f) => JSON.parse(readFileSync(join(mailDir, f), "utf-8")))
      .find((m) => typeof m.body === "string" && m.body.includes("Welcome"));
    expect(intro?.from).toBe("system:bootstrap");
    expect(intro?.body).toContain("Welcome");
  });

  test("bootstrap rejects invalid agent id", () => {
    const r = run(["bootstrap", "../../etc/passwd"]);
    expect(r.status).not.toBe(0);
    expect((r.stderr + r.stdout)).toContain("Invalid agent id");
  });

  test("bootstrap fails when workspace does not exist", () => {
    const r = run(["bootstrap", "missing-agent"]);
    expect(r.status).not.toBe(0);
    expect((r.stderr + r.stdout)).toContain("No workspace found");
  });
});
