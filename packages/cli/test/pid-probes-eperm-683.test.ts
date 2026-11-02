/**
 * cli#683 — every pid probe in the cli goes through the shared pidState, so a
 * process this user may not signal (EPERM) is running and its pid file is kept.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processAlive } from "../src/commands/branch.js";
import { connectionAlive, writeHostState } from "../src/utils/connection-state.js";
import { pidAlive } from "../src/utils/launch-attestation.js";
import { proxyStatus } from "../src/utils/llm-proxy.js";
import { bridgeStatus } from "../src/utils/mail-bridge.js";
import { getRelayPid } from "../src/utils/mail-relay.js";

let home: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tps-683-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("mail relay pid probe", () => {
  // pid 1 always exists; a non-root user's kill(1, 0) fails with EPERM. Root
  // can signal it, so the case is still true there but does not exercise EPERM
  // (cli#692 tracks forcing EPERM when the suite runs as root).
  test("keeps a pid file naming pid 1 and reports the relay running", () => {
    const runDir = join(home, ".tps");
    mkdirSync(runDir, { recursive: true });
    const pidPath = join(runDir, "relay.pid");
    writeFileSync(pidPath, "1\n");

    expect(getRelayPid()).toBe(1);
    expect(existsSync(pidPath)).toBe(true);
  });

  test("removes a pid file whose process is gone", () => {
    const runDir = join(home, ".tps");
    mkdirSync(runDir, { recursive: true });
    const pidPath = join(runDir, "relay.pid");
    writeFileSync(pidPath, "2147483648\n");

    expect(getRelayPid()).toBeNull();
    expect(existsSync(pidPath)).toBe(false);
  });
});

describe("other pid probes take pidState's answer", () => {
  const alive = () => "alive" as const;

  test("mail bridge status reports a process pidState calls alive", () => {
    const runDir = join(home, ".tps", "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "mail-bridge.pid"), JSON.stringify({ pid: 1, port: 7000 }));

    expect(bridgeStatus(alive)).toEqual({ running: true, pid: 1, port: 7000 });
  });

  test("llm proxy status reports a process pidState calls alive", () => {
    const runDir = join(home, ".tps", "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "llm-proxy.pid"), "1\n");

    expect(proxyStatus(alive)).toEqual({ running: true, pid: 1, port: 6459 });
  });

  test("connection state reports a process pidState calls alive", () => {
    writeHostState({
      branch: "branch-a",
      connectedAt: "",
      lastHeartbeatSent: "",
      lastHeartbeatAck: null,
      reconnectCount: 0,
      bytesSent: 0,
      bytesReceived: 0,
      messagesSent: 0,
      messagesReceived: 0,
      pid: 1,
    });

    expect(connectionAlive("branch-a", alive)).toBe(true);
  });

  test("branch process check follows pidState", () => {
    expect(processAlive(1, alive)).toBe(true);
    expect(processAlive(1, () => "gone")).toBe(false);
    expect(processAlive(0)).toBe(false);
  });

  test("launcher pidAlive reports pid 1 as running", () => {
    expect(pidAlive(1)).toBe(true);
  });
});
