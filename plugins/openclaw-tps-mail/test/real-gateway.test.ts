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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  curRecord: { id?: string; ackedAt?: unknown } | null;
  obligationRecord: { state?: string } | null;
  inboundNewFiles: string[];
  readErrors: string[];
  inboundId: string | null;
  ackLines: string[];
  logs: string[];
  logTail?: string[];
};

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
      expect(r.curFiles).toHaveLength(1);
      expect(r.curFiles[0]).toContain(r.inboundId!);
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
