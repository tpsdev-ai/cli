/**
 * real-gateway.test.ts — cli#874 item 1: one signed mail through the REAL
 * pinned OpenClaw gateway, with a loopback model stub.
 *
 * The gateway half runs under node (the plugin loader needs node:sqlite) in
 * test/real-gateway-driver.mjs. The driver starts a loopback model stub whose
 * turn emits a progress text and a tool call, then the final text after the
 * tool result; the gateway is the real `openclaw gateway run` with an isolated
 * HOME/TMPDIR/state dir and the BUILT plugin.
 *
 * What this pins, end to end, under the channel config the plugin README
 * documents (no streaming):
 *   - exactly one dispatch for the mail;
 *   - the reply carries the turn's final text;
 *   - exactly one reply, counted after the ack and again after the gateway
 *     stops;
 *   - the triggering mail is in cur/ with a string ackedAt, the inbound new/
 *     is empty, and its obligation record is `acked`.
 *
 * Every wait in the driver has a named deadline. The test's network targets are
 * 127.0.0.1 stubs (the model and Flair); the gateway binds loopback. The model
 * stub answers the OpenAI Responses events the configured provider sends.
 */
import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMailboxMessageFile } from "@tpsdev-ai/agent";
import { decideSettledRead, finalizeGatewayRun, readSettledState } from "./real-gateway-driver.mjs";

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = join(PLUGIN_DIR, "test", "real-gateway-driver.mjs");

type Report = {
  status: string;
  error?: string;
  node: string;
  openclawVersion: string | null;
  modelCalls: number;
  modelTurnTexts: string[];
  unexpected: Array<{ method: string; url: string }>;
  dispatchStarts: number;
  replyCount: number;
  replyCountAfterAck: number;
  replyCountAfterStop: number;
  replyBody: string | null;
  replyFrom?: string;
  replyTo?: string;
  replyHeaders?: Record<string, string> | null;
  curFiles: string[];
  curEntries: CurEntry[];
  curEntriesSettled: CurEntry[];
  curRecord: { id?: string; ackedAt?: unknown } | null;
  obligationRecord: { state?: string } | null;
  inboundNewFiles: string[];
  readErrors: string[];
  inboundId: string | null;
  inboundName: string | null;
  settledRead: boolean;
  stopped: boolean;
  stoppedGracefully: boolean;
  stopSignal: string | null;
  ackLanded: boolean;
  ackTimedOut: boolean;
  ackLines: string[];
  logs: string[];
  logTail?: string[];
};

type CurEntry = { name: string; size: number };

/** Every cur/ entry the driver saw, with its size: names, never just a count. */
function describeCurEntries(entries: CurEntry[]): string {
  if (entries.length === 0) return "no entries";
  return entries.map((entry) => `${entry.name} (${entry.size} bytes)`).join(", ");
}

/**
 * The ack must have landed before any settled state is judged: a timed-out ack
 * never finished, so the driver leaves the settled listing and the cur record
 * unread, and this fails first, naming the ack.
 */
function expectAckLanded(report: Pick<Report, "ackTimedOut">): void {
  if (report.ackTimedOut) {
    throw new Error(
      "the ack never landed within its deadline: the settled cur/ state was not read, so its count is not judged",
    );
  }
}

/**
 * Exactly one INBOUND MESSAGE in the MID-ACK diagnostic listing, counted by the
 * mailbox's own name rule. That listing is taken while the ack's atomic record
 * replace may be in flight, so its transient `.ack-*.tmp` scratch is reported
 * but not counted. A second inbound message still fails.
 */
function expectOneInbound(entries: CurEntry[], inboundId: string): void {
  const messages = entries.filter((entry) => isMailboxMessageFile(entry.name));
  if (messages.length !== 1) {
    throw new Error(
      `expected 1 inbound message in cur/, found ${messages.length}; cur/ entries: ${describeCurEntries(entries)}`,
    );
  }
  expect(messages[0]?.name).toContain(inboundId);
}

/**
 * Exactly one entry in cur/, counted with NO name filter, after the gateway has
 * stopped. No writer is left, so an extra entry cannot be excused as transient:
 * a leaked `.ack-<uuid>.tmp` scratch fails like any other entry. On a count
 * mismatch the message names every entry with its size. The one entry must be
 * the injected record's EXACT filename, and the record it names must carry the
 * inbound id: a name that merely contains the id is not the record.
 */
function expectOneSettledCurEntry(
  entries: CurEntry[],
  expected: { inboundId: string; inboundName: string; curRecord: { id?: string } | null },
): void {
  if (entries.length !== 1) {
    throw new Error(
      `expected exactly 1 entry in settled cur/, found ${entries.length}; cur/ entries: ${describeCurEntries(entries)}`,
    );
  }
  expect(entries[0]?.name).toBe(expected.inboundName);
  expect(expected.curRecord?.id).toBe(expected.inboundId);
}

/**
 * The settled state must have been read before its count is judged: a gateway
 * that did not stop gracefully, or any run that skipped the read, leaves
 * `settledRead` false and names the reason in `readErrors`; a listing failure
 * leaves its error there with the read still done. Asserting that first keeps
 * the failure a named stop/read error, never a bare "found 0".
 */
function expectSettledStateRead(report: Pick<Report, "settledRead" | "readErrors">): void {
  if (!report.settledRead) {
    throw new Error(`the settled state was not read: ${report.readErrors.join("; ") || "no read error recorded"}`);
  }
  expect(report.readErrors).toEqual([]);
}

function expectGatewayReport(r: Report): void {
  expectAckLanded(r);
  expectSettledStateRead(r);
  expect(r.stopped).toBe(true);
  expect(r.stoppedGracefully).toBe(true);
  expect(r.stopSignal).toBeNull();
  expectOneSettledCurEntry(r.curEntriesSettled, {
    inboundId: r.inboundId!,
    inboundName: r.inboundName!,
    curRecord: r.curRecord,
  });
  expect(r.openclawVersion).toBe("2026.8.1");
  expect(r.dispatchStarts).toBe(1);
  expect(r.modelTurnTexts).toEqual(["PROGRESS: drafting the answer", "FINAL: the task is complete"]);
  expect(r.replyCount).toBe(1);
  expect(r.replyBody).toBe("FINAL: the task is complete");
  expect(r.replyFrom).toBe("agent-a");
  expect(r.replyTo).toBe("agent-b");
  expect(r.replyHeaders?.["X-TPS-InReplyTo"]).toBe(r.inboundId);
  expectOneInbound(r.curEntries, r.inboundId!);
  expect(r.replyCountAfterAck).toBe(1);
  expect(r.replyCountAfterStop).toBe(1);
  expect(r.inboundNewFiles).toEqual([]);
  expect(typeof r.curRecord?.ackedAt).toBe("string");
  expect(r.obligationRecord?.state).toBe("acked");
  expect(r.ackLines).toHaveLength(1);
  expect(r.ackLines[0]).toContain(r.inboundId!);
  expect(r.ackLines[0]).toContain("receipt found");
  expect(r.unexpected).toEqual([]);
}

function ackedReport(): Report {
  const entries = [{ name: "2026-01-01T00-00-00-000Z-msg-one.json", size: 10 }];
  return {
    status: "ok",
    node: process.version,
    openclawVersion: "2026.8.1",
    modelCalls: 2,
    modelTurnTexts: ["PROGRESS: drafting the answer", "FINAL: the task is complete"],
    unexpected: [],
    dispatchStarts: 1,
    replyCount: 1,
    replyCountAfterAck: 1,
    replyCountAfterStop: 1,
    replyBody: "FINAL: the task is complete",
    replyFrom: "agent-a",
    replyTo: "agent-b",
    replyHeaders: { "X-TPS-InReplyTo": "msg-one" },
    curFiles: entries.map((entry) => entry.name),
    curEntries: entries,
    curEntriesSettled: entries,
    curRecord: { id: "msg-one", ackedAt: "2026-01-01T00:00:00.000Z" },
    obligationRecord: { state: "acked" },
    inboundNewFiles: [],
    readErrors: [],
    inboundId: "msg-one",
    inboundName: "2026-01-01T00-00-00-000Z-msg-one.json",
    settledRead: true,
    stopped: true,
    stoppedGracefully: true,
    stopSignal: null,
    ackLanded: true,
    ackTimedOut: false,
    ackLines: ["acked msg-one: receipt found"],
    logs: [],
  };
}

/**
 * A settled-state fixture read through the driver's own `readSettledState`, so
 * the self-checks apply the shared assertion to the listing the real driver
 * produces, not to a listing the test builds itself.
 */
type SettledFixture = {
  root: string;
  report: {
    readErrors: string[];
    inboundId: string;
    curEntriesSettled: CurEntry[];
    curRecord: { id?: string } | null;
  };
};

function settledListing(files: Array<{ name: string; body: string }>): SettledFixture {
  const root = mkdtempSync(join(tmpdir(), "tps-settled-fixture-"));
  const curDir = join(root, "cur");
  const replyDir = join(root, "replies");
  const newDir = join(root, "new");
  const obligationsDir = join(root, "obligations");
  for (const dir of [curDir, replyDir, newDir, obligationsDir]) mkdirSync(dir);
  for (const file of files) writeFileSync(join(curDir, file.name), file.body);
  const report: SettledFixture["report"] = {
    readErrors: [],
    inboundId: "msg-one",
    curEntriesSettled: [],
    curRecord: null,
  };
  readSettledState(report, { replyDir, newDir, curDir, obligationsDir });
  return { root, report };
}

/**
 * The default child prints `ready` and exits 0 on SIGTERM: the graceful
 * counterpart of the killed-gateway stub below.
 */
async function startGracefulStub(
  node: string,
  script = 'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
  timeoutMs = 5_000,
  onSpawn?: (stub: ReturnType<typeof spawn>) => void,
): Promise<ReturnType<typeof spawn>> {
  const stub = spawn(node, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    onSpawn?.(stub);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stub gateway never booted")), timeoutMs);
      stub.stdout!.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      stub.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      stub.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("stub gateway exited before it booted"));
      });
    });
  } catch (err) {
    if (stub.pid !== undefined && stub.exitCode === null && stub.signalCode === null) {
      stub.kill("SIGKILL");
      await new Promise((resolve) => stub.once("exit", resolve));
    }
    throw err;
  }
  return stub;
}

it("stops a stub that times out before readiness", async () => {
  const node = process.env.TPS_LANE_NODE || "node";
  let stub: ReturnType<typeof spawn> | undefined;
  try {
    await expect(
      startGracefulStub(node, "setInterval(() => {}, 1000);", 500, (child) => {
        stub = child;
      }),
    ).rejects.toThrow("stub gateway never booted");
    expect(stub?.exitCode).toBeNull();
    expect(stub?.signalCode).toBe("SIGKILL");
  } finally {
    const child = stub;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
});

function runDriver(): { status: number | null; stdout: string; stderr: string; report: Report | null; root: string } {
  const root = mkdtempSync(join(tmpdir(), "tps-real-gateway-"));
  const specFile = join(root, "spec.json");
  writeFileSync(specFile, JSON.stringify({ root, pluginDir: PLUGIN_DIR }), { mode: 0o600 });
  const node = process.env.TPS_LANE_NODE || "node";
  const res = spawnSync(node, [DRIVER, specFile], {
    cwd: PLUGIN_DIR,
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
    env: {
      PATH: process.env.PATH ?? "",
      TPS_LANE_NODE: node,
    },
  });
  const reportFile = join(root, "report.json");
  const report = existsSync(reportFile) ? (JSON.parse(readFileSync(reportFile, "utf8")) as Report) : null;
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", report, root };
}

describe("cli#874 — real OpenClaw dispatch for openclaw-tps-mail", () => {
  it("one signed mail → one dispatch → the FINAL text is mailed and the inbound is acked", () => {
    const { status, stdout, stderr, report, root } = runDriver();
    try {
      if (status !== 0) {
        throw new Error(
          `real-gateway-driver exited ${status}: ${stderr || stdout}\n${report?.error ?? ""}\n${(report?.logs ?? []).join("\n")}`,
        );
      }
      expect(report).not.toBeNull();
      const r = report!;
      if (r.error) {
        throw new Error(`${r.error}\n${(r.logs ?? []).join("\n")}\n${(r.logTail ?? []).join("\n")}`);
      }
      expectGatewayReport(r);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 130_000);
});

describe("cli#1020 — the cur/ assertion reports what it found", () => {
  const recordName = "2026-01-01T00-00-00-000Z-msg-one.json";

  it("names every entry when the settled cur/ holds two inbound messages", () => {
    const { root, report } = settledListing([
      { name: recordName, body: '{"id":"msg-one"}' },
      { name: "2026-01-01T00-00-00-001Z-msg-two.json", body: '{"id":"msg-two"}' },
    ]);
    try {
      let message = "";
      try {
        expectOneSettledCurEntry(report.curEntriesSettled, {
          inboundId: "msg-one",
          inboundName: recordName,
          curRecord: report.curRecord,
        });
      } catch (err) {
        message = String((err as Error).message);
      }
      expect(message).toContain("found 2");
      expect(message).toContain("msg-one.json");
      expect(message).toContain("msg-two.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the settled assertion on a leaked ack scratch the driver lists", () => {
    const scratch = ".ack-7c1a9d2e-4b3f-4a51-9c8e-1f2d3e4a5b6c.tmp";
    const { root, report } = settledListing([
      { name: recordName, body: '{"id":"msg-one"}' },
      { name: scratch, body: "{}" },
    ]);
    try {
      // The fixture goes through the driver's own readSettledState listing: a
      // filter added there (for example one that drops dot-files) removes the
      // scratch and fails this assertion.
      expect(report.curEntriesSettled.map((entry) => entry.name).sort()).toEqual([recordName, scratch].sort());
      let message = "";
      try {
        expectOneSettledCurEntry(report.curEntriesSettled, {
          inboundId: "msg-one",
          inboundName: recordName,
          curRecord: report.curRecord,
        });
      } catch (err) {
        message = String((err as Error).message);
      }
      expect(message).toContain("found 2");
      expect(message).toContain(recordName);
      expect(message).toContain(scratch);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cli#1027 — the settled entry is the injected record, not a name containing its id", () => {
  const recordName = "2026-01-01T00-00-00-000Z-msg-one.json";

  function refusalMessage(files: Array<{ name: string; body: string }>): string {
    const { root, report } = settledListing(files);
    try {
      try {
        expectOneSettledCurEntry(report.curEntriesSettled, {
          inboundId: "msg-one",
          inboundName: recordName,
          curRecord: report.curRecord,
        });
      } catch (err) {
        return String((err as Error).message);
      }
      throw new Error("the settled assertion accepted the fixture");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("refuses a record renamed with a non-message suffix", () => {
    const message = refusalMessage([{ name: `${recordName}.bak`, body: '{"id":"msg-one"}' }]);
    expect(message).toContain(recordName);
  });

  it("refuses a dot scratch whose name contains the id", () => {
    const message = refusalMessage([{ name: ".ack-msg-one.tmp", body: '{"id":"msg-one"}' }]);
    expect(message).toContain(recordName);
  });

  it("refuses a record whose id is another message", () => {
    const message = refusalMessage([{ name: recordName, body: '{"id":"msg-other"}' }]);
    expect(message).toContain("msg-one");
  });
});

describe("cli#1020 — a timed-out ack is judged on its own assertion", () => {
  it("accepts an acked settled report", () => {
    expectGatewayReport(ackedReport());
  });

  it("fails on the ack timeout before judging the settled count", () => {
    const report = ackedReport();
    report.ackTimedOut = true;
    report.curEntriesSettled = [
      ...report.curEntriesSettled,
      { name: "2026-01-01T00-00-00-001Z-msg-two.json", size: 10 },
    ];
    let message = "";
    try {
      expectGatewayReport(report);
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain("ack never landed");
    expect(message).not.toContain("found 2");
  });
});

describe("cli#1020 — the driver's settled read decision", () => {
  it("reads after the gateway stops and the ack lands", () => {
    expect(decideSettledRead({ stopped: true, ackLanded: true, ackTimedOut: false })).toEqual({ read: true, readError: null });
  });

  it("skips the read and names the ack timeout", () => {
    expect(decideSettledRead({ stopped: true, ackLanded: false, ackTimedOut: true })).toEqual({
      read: false,
      readError: "ack wait timed out; settled state not read",
    });
  });

  it("skips the read and names an unstopped gateway", () => {
    for (const ackLanded of [false, true]) {
      expect(decideSettledRead({ stopped: false, ackLanded })).toEqual({
        read: false,
        readError: "gateway did not stop within the deadline; settled state not read",
      });
    }
  });

  it("skips the read and names a gateway killed after the stop deadline", () => {
    for (const ackLanded of [false, true]) {
      expect(decideSettledRead({ stopped: true, stoppedGracefully: false, ackLanded })).toEqual({
        read: false,
        readError: "gateway did not stop gracefully (it was killed after the stop deadline); settled state not read",
      });
    }
  });

  it("skips the read when stopped before the ack was awaited", () => {
    for (const error of [undefined, "gateway boot failed"]) {
      expect(decideSettledRead({ stopped: true, ackLanded: false, ackTimedOut: false, error })).toEqual({
        read: false,
        readError: error
          ? "ack never awaited (the run failed before it: gateway boot failed); settled state not read"
          : "ack never awaited (the run failed before it); settled state not read",
      });
    }
  });

  it("records settled listing failures and continues to the obligation read", () => {
    const root = mkdtempSync(join(tmpdir(), "tps-settled-read-"));
    try {
      writeFileSync(join(root, "msg-one.json"), JSON.stringify({ state: "acked" }));
      const report = { readErrors: [] as string[], inboundId: "msg-one", obligationRecord: null };
      expect(() => readSettledState(report, {
        replyDir: join(root, "missing-replies"),
        newDir: join(root, "missing-new"),
        curDir: join(root, "missing-cur"),
        obligationsDir: root,
      })).not.toThrow();
      expect(report.readErrors).toHaveLength(3);
      expect(report.readErrors[0]).toContain("reply listing");
      expect(report.readErrors[1]).toContain("new listing");
      expect(report.readErrors[2]).toContain("cur listing");
      expect(report.obligationRecord).toEqual({ state: "acked" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records malformed settled records", () => {
    const root = mkdtempSync(join(tmpdir(), "tps-settled-record-"));
    try {
      const curDir = join(root, "cur");
      mkdirSync(curDir);
      writeFileSync(join(curDir, "msg-one.json"), "{");
      writeFileSync(join(root, "msg-one.json"), "{");
      const report = { readErrors: [] as string[], inboundId: "msg-one", curRecord: null, obligationRecord: null };
      expect(() => readSettledState(report, { replyDir: root, newDir: root, curDir, obligationsDir: root })).not.toThrow();
      expect(report.readErrors).toHaveLength(2);
      expect(report.readErrors[0]).toContain("cur record");
      expect(report.readErrors[1]).toContain("obligation record");
      expect(report.curRecord).toBeNull();
      expect(report.obligationRecord).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports the driver under Bun and node without running it", () => {
    const root = mkdtempSync(join(tmpdir(), "tps-driver-import-"));
    try {
      const untouched = join(root, "untouched");
      const specFile = join(root, "spec.json");
      writeFileSync(specFile, JSON.stringify({ root: untouched, pluginDir: PLUGIN_DIR }));
      const probe = `process.argv[2] = ${JSON.stringify(specFile)};
        await import(${JSON.stringify(pathToFileURL(DRIVER).href)});
        process.stdout.write("imported");`;
      for (const runtime of [process.execPath, process.env.TPS_LANE_NODE || "node"]) {
        const importHome = mkdtempSync(join(tmpdir(), "tps-driver-import-home-"));
        try {
          const result = spawnSync(runtime, ["--input-type=module", "-e", probe], {
            encoding: "utf8",
            timeout: 5_000,
            env: { PATH: process.env.PATH ?? "", HOME: importHome, TMPDIR: importHome },
          });
          expect(result.error).toBeUndefined();
          expect(result.stderr).toBe("");
          expect(result.status).toBe(0);
          expect(result.stdout).toBe("imported");
          expect(existsSync(untouched)).toBe(false);
          expect(readdirSync(root)).toEqual(["spec.json"]);
        } finally {
          rmSync(importHome, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cli#1027 — a killed gateway is reported as not stopped gracefully", () => {
  it("reports the stub that ignores SIGTERM and ends on SIGKILL, not a count of 0", async () => {
    const node = process.env.TPS_LANE_NODE || "node";
    // The temp root exists before the stub does, so a throw while creating the
    // fixture cannot leave the stub (which ignores SIGTERM) running: the stub is
    // spawned inside the try, and the finally kills the child it started.
    const root = mkdtempSync(join(tmpdir(), "tps-killed-gateway-"));
    let stub: ReturnType<typeof spawn> | null = null;
    try {
      stub = spawn(
        node,
        [
          "--input-type=module",
          "-e",
          'process.on("SIGTERM", () => {}); process.stdout.write("watching 1 agent inbox\\n"); setInterval(() => {}, 1000);',
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("stub gateway never booted")), 5_000);
        stub!.stdout.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        stub!.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        stub!.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("stub gateway exited before it booted"));
        });
      });

      // The settled listing would succeed with a count of 0 here, so the report
      // can only carry it if the function reads a state it was told not to.
      const mailDir = join(root, "mail");
      for (const dir of [
        join(mailDir, "agent-a", "new"),
        join(mailDir, "agent-a", "cur"),
        join(mailDir, "agent-a", ".obligations"),
        join(mailDir, "agent-b", "new"),
      ]) {
        mkdirSync(dir, { recursive: true });
      }
      const report = {
        readErrors: [] as string[],
        inboundId: "msg-one",
        inboundName: "2026-01-01T00-00-00-000Z-msg-one.json",
        // Seeded as the graceful values: the false values asserted on the
        // written report can only come from finalizeGatewayRun overwriting
        // them with the killed child's stop result.
        settledRead: true,
        stopped: false,
        stoppedGracefully: true,
        stopSignal: null as string | null,
        ackLanded: true,
        ackTimedOut: false,
        finalizedMarker: undefined as string | undefined,
      };
      const reportPath = join(root, "report.json");

      const stop = await finalizeGatewayRun({
        child: stub,
        report,
        mailDir,
        reportPath,
        stopDeadlineMs: 200,
        beforeWrite: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          report.finalizedMarker = "before-write-ran";
        },
      });
      expect(stop.stopped).toBe(true);
      expect(stop.stoppedGracefully).toBe(false);
      expect(stop.signalCode).toBe("SIGKILL");

      const written = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(written.stopped).toBe(true);
      expect(written.stoppedGracefully).toBe(false);
      expect(written.stopSignal).toBe("SIGKILL");
      expect(written.settledRead).toBe(false);
      expect(written.readErrors.join("; ")).toContain("did not stop gracefully");
      expect(written.replyCountAfterStop).toBeUndefined();
      // Finalization is the beforeWrite work, and a refused settled read must not
      // skip it: the async marker the callback adds is in the file on disk.
      expect(written.finalizedMarker).toBe("before-write-ran");

      // The consumer's own assertion, over the report.json read back. The settled
      // listing is main()'s unread initial state ([]), so the message must name
      // the stop decision, not a bare count of 0.
      const consumerReport = ackedReport();
      consumerReport.settledRead = written.settledRead;
      consumerReport.readErrors = written.readErrors;
      consumerReport.curEntriesSettled = [];
      let message = "";
      try {
        expectGatewayReport(consumerReport);
      } catch (err) {
        message = String((err as Error).message);
      }
      expect(message).toContain("the settled state was not read:");
      expect(message).toContain("did not stop gracefully");
      expect(message).not.toContain("found 0");
    } finally {
      if (stub) {
        if (stub.exitCode === null && stub.signalCode === null) stub.kill("SIGKILL");
        if (stub.exitCode === null && stub.signalCode === null) {
          await new Promise((resolve) => stub!.once("exit", resolve));
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("cli#1027 — a gateway that exits 0 on SIGTERM is reported as stopped gracefully", () => {
  it("writes the stop result and reads the settled listing", async () => {
    const node = process.env.TPS_LANE_NODE || "node";
    const root = mkdtempSync(join(tmpdir(), "tps-graceful-gateway-"));
    let stub: ReturnType<typeof spawn> | null = null;
    try {
      stub = await startGracefulStub(node);

      const mailDir = join(root, "mail");
      for (const dir of [
        join(mailDir, "agent-a", "new"),
        join(mailDir, "agent-a", "cur"),
        join(mailDir, "agent-a", ".obligations"),
        join(mailDir, "agent-b", "new"),
      ]) {
        mkdirSync(dir, { recursive: true });
      }
      const report = {
        readErrors: [] as string[],
        inboundId: null as string | null,
        inboundName: null as string | null,
        settledRead: false,
        stopped: false,
        stoppedGracefully: false,
        stopSignal: null as string | null,
        ackLanded: true,
        ackTimedOut: false,
      };
      const reportPath = join(root, "report.json");

      const stop = await finalizeGatewayRun({
        child: stub,
        report,
        mailDir,
        reportPath,
        stopDeadlineMs: 5_000,
      });
      expect(stop.stopped).toBe(true);
      expect(stop.stoppedGracefully).toBe(true);
      expect(stop.signalCode).toBeNull();

      const written = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(written.stopped).toBe(true);
      expect(written.stoppedGracefully).toBe(true);
      expect(written.stopSignal).toBeNull();
      expect(written.settledRead).toBe(true);
      expect(written.replyCountAfterStop).toBe(0);
      expect(written.readErrors).toEqual([]);
    } finally {
      if (stub) {
        if (stub.exitCode === null && stub.signalCode === null) stub.kill("SIGKILL");
        if (stub.exitCode === null && stub.signalCode === null) {
          await new Promise((resolve) => stub!.once("exit", resolve));
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("cli#1027 — beforeWrite runs after the stop and the settled read", () => {
  it("sees the stop fields and the settled listing on the report, and no report.json yet", async () => {
    const node = process.env.TPS_LANE_NODE || "node";
    const root = mkdtempSync(join(tmpdir(), "tps-finalize-order-"));
    let stub: ReturnType<typeof spawn> | null = null;
    try {
      stub = await startGracefulStub(node);

      const mailDir = join(root, "mail");
      for (const dir of [
        join(mailDir, "agent-a", "new"),
        join(mailDir, "agent-a", "cur"),
        join(mailDir, "agent-a", ".obligations"),
        join(mailDir, "agent-b", "new"),
      ]) {
        mkdirSync(dir, { recursive: true });
      }
      const report = {
        readErrors: [] as string[],
        inboundId: null as string | null,
        inboundName: null as string | null,
        settledRead: false,
        stopped: false,
        stoppedGracefully: false,
        stopSignal: null as string | null,
        ackLanded: true,
        ackTimedOut: false,
        replyCountAfterStop: undefined as number | undefined,
        curEntriesSettled: [] as CurEntry[],
      };
      const reportPath = join(root, "report.json");
      const probe: {
        stopped?: boolean;
        stoppedGracefully?: boolean;
        stopSignal?: string | null;
        settledRead?: boolean;
        replyCountAfterStop?: number;
        curEntriesSettled?: CurEntry[];
        entries?: string[];
      } = {};

      await finalizeGatewayRun({
        child: stub,
        report,
        mailDir,
        reportPath,
        stopDeadlineMs: 5_000,
        beforeWrite: async () => {
          probe.stopped = report.stopped;
          probe.stoppedGracefully = report.stoppedGracefully;
          probe.stopSignal = report.stopSignal;
          probe.settledRead = report.settledRead;
          probe.replyCountAfterStop = report.replyCountAfterStop;
          probe.curEntriesSettled = report.curEntriesSettled;
          probe.entries = readdirSync(root);
        },
      });

      expect(probe.stopped).toBe(true);
      expect(probe.stoppedGracefully).toBe(true);
      expect(probe.stopSignal).toBeNull();
      expect(probe.settledRead).toBe(true);
      expect(probe.replyCountAfterStop).toBe(0);
      expect(probe.curEntriesSettled).toEqual([]);
      expect(probe.entries).not.toContain("report.json");
      const written = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(written.stopped).toBe(true);
    } finally {
      if (stub) {
        if (stub.exitCode === null && stub.signalCode === null) stub.kill("SIGKILL");
        if (stub.exitCode === null && stub.signalCode === null) {
          await new Promise((resolve) => stub!.once("exit", resolve));
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
