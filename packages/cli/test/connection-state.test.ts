import { describe, test, expect, afterEach, spyOn, mock } from "bun:test";
import * as fs from "node:fs";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, lutimesSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeHostState,
  readHostState,
  clearHostState,
  connectionAlive,
  hostStatePath,
  hostStateLockRoot,
  writeBranchState,
  readBranchState,
  type HostConnectionState,
} from "../src/utils/connection-state.js";
import { mailLockPath } from "../src/utils/mail-lock.js";

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
    expect(readHostState("branch-a")?.messagesReceived).toBe(1);
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
    expect(readHostState("branch-a")?.messagesReceived).toBe(1);
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

  test("a record tightened to 0600 keeps 0600 after a rewrite", () => {
    home = mkdtempSync(join(tmpdir(), "conn-state-keep-mode-"));
    process.env.HOME = home;
    const record = join(home, ".tps", "connections", "host.json");
    writeBranchState({ connectedAt: "a", lastSeen: "b", messagesReceived: 1, messagesPushed: 1 });
    chmodSync(record, 0o600);

    writeBranchState({ connectedAt: "c", lastSeen: "d", messagesReceived: 2, messagesPushed: 2 });

    expect(readBranchState()?.messagesReceived).toBe(2);
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
    expect(readBranchState()).toEqual({ connectedAt: "a", lastSeen: "b", messagesReceived: 2, messagesPushed: 3 });
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
