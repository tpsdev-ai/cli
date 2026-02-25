import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

describe("backup + restore", () => {
  let tempRoot: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-backup-"));
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    process.env.HOME = tempRoot;
    process.env.TPS_VAULT_KEY = "backup-passphrase";

    const fakeBin = join(tempRoot, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });

    // Fake openclaw gateway command for restore health checks.
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
    chmodSync(join(fakeBin, "openclaw"), 0o755);

    process.env.PATH = `${fakeBin}:${process.env.PATH}`;
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalPath) process.env.PATH = originalPath;
    delete process.env.TPS_VAULT_KEY;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function run(args: string[]) {
    const result = spawnSync("bun", [TPS_BIN, ...args], {
      cwd: tempRoot,
      encoding: "utf-8",
      env: process.env,
    });
    if (result.status !== 0) {
      console.error(`[backup-test] exit=${result.status} HOME=${process.env.HOME}`);
      console.error(`[backup-test] stderr=${result.stderr}`);
      console.error(`[backup-test] stdout=${result.stdout}`);
    }
    return result;
  }

  function createWorkspace(agent: string) {
    const workspace = join(tempRoot, ".tps", "branch-office", agent);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(workspace, "mail", "inbox", "new"), { recursive: true });
    mkdirSync(join(workspace, "memory"), { recursive: true });

    writeFileSync(
      join(workspace, "SOUL.md"),
      `# SOUL\n**Role:** Developer\n**Name:** ${agent}\n`,
      "utf-8"
    );
    writeFileSync(
      join(workspace, "IDENTITY.md"),
      `# IDENTITY\n**Name:** ${agent}\n**Emoji:** 🤖\n`,
      "utf-8"
    );
    writeFileSync(join(workspace, "USER.md"), `# USER\n\n**User:** Nathan\n`, "utf-8");
    writeFileSync(join(workspace, "AGENTS.md"), `# AGENTS\n- test`, "utf-8");
    writeFileSync(join(workspace, "TOOLS.md"), `# TOOLS\nLocal notes`, "utf-8");
    writeFileSync(join(workspace, "HEARTBEAT.md"), `# HEARTBEAT\n# Keep empty`, "utf-8");
    writeFileSync(join(workspace, "MEMORY.md"), `## 2026-02-24\nSaved workspace`, "utf-8");
    writeFileSync(join(workspace, "memory", "2026-02-24.md"), `log`, "utf-8");

    return workspace;
  }

  function seedConfig(agent: string, workspace: string) {
    const configPath = join(tempRoot, ".openclaw", "openclaw.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            defaults: { workspace },
            list: [{ id: agent, name: agent, workspace, model: "anthropic/claude-sonnet" }],
          },
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );
    return configPath;
  }

  test("backup command emits archive with manifest", () => {
    const agent = "alice";
    const workspace = createWorkspace(agent);
    const cfg = seedConfig(agent, workspace);

    const r = run(["backup", agent]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Backup complete");

    const backupDir = join(tempRoot, ".tps", "backups", agent);
    const files = readdirSync(backupDir).filter((f) => f.endsWith(".tps-backup.tar.gz"));
    expect(files.length).toBe(1);

    const archive = join(backupDir, files[0]!);
    expect(existsSync(archive)).toBe(true);
    expect(readFileSync(archive).length).toBeGreaterThan(32);

    // manifest and workspace files should be in archive.
    const list = spawnSync("tar", ["-tzf", archive], { encoding: "utf-8" });
    expect(list.status).toBe(0);
    const out = list.stdout || "";
    expect(out).toContain("manifest.json");
    expect(out).toContain("workspace/SOUL.md");
    expect(out).toContain("openclaw.agent.json");

    expect(readFileSync(cfg, "utf-8")).toContain(agent);
  });

  test("restore clone replaces identity markers and writes restore marker", () => {
    const source = "builder";
    const sourceWs = createWorkspace(source);
    seedConfig(source, sourceWs);

    const backup = run(["backup", source]);
    expect(backup.status).toBe(0);

    const backupDir = join(tempRoot, ".tps", "backups", source);
    const files = readdirSync(backupDir).filter((f) => f.endsWith(".tps-backup.tar.gz"));
    expect(files.length).toBe(1);
    const archive = join(backupDir, files[0]!);

    const target = "cloned-agent";
    const targetWs = join(tempRoot, ".tps", "branch-office", target);
    mkdirSync(targetWs, { recursive: true });
    writeFileSync(join(targetWs, "SOUL.md"), `# SOUL\n**Name:** old\n**Role:** Old\n`, "utf-8");

    const restore = run(["restore", target, "--from", archive, "--clone"]);
    expect(restore.status).toBe(0);

    expect(readFileSync(join(targetWs, "SOUL.md"), "utf-8")).toContain(`**Name:** ${target}`);
    expect(readFileSync(join(targetWs, "IDENTITY.md"), "utf-8")).toContain(`**Name:** ${target}`);

    const restoreMarker = join(tempRoot, ".tps", "restore-state", `${target}.restore-complete`);
    expect(existsSync(restoreMarker)).toBe(true);
    expect(readFileSync(restoreMarker, "utf-8")).toContain(target);
  });
});
