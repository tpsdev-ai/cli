import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeHostState,
  readHostState,
  clearHostState,
  connectionAlive,
  hostStatePath,
  type HostConnectionState,
} from "../src/utils/connection-state.js";

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
});
