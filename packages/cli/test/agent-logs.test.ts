import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("tps agent logs", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalAgentId: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tps-agent-logs-"));
    originalHome = process.env.HOME;
    originalAgentId = process.env.TPS_AGENT_ID;
    originalFetch = globalThis.fetch;
    originalLog = console.log;
    originalError = console.error;
    originalExit = process.exit;

    process.env.HOME = tempHome;
    process.env.TPS_AGENT_ID = "anvil";
    mkdirSync(join(tempHome, ".tps", "identity"), { recursive: true });
    writeFileSync(join(tempHome, ".tps", "identity", "anvil.key"), Buffer.alloc(32, 7));
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAgentId === undefined) delete process.env.TPS_AGENT_ID;
    else process.env.TPS_AGENT_ID = originalAgentId;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("interleaves flair events and mail sorted by timestamp", async () => {
    const out: string[] = [];
    const requests: Array<{ url: string; auth?: string }> = [];
    console.log = mock((value?: unknown) => out.push(String(value ?? ""))) as typeof console.log;
    globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url: String(input), auth: String(headers.Authorization ?? "") });
      return new Response(JSON.stringify([
        { id: "e1", authorId: "ember", kind: "task.completed", summary: "Completed ops-72", createdAt: "2026-03-07T10:02:00.000Z", targetIds: ["host"] },
        { id: "e2", authorId: "host", kind: "task.assigned", summary: "Assigned follow-up", createdAt: "2026-03-07T10:04:00.000Z", targetIds: ["ember"] },
        { id: "e3", authorId: "host", kind: "org.note", summary: "Ignore me", createdAt: "2026-03-07T10:06:00.000Z", targetIds: ["someone-else"] },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    const mailDir = join(tempHome, ".tps", "mail");
    mkdirSync(join(mailDir, "ember", "new"), { recursive: true });
    mkdirSync(join(mailDir, "ember", "cur"), { recursive: true });
    writeFileSync(join(mailDir, "ember", "new", "latest.json"), JSON.stringify({
      id: "m1", from: "host", to: "ember", body: "Status update\nbody", timestamp: "2026-03-07T10:05:00.000Z",
    }));
    writeFileSync(join(mailDir, "ember", "cur", "older.json"), JSON.stringify({
      id: "m2", from: "kern", to: "ember", body: "\nNeed review", timestamp: "2026-03-07T10:03:00.000Z",
    }));

    const { runAgentLogs } = await import("../src/commands/agent-logs.js");
    await runAgentLogs({ agentId: "ember", mailDir, limit: 4, flairUrl: "http://127.0.0.1:19926", keyPath: join(tempHome, ".tps", "identity", "anvil.key") });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/OrgEventCatchup/ember?since=");
    expect(requests[0]?.auth).toContain("TPS-Ed25519 anvil:");
    expect(out).toHaveLength(4);
    expect(out[0]).toContain("Status update");
    expect(out[1]).toContain("Assigned follow-up");
    expect(out[2]).toContain("Need review");
    expect(out[3]).toContain("Completed ops-72");
    expect(out.join("\n")).not.toContain("Ignore me");
  });

  test("emits json rows and fails without a viewer identity", async () => {
    const out: string[] = [];
    const errors: string[] = [];
    console.log = mock((value?: unknown) => out.push(String(value ?? ""))) as typeof console.log;
    console.error = mock((value?: unknown) => errors.push(String(value ?? ""))) as typeof console.error;
    globalThis.fetch = mock(async () => new Response(JSON.stringify([
      { id: "e1", authorId: "ember", kind: "task.completed", summary: "Completed ops-72", createdAt: "2026-03-07T10:02:00.000Z", targetIds: [] },
    ]), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof globalThis.fetch;

    const mailDir = join(tempHome, ".tps", "mail");
    mkdirSync(join(mailDir, "ember", "new"), { recursive: true });
    writeFileSync(join(mailDir, "ember", "new", "latest.json"), JSON.stringify({
      id: "m1", from: "host", to: "ember", headers: { Subject: "Direct subject" }, body: "fallback body", timestamp: "2026-03-07T10:05:00.000Z",
    }));

    const { runAgentLogs } = await import("../src/commands/agent-logs.js");
    await runAgentLogs({ agentId: "ember", mailDir, json: true, limit: 2, keyPath: join(tempHome, ".tps", "identity", "anvil.key"), flairUrl: "http://127.0.0.1:19926" });
    expect(JSON.parse(out[0]!)).toEqual([
      { source: "mail", kind: "mail", summary: "Direct subject", timestamp: "2026-03-07T10:05:00.000Z" },
      { source: "flair", kind: "task.completed", summary: "Completed ops-72", timestamp: "2026-03-07T10:02:00.000Z" },
    ]);

    process.exit = mock(((code?: number) => { throw new Error("exit:" + (code ?? 0)); }) as typeof process.exit);
    delete process.env.TPS_AGENT_ID;
    await expect(runAgentLogs({ agentId: "ember" })).rejects.toThrow("exit:1");
    expect(errors.join("\n")).toContain("Invalid viewer id");
  });
});
