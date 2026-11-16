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
import { fileURLToPath } from "node:url";

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
      expect(r.openclawVersion).toBe("2026.8.1");
      expect(r.dispatchStarts).toBe(1);
      expect(r.modelTurnTexts).toEqual(["PROGRESS: drafting the answer", "FINAL: the task is complete"]);
      expect(r.replyCount).toBe(1);
      expect(r.replyBody).toBe("FINAL: the task is complete");
      expect(r.replyFrom).toBe("agent-a");
      expect(r.replyTo).toBe("agent-b");
      expect(r.replyHeaders?.["X-TPS-InReplyTo"]).toBe(r.inboundId);
      expectOneSettledCurEntry(r.curEntriesSettled, r.inboundId!);
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
