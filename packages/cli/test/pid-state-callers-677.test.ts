/**
 * cli#677 — the cli's own mail lock and `tps status` use the shared pidState,
 * against real processes.
 */
import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MailLockOwnerError, processStartToken, tryAcquireMailLock } from "../src/utils/mail-lock.js";

const STATUS_MODULE = resolve(import.meta.dir, "../src/commands/status.ts");

/** A pid that has exited and been reaped by this process. */
function reapedPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 });
  expect(result.pid).toBeGreaterThan(0);
  return result.pid as number;
}

/** A running child process and its start token. */
async function liveProcess(): Promise<{ child: ChildProcess; pid: number; token: string }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid as number;
  expect(pid).toBeGreaterThan(0);
  let token: string | null = null;
  const deadline = Date.now() + 5_000;
  while (token === null && Date.now() < deadline) {
    token = processStartToken(pid);
    if (token === null) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  expect(token).not.toBeNull();
  return { child, pid, token: token as string };
}

describe("tryAcquireMailLock owner pid", () => {
  function plantLock(owner: Record<string, unknown>): { root: string; lockDir: string; ownerFile: string } {
    const root = mkdtempSync(join(tmpdir(), "tps-677-lock-"));
    const lockDir = join(root, ".mail-lock");
    const ownerFile = join(lockDir, "owner.json");
    mkdirSync(lockDir);
    writeFileSync(ownerFile, JSON.stringify(owner));
    return { root, lockDir, ownerFile };
  }

  test("refuses a lock whose owner pid is above 2147483647 and keeps it", () => {
    const owner = { pid: 2_147_483_648, startToken: processStartToken(process.pid) };
    const { root, lockDir, ownerFile } = plantLock(owner);
    try {
      expect(() => tryAcquireMailLock(lockDir)).toThrow(MailLockOwnerError);
      expect(JSON.parse(readFileSync(ownerFile, "utf-8"))).toEqual(owner);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reclaims a lock whose owner is gone", () => {
    const { root, lockDir, ownerFile } = plantLock({ pid: reapedPid(), startToken: processStartToken(process.pid) });
    try {
      const lock = tryAcquireMailLock(lockDir);
      expect(lock).not.toBeNull();
      expect(JSON.parse(readFileSync(ownerFile, "utf-8")).pid).toBe(process.pid);
      lock?.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null for a lock held by a running process and keeps it", async () => {
    const live = await liveProcess();
    const owner = { pid: live.pid, startToken: live.token };
    const { root, lockDir, ownerFile } = plantLock(owner);
    try {
      expect(tryAcquireMailLock(lockDir)).toBeNull();
      expect(JSON.parse(readFileSync(ownerFile, "utf-8"))).toEqual(owner);
    } finally {
      live.child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("tps status pid check", () => {
  test("reports pid 1 and a running process as online, and a gone, zero, negative, fractional or out-of-range pid as a zombie", async () => {
    const root = mkdtempSync(join(tmpdir(), "tps-677-status-"));
    const home = join(root, "home");
    const nodes = join(home, ".tps", "status", "nodes");
    mkdirSync(nodes, { recursive: true });
    const live = await liveProcess();
    try {
      const now = new Date().toISOString();
      // pid 1 always exists; when this process may not signal it, the probe fails with EPERM.
      const pids: Record<string, number> = {
        "agent-a": 1,
        "agent-b": live.pid,
        "agent-c": reapedPid(),
        "agent-d": 2_147_483_648,
        "agent-e": 0,
        "agent-f": -1,
        "agent-g": 1.5,
      };
      for (const [agentId, pid] of Object.entries(pids)) {
        writeFileSync(
          join(nodes, `${agentId}.json`),
          JSON.stringify({
            agentId,
            host: "host-a",
            model: "model-a",
            status: "online",
            lastHeartbeat: now,
            lastActivity: now,
            sessionCount: 0,
            errorCount: 0,
            uptime: 0,
            version: "0.0.0",
            pid,
          }),
        );
      }
      const scriptPath = join(root, "status.mjs");
      writeFileSync(
        scriptPath,
        `
import { runStatus } from ${JSON.stringify(STATUS_MODULE)};
const lines = [];
const log = console.log;
console.log = (...args) => lines.push(args.join(" "));
await runStatus({ json: true });
console.log = log;
process.stdout.write("RESULT " + JSON.stringify(JSON.parse(lines.join("\\n"))) + "\\n");
`,
      );

      const result = spawnSync("bun", [scriptPath], {
        cwd: root,
        encoding: "utf-8",
        timeout: 20_000,
        env: { ...process.env, HOME: home },
      });

      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
      expect(line, result.stdout).toBeDefined();
      const rows = JSON.parse((line as string).slice("RESULT ".length)) as Array<{ id: string; state: string }>;
      expect(Object.fromEntries(rows.map((row) => [row.id, row.state]))).toEqual({
        "agent-a": "online",
        "agent-b": "online",
        "agent-c": "zombie",
        "agent-d": "zombie",
        "agent-e": "zombie",
        "agent-f": "zombie",
        "agent-g": "zombie",
      });
    } finally {
      live.child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
