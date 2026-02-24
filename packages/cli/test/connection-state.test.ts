import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeHostState,
  readHostState,
  clearHostState,
  connectionAlive,
  listHostStates,
} from "../src/utils/connection-state.js";

describe("connection-state", () => {
  let home = "";

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    delete process.env.HOME;
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
    const row = readHostState("austin");
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
    expect(readHostState("x")).toBeNull();
  });

  test("alive checks pid", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-"));
    process.env.HOME = home;
    writeHostState({
      branch: "live",
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
    expect(connectionAlive("live")).toBe(true);
  });

  test("list returns branches", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-"));
    process.env.HOME = home;
    writeHostState({ branch: "a", connectedAt: "", lastHeartbeatSent: "", lastHeartbeatAck: null, reconnectCount: 0, bytesSent: 0, bytesReceived: 0, messagesSent: 0, messagesReceived: 0, pid: 1 });
    writeHostState({ branch: "b", connectedAt: "", lastHeartbeatSent: "", lastHeartbeatAck: null, reconnectCount: 0, bytesSent: 0, bytesReceived: 0, messagesSent: 0, messagesReceived: 0, pid: 2 });
    expect(listHostStates().map((s) => s.branch).sort()).toEqual(["a", "b"]);
  });
});
