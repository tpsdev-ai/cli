// cli#740 — the entry point exits with the status the command set. A command
// reports a failure by setting process.exitCode and returning; the entry point
// must not replace it with 0. These tests spawn the real bin/tps.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tps-exit-740-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function runTps(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", TPS_BIN, ...args], {
    // An empty HOME keeps the run away from any real ~/.tps registry.
    env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home },
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

describe("cli#740 — exit status follows process.exitCode", () => {
  test("`tps service remove` with no name exits 1 and prints the usage line", async () => {
    const result = await runTps(["service", "remove"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: tps service remove <name>");
  });

  test("`tps service register` with no url exits 1", async () => {
    const result = await runTps(["service", "register", "svc-a"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: tps service register <name> <url>");
  });

  test("a successful command exits 0", async () => {
    const version = await runTps(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).not.toBe("");

    const list = await runTps(["service", "list"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("No services registered");
  });
});
