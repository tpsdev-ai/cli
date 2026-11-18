import { describe, test, expect, afterEach, spyOn, mock } from "bun:test";
import * as fs from "node:fs";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, lutimesSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeHostState,
  clearHostState,
  clearHostStateAt,
  claimHostStateAt,
  refreshOwnedHostStateAt,
  hostStatePath,
  hostStateLockRoot,
  writeBranchState,
  branchStatePath,
  sweepStaleConnectionTemps,
  type BranchConnectionState,
  type HostConnectionState,
} from "../src/utils/connection-state.js";
import { mailLockPath } from "../src/utils/mail-lock.js";
import { processStartToken } from "@tpsdev-ai/agent";

/** Read a connection record the way an operator would, so the assertions below
 *  pin the writer's output rather than a reader in the module under test. */
function readRecord<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return null; }
}

afterEach(() => { mock.restore(); });

describe("connection-state", () => {
  let home = "";
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  test("write + read round-trips", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-"));
    process.env.HOME = home;
    writeHostState({
      branch: "austin",
      connectedAt: new Date().toISOString(),
      lastHeartbeatSent: new Date().toISOString(),
      lastHeartbeatAck: null,
      reconnectCount: 0,
      bytesSent: 0,
      bytesReceived: 0,
      messagesSent: 0,
      messagesReceived: 0,
      pid: process.pid,
    });
    const row = readRecord<HostConnectionState>(hostStatePath("austin"));
    expect(row?.branch).toBe("austin");
  });

  test("clear removes state", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-"));
    process.env.HOME = home;
    writeHostState({
      branch: "x",
      connectedAt: "",
      lastHeartbeatSent: "",
      lastHeartbeatAck: null,
      reconnectCount: 0,
      bytesSent: 0,
      bytesReceived: 0,
      messagesSent: 0,
      messagesReceived: 0,
      pid: process.pid,
    });
    clearHostState("x");
    expect(readRecord(hostStatePath("x"))).toBeNull();
  });

  const completeState = (): HostConnectionState => ({
    branch: "x",
    connectedAt: "",
    lastHeartbeatSent: "",
    lastHeartbeatAck: null,
    reconnectCount: 0,
    bytesSent: 0,
    bytesReceived: 0,
    messagesSent: 0,
    messagesReceived: 0,
    pid: process.pid,
  });

  test("zero-wait writes check the stop gate while holding the record lock", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-gate-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    let checked = false;
    writeHostState(completeState(), () => {
      checked = true;
      expect(existsSync(mailLockPath(hostStateLockRoot(path)))).toBe(true);
      return false;
    }, 0);
    expect(checked).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("refreshOwnedHostStateAt creates nothing when no record exists", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-owned-absent-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    refreshOwnedHostStateAt(path, completeState(), "conn-a");
    expect(existsSync(path)).toBe(false);
  });

  test("refreshOwnedHostStateAt leaves another connection's record untouched", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-owned-other-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-b" });
    const raw = readFileSync(path, "utf8");
    refreshOwnedHostStateAt(path, { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" }, "conn-a");
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  test("refreshOwnedHostStateAt leaves an invalid record untouched", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-owned-invalid-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    mkdirSync(join(home, ".tps", "connections"), { recursive: true });
    writeFileSync(path, "{ not json");
    refreshOwnedHostStateAt(path, completeState(), "conn-a");
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  test("refreshOwnedHostStateAt leaves an unreadable record untouched", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-owned-unreadable-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    mkdirSync(path, { recursive: true });
    refreshOwnedHostStateAt(path, completeState(), "conn-a");
    expect(statSync(path).isDirectory()).toBe(true);
  });

  test("claimHostStateAt writes an absent record", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-absent-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    const outcome = claimHostStateAt(path, { ...completeState(), connectionId: "conn-a" }, "conn-a");
    expect(outcome).toEqual({ kind: "written" });
    expect(readRecord<HostConnectionState>(path)?.connectionId).toBe("conn-a");
  });

  test("claimHostStateAt writes the record it owns", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-own-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-a" });
    const outcome = claimHostStateAt(path, { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "ack" }, "conn-a");
    expect(outcome).toEqual({ kind: "written" });
    expect(readRecord<HostConnectionState>(path)?.lastHeartbeatAck).toBe("ack");
  });

  test("claimHostStateAt holds the same real lock during record read, liveness probe and write", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-hold-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-b", startToken: "proc:stale" });
    const lockDir = mailLockPath(hostStateLockRoot(path));
    const read = fs.readFileSync;
    const rename = fs.renameSync;
    const stages: string[] = [];
    let nonce: string | undefined;
    const observeHold = (stage: string) => {
      const owner = JSON.parse(read(join(lockDir, "owner.json"), "utf8"));
      expect(owner.pid).toBe(process.pid);
      expect(owner.nonce).toEqual(expect.any(String));
      expect(owner.nonce.length).toBeGreaterThan(0);
      if (nonce === undefined) nonce = owner.nonce;
      expect(owner.nonce).toBe(nonce);
      stages.push(stage);
    };
    const readSpy = spyOn(fs, "readFileSync").mockImplementation((file, ...args) => {
      if (file === path) observeHold("read");
      return read(file, ...args);
    });
    const renameSpy = spyOn(fs, "renameSync").mockImplementation((...args: Parameters<typeof rename>) => {
      if (args[1] === path) observeHold("write");
      return rename(...args);
    });
    try {
      const outcome = claimHostStateAt(path, { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "ack" }, "conn-a", undefined, 0, {
        startToken: (pid) => {
          expect(pid).toBe(process.pid);
          observeHold("liveness");
          return "proc:live";
        },
      });
      expect(outcome).toEqual({ kind: "written" });
      expect(stages).toEqual(["read", "liveness", "write"]);
      expect(existsSync(lockDir)).toBe(false);
      expect(JSON.parse(read(path, "utf8"))).toMatchObject({ connectionId: "conn-a", lastHeartbeatAck: "ack" });
    } finally {
      readSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  test("claimHostStateAt leaves another connection's record untouched", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-other-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-b", startToken: "proc:b" });
    const raw = readFileSync(path);
    const outcome = claimHostStateAt(path, { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" }, "conn-a", undefined, 0, { startToken: () => "proc:b" });
    expect(outcome).toEqual({ kind: "other" });
    expect(readFileSync(path)).toEqual(raw);
  });

  test("claimHostStateAt returns stopped and leaves the record as it is when the stop gate is closed", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-stopped-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    // A simulated proc: mismatch makes the record reclaimable without the gate.
    writeHostState({ ...completeState(), connectionId: "conn-b", startToken: "proc:stale" });
    const raw = readFileSync(path);
    const absentPath = hostStatePath("absent");
    let checked = 0;
    const gate = (recordPath: string) => (): boolean => {
      checked++;
      expect(existsSync(mailLockPath(hostStateLockRoot(recordPath)))).toBe(true);
      return false;
    };
    const other = claimHostStateAt(path, { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" }, "conn-a", gate(path), 0, { startToken: () => "proc:live" });
    const absent = claimHostStateAt(absentPath, { ...completeState(), connectionId: "conn-a" }, "conn-a", gate(absentPath));
    expect(other).toEqual({ kind: "stopped" });
    expect(absent).toEqual({ kind: "stopped" });
    expect(checked).toBe(2);
    expect(readFileSync(path)).toEqual(raw);
    expect(existsSync(absentPath)).toBe(false);
  });

  test("claimHostStateAt reports unverifiable and leaves the record when this process's token cannot be read", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-unverifiable-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-a", startToken: "proc:other" });
    const raw = readFileSync(path);
    const outcome = claimHostStateAt(
      path,
      { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" },
      "conn-a",
      undefined,
      0,
      { startToken: () => null },
    );
    expect(outcome).toEqual({ kind: "unverifiable" });
    expect(readFileSync(path)).toEqual(raw);
  });

  /** A pid this test spawned and awaited to exit before it is used. With
   *  captureToken, the token is read from the live child; otherwise it is a
   *  fixed ps: token. */
  async function exitedChildPid(captureToken = true): Promise<{ pid: number; token: string }> {
    const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const token = captureToken ? processStartToken(child.pid) : "ps:Tue Nov 17 02:39:30 2026";
      expect(token).not.toBeNull();
      return { pid: child.pid, token: String(token) };
    } finally {
      child.stdin.end();
      await child.exited;
    }
  }

  test.each(["null", "captured", "ps"])("claimHostStateAt reclaims a gone owner's record whose startToken is %s (real pid probe)", async (recordedToken) => {
    const child = await exitedChildPid(recordedToken !== "ps");
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-gone-pid-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-b", pid: child.pid, startToken: recordedToken === "null" ? null : recordedToken === "ps" ? "ps:Tue Nov 17 02:39:30 2026" : child.token });
    const live = recordedToken === "ps" ? null : processStartToken(process.pid);
    if (recordedToken !== "ps") expect(live).not.toBeNull();
    const aState = { ...completeState(), connectionId: "conn-a", startToken: live, lastHeartbeatAck: "ack" };
    const outcome = claimHostStateAt(path, aState, "conn-a");
    expect(outcome).toEqual({ kind: "written" });
    expect(readRecord<HostConnectionState>(path)?.connectionId).toBe("conn-a");
    const refreshed = refreshOwnedHostStateAt(path, { ...aState, lastHeartbeatAck: "next" }, "conn-a");
    expect(refreshed).toEqual({ kind: "written" });
    expect(readRecord<HostConnectionState>(path)?.lastHeartbeatAck).toBe("next");
  });

  test("claimHostStateAt reclaims a live pid with a simulated proc: token mismatch (real pid probe)", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-reuse-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    const live = "proc:live";
    const hooks = { startToken: () => live };
    writeHostState({ ...completeState(), connectionId: "conn-b", pid: process.pid, startToken: "proc:stale" });
    const aState = { ...completeState(), connectionId: "conn-a", startToken: live, lastHeartbeatAck: "ack" };
    const outcome = claimHostStateAt(path, aState, "conn-a", undefined, 0, hooks);
    expect(outcome).toEqual({ kind: "written" });
    expect(readRecord<HostConnectionState>(path)?.connectionId).toBe("conn-a");
    const refreshed = refreshOwnedHostStateAt(path, { ...aState, lastHeartbeatAck: "next" }, "conn-a", undefined, 0, hooks);
    expect(refreshed).toEqual({ kind: "written" });
    expect(readRecord<HostConnectionState>(path)?.lastHeartbeatAck).toBe("next");
  });

  test("claimHostStateAt leaves a recorded bare proc label unverifiable instead of reclaiming it", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-bare-proc-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-b", pid: process.pid, startToken: "proc" });
    const raw = readFileSync(path);
    const outcome = claimHostStateAt(path, { ...completeState(), connectionId: "conn-a" }, "conn-a", undefined, 0, { startToken: () => "proc:4242" });
    expect(outcome).toEqual({ kind: "unverifiable" });
    expect(readFileSync(path)).toEqual(raw);
  });

  test.each([
    ["matching", "ps:Tue Nov 17 02:39:30 2026", "other"],
    ["different", "ps:Tue Nov 17 10:39:30 2026", "unverifiable"],
  ])("claimHostStateAt preserves a live owner's record with %s ps: tokens", (_label, live, kind) => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-ps-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-b", startToken: "ps:Tue Nov 17 02:39:30 2026" });
    const raw = readFileSync(path);
    const outcome = claimHostStateAt(path, { ...completeState(), connectionId: "conn-a" }, "conn-a", undefined, 0, { startToken: () => live });
    expect(outcome).toEqual({ kind });
    expect(readFileSync(path)).toEqual(raw);
  });

  test("claimHostStateAt preserves a live child's legacy ps: record when the current reader uses another TZ", async () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-ps-env-"));
    process.env.HOME = home;
    const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], {
      stdin: "pipe", stdout: "ignore", stderr: "ignore",
    });
    try {
      // Force the real reader's ps fallback on Linux too; ps itself is not mocked.
      // Raw ps output models a legacy record across the cli#1045 producer change.
      const script = `
        import * as fs from "node:fs";
        import { execFileSync } from "node:child_process";
        import { spyOn } from "bun:test";
        const read = fs.readFileSync;
        spyOn(fs, "readFileSync").mockImplementation((path, ...args) => {
          if (String(path) === "/proc/" + process.env.TPS_OWNER_PID + "/stat") throw new Error("proc unavailable");
          return read(path, ...args);
        });
        const { processStartToken } = await import(process.env.TPS_TOKEN_MODULE);
        const token = process.env.TPS_LEGACY_TOKEN === "1"
          ? "ps:" + execFileSync("ps", ["-o", "lstart=", "-p", process.env.TPS_OWNER_PID], { encoding: "utf8" }).trim()
          : processStartToken(Number(process.env.TPS_OWNER_PID));
        process.stdout.write(JSON.stringify(token));
      `;
      const readToken = async (TZ: string, legacy = false): Promise<string> => {
        const reader = Bun.spawn([process.execPath, "-e", script], {
          env: { ...process.env, TZ, LC_ALL: "C", TPS_LEGACY_TOKEN: legacy ? "1" : "0", TPS_OWNER_PID: String(child.pid), TPS_TOKEN_MODULE: new URL("../../agent/src/lib/mail-lock.ts", import.meta.url).href },
          stdout: "pipe", stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([new Response(reader.stdout).text(), new Response(reader.stderr).text(), reader.exited]);
        expect({ code, err }).toEqual({ code: 0, err: "" });
        const token = JSON.parse(out);
        expect(token).toEqual(expect.stringContaining("ps:"));
        return token;
      };
      const local = await readToken("Etc/GMT+8", true);
      const utc = await readToken("UTC");
      expect(local).not.toBe(utc);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
      const path = hostStatePath("x");
      writeHostState({ ...completeState(), connectionId: "conn-b", pid: child.pid, startToken: local });
      const raw = readFileSync(path);
      const outcome = claimHostStateAt(path, { ...completeState(), connectionId: "conn-a" }, "conn-a", undefined, 0, {
        startToken: (pid) => { expect(pid).toBe(child.pid); return utc; },
      });
      expect(outcome).toEqual({ kind: "unverifiable" });
      expect(readFileSync(path)).toEqual(raw);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
    } finally {
      child.stdin.end();
      await child.exited;
    }
  }, 20_000);

  test("claimHostStateAt skips another connection's record with no startToken while its pid is running", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-notoken-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-b" });
    const raw = readFileSync(path);
    const outcome = claimHostStateAt(
      path,
      { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" },
      "conn-a",
      undefined,
      0,
      { startToken: () => "proc:current-owner" },
    );
    expect(outcome).toEqual({ kind: "unverifiable" });
    expect(readFileSync(path)).toEqual(raw);
  });

  // processStartToken returns null when it cannot read a token; a throwing reader is the other failure shape.
  test.each([
    ["returns null", (): string | null => null],
    ["throws", (): string | null => { throw new Error("token read failed"); }],
  ])("claimHostStateAt skips another connection's record when the start token reader %s", (_label, startToken) => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-token-unreadable-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-b", startToken: "proc:other" });
    const raw = readFileSync(path);
    const outcome = claimHostStateAt(
      path,
      { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" },
      "conn-a",
      undefined,
      0,
      { startToken },
    );
    expect(outcome).toEqual({ kind: "unverifiable" });
    expect(readFileSync(path)).toEqual(raw);
  });

  test("claimHostStateAt skips another connection's record when the start tokens come from different sources", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-source-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-b", startToken: "ps:4242" });
    const raw = readFileSync(path);
    const outcome = claimHostStateAt(
      path,
      { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" },
      "conn-a",
      undefined,
      0,
      { startToken: () => "proc:4242" },
    );
    expect(outcome).toEqual({ kind: "unverifiable" });
    expect(readFileSync(path)).toEqual(raw);
  });

  test("claimHostStateAt reports an invalid record and leaves it as it is", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-invalid-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    mkdirSync(join(home, ".tps", "connections"), { recursive: true });
    writeFileSync(path, "{ not json");
    const outcome = claimHostStateAt(path, { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" }, "conn-a");
    expect(outcome).toEqual({ kind: "invalid" });
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  test("claimHostStateAt reports an unreadable record and leaves it as it is", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-unreadable-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    mkdirSync(path, { recursive: true });
    const outcome = claimHostStateAt(path, { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" }, "conn-a");
    expect(outcome).toEqual({ kind: "unreadable", reason: "is not a regular file" });
    expect(statSync(path).isDirectory()).toBe(true);
  });

  test("claimHostStateAt refuses while another process holds the record lock", async () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-claim-locked-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-b", startToken: "proc:b" });
    const raw = readFileSync(path);
    const lockRoot = hostStateLockRoot(path);
    // A separate process takes the real record lock and holds it; the claim is
    // then a genuine contender, not a nested acquisition in this process.
    const script = [
      `const { acquireMailLockSync } = await import(process.env.TPS_LOCK_MODULE);`,
      `const lock = acquireMailLockSync(process.env.TPS_LOCK_ROOT, { timeoutMs: 5000 });`,
      `if (!lock) process.exit(2);`,
      `process.stdout.write("locked\\n");`,
      `await new Promise((resolve) => { process.stdin.on("data", () => {}); process.stdin.on("end", resolve); process.stdin.resume(); });`,
      `lock.release();`,
    ].join("\n");
    const holder = Bun.spawn([process.execPath, "-e", script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TPS_LOCK_MODULE: new URL("../../agent/src/lib/mail-lock.ts", import.meta.url).href, TPS_LOCK_ROOT: lockRoot },
    });
    try {
      const decoder = new TextDecoder();
      let seen = "";
      let errText = "";
      void (async () => { for await (const chunk of holder.stdout) seen += decoder.decode(chunk); })();
      void (async () => { for await (const chunk of holder.stderr) errText += decoder.decode(chunk); })();
      const deadline = Date.now() + 15_000;
      while (!seen.includes("locked") && holder.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
      expect({ seen, errText, exitCode: holder.exitCode }).toMatchObject({ seen: expect.stringContaining("locked") });
      expect(() => claimHostStateAt(path, { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" }, "conn-a", undefined, 0, { startToken: () => "proc:b" })).toThrow(
        `Host state record lock ${mailLockPath(lockRoot)} could not be acquired within 0 ms; refusing to write the host state record. The lock or its reclamation claim is held, or its owner could not be verified. Retry after any running tps command finishes; if none is running, remove ${lockRoot} and retry.`,
      );
      expect(readFileSync(path)).toEqual(raw);
    } finally {
      holder.stdin.end();
      await holder.exited;
    }
  }, 20_000);

  test("refreshOwnedHostStateAt writes the record it owns", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-owned-write-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-a" });
    refreshOwnedHostStateAt(path, { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "ack" }, "conn-a");
    expect(readRecord<HostConnectionState>(path)?.lastHeartbeatAck).toBe("ack");
  });

  test.each(["conn-b", undefined])("refreshOwnedHostStateAt returns other for connectionId %j before reading this process's token", (connectionId) => {
    home = mkdtempSync(join(tmpdir(), "conn-state-owned-other-token-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId, startToken: "proc:other" });
    const raw = readFileSync(path);
    const startToken = mock(() => null);
    const outcome = refreshOwnedHostStateAt(
      path,
      { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" },
      "conn-a",
      undefined,
      0,
      { startToken },
    );
    expect(outcome).toEqual({ kind: "other" });
    expect(startToken).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(raw);
  });

  test.each(["conn-b", undefined])("clearHostStateAt keeps connectionId %j without reading this process's token", (connectionId) => {
    home = mkdtempSync(join(tmpdir(), "conn-state-clear-other-token-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId, startToken: "proc:other" });
    const raw = readFileSync(path);
    const startToken = mock(() => null);
    expect(() => clearHostStateAt(path, "x", "conn-a", { startToken })).not.toThrow();
    expect(startToken).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(raw);
  });

  test("refreshOwnedHostStateAt reports unverifiable and leaves the record when this process's token cannot be read", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-owned-unverifiable-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-a", startToken: "proc:other" });
    const raw = readFileSync(path, "utf8");
    const outcome = refreshOwnedHostStateAt(
      path,
      { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" },
      "conn-a",
      undefined,
      0,
      { startToken: () => null },
    );
    expect(outcome).toEqual({ kind: "unverifiable" });
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  test.each([
    ["tokens from different sources", "ps:Tue Nov 17 02:39:30 2026", "proc:4242"],
    ["two differing ps: tokens", "ps:Tue Nov 17 02:39:30 2026", "ps:Wed Nov 18 02:39:30 2026"],
  ])("refreshOwnedHostStateAt reports an owner whose %s cannot be compared and leaves the record byte-identical", (_label, recorded, live) => {
    home = mkdtempSync(join(tmpdir(), "conn-state-owned-incomparable-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-a", startToken: recorded });
    const raw = readFileSync(path);
    const outcome = refreshOwnedHostStateAt(
      path,
      { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" },
      "conn-a",
      undefined,
      0,
      { startToken: () => live },
    );
    expect(outcome).toEqual({ kind: "unverifiable" });
    expect(readFileSync(path)).toEqual(raw);
  });

  test("refresh, clear and claim treat a same-connection proc: mismatch as another owner", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-same-connection-mismatch-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-a", startToken: "proc:stale" });
    const raw = readFileSync(path, "utf8");
    const hooks = { startToken: () => "proc:live" };
    expect(refreshOwnedHostStateAt(
      path,
      { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "moved" },
      "conn-a",
      undefined,
      0,
      hooks,
    )).toEqual({ kind: "other" });
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(() => clearHostStateAt(path, "x", "conn-a", hooks)).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(claimHostStateAt(
      path,
      { ...completeState(), connectionId: "conn-a", lastHeartbeatAck: "claimed" },
      "conn-a",
      undefined,
      0,
      hooks,
    )).toEqual({ kind: "written" });
    expect(readRecord<HostConnectionState>(path)?.lastHeartbeatAck).toBe("claimed");
  });

  test("clearHostStateAt reports an owner whose tokens cannot be compared and keeps the record", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-clear-incomparable-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-a", startToken: "ps:Tue Nov 17 02:39:30 2026" });
    const raw = readFileSync(path, "utf8");
    expect(() => clearHostStateAt(path, "x", "conn-a", { startToken: () => "proc:4242" })).toThrow(
      `Host state record ${path} is present but this process's start token could not be read or compared, so its owner cannot be verified; the record was kept. Inspect it and remove it if no connector for that host is running.`,
    );
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  test.each([undefined, "conn-a"])("clearHostStateAt keeps and reports an unverifiable record with requested connectionId %j", (connectionId) => {
    home = mkdtempSync(join(tmpdir(), "conn-state-clear-unverifiable-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    writeHostState({ ...completeState(), connectionId: "conn-a", startToken: "proc:other" });
    const raw = readFileSync(path, "utf8");
    expect(() => clearHostStateAt(path, "x", connectionId, { startToken: () => null })).toThrow(
      `Host state record ${path} is present but this process's start token could not be read or compared, so its owner cannot be verified; the record was kept. Inspect it and remove it if no connector for that host is running.`,
    );
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  function expectInvalidKept(state: unknown): void {
    home = mkdtempSync(join(tmpdir(), "conn-state-invalid-"));
    process.env.HOME = home;
    const path = hostStatePath("x");
    mkdirSync(join(home, ".tps", "connections"), { recursive: true });
    const raw = JSON.stringify(state);
    writeFileSync(path, raw);
    expect(() => clearHostState("x")).toThrow(
      `Host state record ${path} is present but is not a valid host state record, so its owner cannot be verified; the record was kept. Inspect it and remove it if no connector for that host is running.`,
    );
    expect(readFileSync(path, "utf8")).toBe(raw);
  }

  test("clearHostState reports and keeps a pid-only record", () => {
    expectInvalidKept({ pid: process.pid });
  });

  test.each([0, -1, 1.5, 2147483648])("clearHostState reports and keeps a record with pid %j", (pid) => {
    expectInvalidKept({ ...completeState(), pid });
  });

  test("clearHostState reports and keeps a record with an empty startToken", () => {
    expectInvalidKept({ ...completeState(), startToken: "" });
  });

  for (const field of Object.keys(completeState())) {
    test(`clearHostState reports and keeps a record missing ${field}`, () => {
      const state: Record<string, unknown> = { ...completeState() };
      delete state[field];
      expectInvalidKept(state);
    });
    test(`clearHostState reports and keeps a record with a nested ${field}`, () => {
      expectInvalidKept({ ...completeState(), [field]: { value: completeState()[field as keyof HostConnectionState] } });
    });
    test(`clearHostState reports and keeps a record with the wrong primitive type for ${field}`, () => {
      const value = completeState()[field as keyof HostConnectionState];
      expectInvalidKept({ ...completeState(), [field]: typeof value === "number" ? "0" : 0 });
    });
  }

  test.each([null, [], "record", 1, true, { state: completeState() }].map((state) => [state]))(
    "clearHostState reports and keeps a non-record value %j",
    (state) => { expectInvalidKept(state); },
  );

  test("clearHostState reports and keeps a record naming another branch", () => {
    expectInvalidKept({ ...completeState(), branch: "other" });
  });

  test.each([
    { startToken: 1 },
    { services: null },
    { services: {} },
    { services: [null] },
    { services: [{ name: "service", status: "healthy", lastCheck: null }] },
    { services: [{ name: "service", status: "invalid", lastCheck: null, lastHealthy: null }] },
    { services: [{ name: "service", status: "healthy", lastCheck: 1, lastHealthy: null }] },
    { services: [{ name: "service", status: "healthy", lastCheck: null, lastHealthy: null, error: 1 }] },
  ])("clearHostState reports and keeps invalid optional fields %j", (fields) => {
    expectInvalidKept({ ...completeState(), ...fields });
  });

  test("clearHostState removes our complete record with optional fields", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-complete-"));
    process.env.HOME = home;
    writeHostState({ ...completeState(), lastHeartbeatAck: "ack", startToken: null,
      services: [{ name: "service", status: "healthy", lastCheck: "now", lastHealthy: null, error: "" }] });
    clearHostState("x");
    expect(existsSync(hostStatePath("x"))).toBe(false);
  });

  const writeState = (branch: string, messagesReceived: number): HostConnectionState => ({
    branch,
    connectedAt: "",
    lastHeartbeatSent: "",
    lastHeartbeatAck: null,
    reconnectCount: 0,
    bytesSent: 0,
    bytesReceived: 0,
    messagesSent: 0,
    messagesReceived,
    pid: process.pid,
  });

  test("a failed rename keeps the previous record and leaves no temp file", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-rename-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    const record = hostStatePath("branch-a");
    writeHostState(writeState("branch-a", 1));
    const before = readFileSync(record);

    const rename = fs.renameSync;
    const injected = spyOn(fs, "renameSync").mockImplementation((...args: Parameters<typeof rename>) => {
      if (String(args[1]) === record) throw new Error("injected rename failure");
      return rename(...args);
    });
    try {
      expect(() => writeHostState(writeState("branch-a", 2))).toThrow("injected rename failure");
    } finally {
      injected.mockRestore();
    }

    expect(readFileSync(record).equals(before)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("a failed write keeps the previous record and removes the temp file", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-write-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    const record = hostStatePath("branch-a");
    writeHostState(writeState("branch-a", 1));
    const before = readFileSync(record);

    const write = fs.writeFileSync;
    const injected = spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof write>) => {
      if (!String(args[0]).includes(".mail-lock")) {
        write(...args);
        throw new Error("injected write failure");
      }
      return write(...args);
    });
    try {
      expect(() => writeHostState(writeState("branch-a", 2))).toThrow("injected write failure");
    } finally {
      injected.mockRestore();
    }

    expect(readFileSync(record).equals(before)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("a successful write stores mode 0600 and leaves no temp file", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-mode-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    const record = hostStatePath("branch-a");
    writeHostState(writeState("branch-a", 1));
    expect(readRecord<HostConnectionState>(hostStatePath("branch-a"))?.messagesReceived).toBe(1);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
    expect(statSync(record).mode & 0o777).toBe(0o600);
  });

  const tempName = (record: string): string => `.${record}.11111111-1111-4111-8111-111111111111.tmp`;

  test("a stale temp file of the writer's shape is removed on the next write", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-stale-temp-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, tempName("branch-a.json"));
    writeFileSync(stale, "partial");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    writeHostState(writeState("branch-a", 1));

    expect(existsSync(stale)).toBe(false);
    expect(readRecord<HostConnectionState>(hostStatePath("branch-a"))?.messagesReceived).toBe(1);
  });

  test("a fresh temp file of the writer's shape is kept", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-fresh-temp-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    mkdirSync(dir, { recursive: true });
    const fresh = join(dir, tempName("branch-a.json"));
    writeFileSync(fresh, "in progress");

    writeHostState(writeState("branch-a", 1));

    expect(readFileSync(fresh, "utf-8")).toBe("in progress");
    expect(existsSync(fresh)).toBe(true);
  });

  test("a near-miss temp name is kept", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-near-miss-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    mkdirSync(dir, { recursive: true });
    const nearMisses = [
      join(dir, ".branch-a.json.11111111-1111-4111-8111-111111111111.tmp.bak"),
      join(dir, ".branch-a.json.not-a-uuid.tmp"),
      join(dir, ".other.txt.11111111-1111-4111-8111-111111111111.tmp"),
    ];
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const path of nearMisses) {
      writeFileSync(path, "keep");
      utimesSync(path, old, old);
    }

    writeHostState(writeState("branch-a", 1));

    for (const path of nearMisses) {
      expect(readFileSync(path, "utf-8")).toBe("keep");
      expect(existsSync(path)).toBe(true);
    }
  });

  test("a stale temp symlink is not followed or removed", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-temp-link-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    mkdirSync(dir, { recursive: true });
    const target = join(home, "target.txt");
    writeFileSync(target, "target");
    const link = join(dir, tempName("branch-a.json"));
    symlinkSync(target, link);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    lutimesSync(link, old, old);

    writeHostState(writeState("branch-a", 1));

    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(target, "utf-8")).toBe("target");
  });

  test("a temp that vanishes between listing and removal is in neither list", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-vanish-temp-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, tempName("branch-a.json"));
    writeFileSync(stale, "partial");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    const lstat = fs.lstatSync;
    const injected = spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof lstat>) => {
      const stats = lstat(...args);
      // Removed by another process after the listing and inspection, before ours.
      if (String(args[0]) === stale) rmSync(stale);
      return stats;
    });
    let sweep: ReturnType<typeof sweepStaleConnectionTemps>;
    let inspections = 0;
    try {
      sweep = sweepStaleConnectionTemps();
      inspections = injected.mock.calls.length;
    } finally {
      injected.mockRestore();
    }

    expect(inspections).toBeGreaterThan(0);
    expect(sweep.removed).toEqual([]);
    expect(sweep.left).toEqual([]);
  });

  test("a record tightened to 0600 keeps 0600 after a rewrite", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-keep-mode-"));
    process.env.HOME = home;
    const record = join(home, ".tps", "connections", "host.json");
    writeBranchState({ connectedAt: "a", lastSeen: "b", messagesReceived: 1, messagesPushed: 1 });
    chmodSync(record, 0o600);

    writeBranchState({ connectedAt: "c", lastSeen: "d", messagesReceived: 2, messagesPushed: 2 });

    expect(readRecord<BranchConnectionState>(branchStatePath())?.messagesReceived).toBe(2);
    expect(statSync(record).mode & 0o777).toBe(0o600);
  });

  test("a new record gets the default mode", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-default-mode-"));
    process.env.HOME = home;
    const record = join(home, ".tps", "connections", "host.json");

    writeBranchState({ connectedAt: "a", lastSeen: "b", messagesReceived: 1, messagesPushed: 1 });

    expect(statSync(record).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  test("branch state writes atomically and round-trips", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-branch-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    writeBranchState({ connectedAt: "a", lastSeen: "b", messagesReceived: 2, messagesPushed: 3 });
    expect(readRecord<BranchConnectionState>(branchStatePath())).toEqual({ connectedAt: "a", lastSeen: "b", messagesReceived: 2, messagesPushed: 3 });
    expect(readFileSync(join(dir, "host.json"), "utf-8"))
      .toBe(JSON.stringify({ connectedAt: "a", lastSeen: "b", messagesReceived: 2, messagesPushed: 3 }, null, 2));
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("a failed branch state sync keeps the previous record and removes the temp file", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-branch-sync-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    const record = join(dir, "host.json");
    writeBranchState({ connectedAt: "a", lastSeen: "b", messagesReceived: 2, messagesPushed: 3 });
    const before = readFileSync(record);

    const injected = spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("injected sync failure");
    });
    try {
      expect(() => writeBranchState({ connectedAt: "c", lastSeen: "d", messagesReceived: 4, messagesPushed: 5 }))
        .toThrow("injected sync failure");
    } finally {
      injected.mockRestore();
    }

    expect(readFileSync(record).equals(before)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("a failed branch state close preserves the original error and record and removes the temp file", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-branch-close-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    const record = join(dir, "host.json");
    writeBranchState({ connectedAt: "a", lastSeen: "b", messagesReceived: 2, messagesPushed: 3 });
    const before = readFileSync(record);

    const close = fs.closeSync;
    const closeError = new Error("injected close failure");
    const cleanupError = new Error("injected cleanup close failure");
    const injected = spyOn(fs, "closeSync").mockImplementation((...args: Parameters<typeof close>) => {
      if (injected.mock.calls.length === 1) throw closeError;
      close(...args);
      throw cleanupError;
    });
    try {
      let caught: unknown;
      try {
        writeBranchState({ connectedAt: "c", lastSeen: "d", messagesReceived: 4, messagesPushed: 5 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(closeError);
      expect(injected.mock.calls).toHaveLength(2);
      expect(injected.mock.calls[1]).toEqual(injected.mock.calls[0]);
    } finally {
      injected.mockRestore();
    }

    expect(readFileSync(record).equals(before)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("a failed branch state write keeps the previous record and removes the temp file", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-branch-write-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    const record = join(dir, "host.json");
    writeBranchState({ connectedAt: "a", lastSeen: "b", messagesReceived: 2, messagesPushed: 3 });
    const before = readFileSync(record);

    const write = fs.writeFileSync;
    const injected = spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof write>) => {
      write(...args);
      throw new Error("injected write failure");
    });
    try {
      expect(() => writeBranchState({ connectedAt: "c", lastSeen: "d", messagesReceived: 4, messagesPushed: 5 }))
        .toThrow("injected write failure");
    } finally {
      injected.mockRestore();
    }

    expect(readFileSync(record).equals(before)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("a failed branch state rename keeps the previous record and removes the temp file", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-branch-rename-"));
    process.env.HOME = home;
    const dir = join(home, ".tps", "connections");
    const record = join(dir, "host.json");
    writeBranchState({ connectedAt: "a", lastSeen: "b", messagesReceived: 2, messagesPushed: 3 });
    const before = readFileSync(record);

    const rename = fs.renameSync;
    const injected = spyOn(fs, "renameSync").mockImplementation((...args: Parameters<typeof rename>) => {
      if (String(args[1]) === record) throw new Error("injected rename failure");
      return rename(...args);
    });
    try {
      expect(() => writeBranchState({ connectedAt: "c", lastSeen: "d", messagesReceived: 4, messagesPushed: 5 }))
        .toThrow("injected rename failure");
    } finally {
      injected.mockRestore();
    }

    expect(readFileSync(record).equals(before)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
