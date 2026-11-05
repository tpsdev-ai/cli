// cli#750 — command failure paths that print an error must also set a
// non-zero status. Each test spawns the built CLI with an empty HOME.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

let home: string;
let fakeBin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tps-exit-750-"));
  fakeBin = join(home, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "openclaw"),
    '#!/usr/bin/env bash\nif [[ "$1" == "gateway" && "$2" == "status" ]]; then echo "gateway: ok"; exit 0; fi\nexit 0\n',
    "utf-8",
  );
  chmodSync(join(fakeBin, "openclaw"), 0o755);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function runTps(args: string[], env: Record<string, string> = {}): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", TPS_BIN, ...args], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      HOME: home,
      TMPDIR: home,
      ...env,
    },
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

describe("cli#750 — command failure paths exit non-zero", () => {
  test("`tps heartbeat` exits 1 when the workspace write check fails", async () => {
    const agent = "agent-a";
    const workspace = join(home, ".tps", "branch-office", agent);
    // A regular file where the workspace directory belongs: the write check
    // fails with ENOTDIR for every uid, including root in the Docker lane.
    mkdirSync(join(home, ".tps", "branch-office"), { recursive: true });
    writeFileSync(workspace, "not a directory", "utf-8");

    const result = await runTps(["heartbeat", agent]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("workspace write check failed");
  });

  test("`tps heartbeat` exits 0 when every check passes", async () => {
    const agent = "agent-b";
    const workspace = join(home, ".tps", "branch-office", agent);
    mkdirSync(join(workspace, "mail", "inbox", "new"), { recursive: true });

    const result = await runTps(["heartbeat", agent]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Heartbeat for ${agent}: online`);
  });
});
