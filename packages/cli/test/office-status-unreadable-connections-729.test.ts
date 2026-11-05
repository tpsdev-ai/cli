/**
 * cli#729 — the office status connection listing distinguishes an absent
 * connections directory from one it cannot read, and reports a host state
 * record it cannot read or parse instead of dropping it.
 *
 * Every case uses real files and a spawned process: a non-directory at the
 * connections path, a symlink loop, an unparseable record and an absent
 * directory. The status handler runs in a spawned child rather than through
 * spawnSync (cli#736).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TIMEOUT = 30_000;
const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const OFFICE_MODULE = resolve(import.meta.dir, "../src/commands/office.ts");
const DRIVER = `
  import { runOffice } from ${JSON.stringify(OFFICE_MODULE)};
  await runOffice({ action: "status", json: process.env.TPS_TEST_STATUS_JSON === "1" });
`;

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runChild(argv: string[], env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => rejectResult(new Error(`child ${argv.join(" ")} did not exit within 20s`)));
    }, 20_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish(() => rejectResult(error)));
    child.on("close", (status) => finish(() => resolveResult({ status, stdout, stderr })));
  });
}

let home = "";
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "tps-office-status-729-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".tps"), { recursive: true });
  writeFileSync(join(home, "status-driver.ts"), DRIVER);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function runStatus(json = false): Promise<ChildResult> {
  return runChild([process.execPath, join(home, "status-driver.ts")], {
    ...process.env,
    HOME: home,
    TPS_ROOT: join(home, "tps-root"),
    TPS_OFFICE_SKIP_VM: "1",
    TPS_TEST_STATUS_JSON: json ? "1" : "0",
  });
}

function connectionsPath(): string {
  return join(home, ".tps", "connections");
}

function output(result: ChildResult): string {
  return `${result.stdout}${result.stderr}`;
}

describe("office status connection listing", () => {
  test(
    "an absent connections directory reports no connections",
    async () => {
      const result = await runStatus();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("No active branch connections.");
    },
    TIMEOUT,
  );

  test(
    "a non-directory at the connections path is named with its error code and remedy",
    async () => {
      writeFileSync(connectionsPath(), "not a directory");

      const result = await runStatus();

      expect(result.status).toBe(1);
      expect(output(result)).toContain(connectionsPath());
      expect(output(result)).toContain("ENOTDIR");
      expect(output(result)).toContain("repair or remove it");
      expect(result.stdout).not.toContain("No active branch connections.");
    },
    TIMEOUT,
  );

  test(
    "a symlink loop at the connections path is named with its error code and remedy",
    async () => {
      symlinkSync(connectionsPath(), connectionsPath());

      const result = await runStatus();

      expect(result.status).toBe(1);
      expect(output(result)).toContain(connectionsPath());
      expect(output(result)).toContain("ELOOP");
      expect(output(result)).toContain("repair or remove it");
      expect(result.stdout).not.toContain("No active branch connections.");
    },
    TIMEOUT,
  );

  test(
    "an unparseable record is reported and the readable record is still listed",
    async () => {
      mkdirSync(connectionsPath());
      const badPath = join(connectionsPath(), "bad.json");
      writeFileSync(badPath, "{ this is not json");
      writeFileSync(join(connectionsPath(), "host-a.json"), JSON.stringify({
        branch: "host-a",
        connectedAt: new Date().toISOString(),
        lastHeartbeatSent: new Date().toISOString(),
        lastHeartbeatAck: null,
        reconnectCount: 0,
        bytesSent: 0,
        bytesReceived: 0,
        messagesSent: 0,
        messagesReceived: 0,
        pid: process.pid,
      }));

      const result = await runStatus();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("host-a:");
      const text = output(result);
      expect(text).toContain(badPath);
      expect(text).toContain("could not be parsed");
      expect(text).not.toContain("No active branch connections.");
    },
    TIMEOUT,
  );

  test(
    "a directory failure under --json carries the path and code and exits non-zero",
    async () => {
      writeFileSync(connectionsPath(), "not a directory");

      const result = await runStatus(true);

      expect(result.status).toBe(1);
      const body = JSON.parse(result.stdout);
      expect(body.agents).toEqual([]);
      expect(body.error.path).toBe(connectionsPath());
      expect(body.error.code).toBe("ENOTDIR");
    },
    TIMEOUT,
  );

  test(
    "an unparseable record under --json is carried in the result and exits non-zero",
    async () => {
      mkdirSync(connectionsPath());
      const badPath = join(connectionsPath(), "bad.json");
      writeFileSync(badPath, "{ this is not json");

      const result = await runStatus(true);

      expect(result.status).toBe(1);
      const body = JSON.parse(result.stdout);
      expect(body.agents).toEqual([]);
      expect(body.problems).toEqual([{ path: badPath, reason: "unparseable" }]);
    },
    TIMEOUT,
  );
});

describe("office kill with an unreadable connections directory", () => {
  test(
    "a non-directory at the connections path keeps the kill switch from engaging",
    async () => {
      writeFileSync(connectionsPath(), "not a directory");

      const result = await runChild([process.execPath, TPS_BIN, "office", "kill", "--quiet-nono-check"], {
        ...process.env,
        HOME: home,
        TPS_ROOT: join(home, "tps-root"),
        TPS_OFFICE_SKIP_VM: "1",
      });

      expect(result.status).toBe(1);
      expect(output(result)).toContain(connectionsPath());
      expect(output(result)).toContain("ENOTDIR");
      expect(output(result)).not.toContain("Kill switch engaged");
    },
    TIMEOUT,
  );

  test(
    "an unparseable record keeps the kill switch from engaging",
    async () => {
      mkdirSync(connectionsPath());
      const badPath = join(connectionsPath(), "bad.json");
      writeFileSync(badPath, "{ this is not json");

      const result = await runChild([process.execPath, TPS_BIN, "office", "kill", "--quiet-nono-check"], {
        ...process.env,
        HOME: home,
        TPS_ROOT: join(home, "tps-root"),
        TPS_OFFICE_SKIP_VM: "1",
      });

      expect(result.status).toBe(1);
      expect(output(result)).toContain(badPath);
      expect(output(result)).not.toContain("Kill switch engaged");
    },
    TIMEOUT,
  );
});
