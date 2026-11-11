/**
 * cli#901: `tps mail ack` takes the agent from `--agent <id>` only. Every usage text that names the
 * command must say so; a positional `[agent]` there documents a form the parser ignores.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const ACK_USAGE = "tps mail ack <id> [--agent <id>]";

function run(args: string[]): { status: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), "tps-ack-usage-"));
  const home = join(root, "home");
  mkdirSync(home);
  try {
    const r = spawnSync(process.execPath, [TPS_BIN, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, TPS_MAIL_DIR: join(home, "mail"), TPS_AGENT_ID: "agent-a" },
      encoding: "utf-8",
      timeout: 30_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function ackLines(out: string): string[] {
  return out.split("\n").filter((line) => line.includes("tps mail ack"));
}

describe("tps mail ack usage names --agent (cli#901)", () => {
  test("ack with no message id prints the --agent usage and exits 1", () => {
    const r = run(["mail", "ack"]);
    expect(r.status).toBe(1);
    expect(ackLines(r.out)).toEqual([`Usage: ${ACK_USAGE}`]);
  });

  test("tps mail with no action lists ack with --agent", () => {
    const lines = ackLines(run(["mail"]).out);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(ACK_USAGE);
    expect(lines[0]).not.toContain("[agent]");
  });

  test("tps mail --help lists ack with --agent", () => {
    const lines = ackLines(run(["mail", "--help"]).out);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(ACK_USAGE);
    expect(lines[0]).not.toContain("[agent]");
  });
});
