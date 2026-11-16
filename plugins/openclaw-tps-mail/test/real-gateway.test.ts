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
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMailboxMessageFile } from "@tpsdev-ai/agent";
import { decideSettledRead } from "./real-gateway-driver.mjs";

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
 * mismatch the message names every entry with its size.
 */
function expectOneSettledCurEntry(entries: CurEntry[], inboundId: string): void {
  if (entries.length !== 1) {
    throw new Error(
      `expected exactly 1 entry in settled cur/, found ${entries.length}; cur/ entries: ${describeCurEntries(entries)}`,
    );
  }
  expect(entries[0]?.name).toContain(inboundId);
}

function expectGatewayReport(r: Report): void {
  expectAckLanded(r);
  expectOneSettledCurEntry(r.curEntriesSettled, r.inboundId!);
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
  expect(r.readErrors).toEqual([]);
  expect(typeof r.curRecord?.ackedAt).toBe("string");
  expect(r.obligationRecord?.state).toBe("acked");
  expect(r.ackLines).toHaveLength(1);
  expect(r.ackLines[0]).toContain(r.inboundId!);
  expect(r.ackLines[0]).toContain("receipt found");
  expect(r.unexpected).toEqual([]);
}

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
  function entriesIn(dir: string): CurEntry[] {
    return readdirSync(dir).map((name) => ({ name, size: statSync(join(dir, name)).size }));
  }

  it("names every entry when the settled cur/ holds two inbound messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-cur-entries-"));
    try {
      writeFileSync(join(dir, "2026-01-01T00-00-00-000Z-msg-one.json"), "{\"id\":\"msg-one\"}");
      writeFileSync(join(dir, "2026-01-01T00-00-00-001Z-msg-two.json"), "{\"id\":\"msg-two\"}");
      const entries = entriesIn(dir);
      let message = "";
      try {
        expectOneSettledCurEntry(entries, "msg-one");
      } catch (err) {
        message = String((err as Error).message);
      }
      expect(message).toContain("found 2");
      expect(message).toContain("msg-one.json");
      expect(message).toContain("msg-two.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the settled assertion on a leaked ack scratch beside the record", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-cur-leak-"));
    try {
      writeFileSync(join(dir, "2026-01-01T00-00-00-000Z-msg-one.json"), "{\"id\":\"msg-one\"}");
      writeFileSync(join(dir, ".ack-7c1a9d2e-4b3f-4a51-9c8e-1f2d3e4a5b6c.tmp"), "{}");
      const entries = entriesIn(dir);
      let message = "";
      try {
        expectOneSettledCurEntry(entries, "msg-one");
      } catch (err) {
        message = String((err as Error).message);
      }
      expect(message).toContain("found 2");
      expect(message).toContain("msg-one.json");
      expect(message).toContain(".ack-7c1a9d2e-4b3f-4a51-9c8e-1f2d3e4a5b6c.tmp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cli#1020 — a timed-out ack is judged on its own assertion", () => {
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
      ackTimedOut: false,
      ackLines: ["acked msg-one: receipt found"],
      logs: [],
    };
  }

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
    expect(decideSettledRead({ stopped: true, ackTimedOut: false })).toEqual({ read: true, readError: null });
  });

  it("skips the read and names the ack timeout", () => {
    expect(decideSettledRead({ stopped: true, ackTimedOut: true })).toEqual({
      read: false,
      readError: "ack never landed before its deadline; settled state not read",
    });
  });

  it("skips the read and names an unstopped gateway", () => {
    for (const ackTimedOut of [false, true]) {
      expect(decideSettledRead({ stopped: false, ackTimedOut })).toEqual({
        read: false,
        readError: "gateway did not stop within the deadline; settled state not read",
      });
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
