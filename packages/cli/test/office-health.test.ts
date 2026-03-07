import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("tps office health", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalAgentId: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let originalLog: typeof console.log;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tps-office-health-"));
    originalHome = process.env.HOME;
    originalAgentId = process.env.TPS_AGENT_ID;
    originalFetch = globalThis.fetch;
    originalLog = console.log;

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
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("publishes agent.unhealthy once per stale window and republishes after recovery", async () => {
    const nowMs = Date.parse("2026-03-07T12:00:00.000Z");
    const staleIso = new Date(nowMs - 6 * 60 * 1000).toISOString();
    const freshIso = new Date(nowMs - 60 * 1000).toISOString();
    const cursorFile = join(tempHome, ".tps", "cursors", "ember-task-loop.json");
    mkdirSync(join(tempHome, ".tps", "cursors"), { recursive: true });
    writeFileSync(cursorFile, JSON.stringify({ since: "x" }), "utf-8");
    const staleCursorTime = new Date(nowMs - 6 * 60 * 1000);
    utimesSync(cursorFile, staleCursorTime, staleCursorTime);

    const published: any[] = [];
    let agentList = [
      { id: "ember", name: "Ember", publicKey: "pk1", lastHeartbeat: staleIso },
      { id: "flint", name: "Flint", publicKey: "pk2", lastHeartbeat: freshIso },
    ];

    globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/Agent/") && method === "GET") {
        return new Response(JSON.stringify(agentList), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/OrgEvent/") && method === "POST") {
        published.push(JSON.parse(String(init?.body)));
        return new Response("", { status: 204 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const { runOfficeHealthTick } = await import("../src/commands/office-health.js");
    const keyPath = join(tempHome, ".tps", "identity", "anvil.key");

    const first = await runOfficeHealthTick({
      viewerId: "anvil",
      flairUrl: "http://127.0.0.1:9926",
      keyPath,
      nowMs,
      state: { unhealthyAgents: {} },
    });
    expect(first.result.staleAgents).toBe(1);
    expect(first.result.publishedEvents).toBe(1);
    expect(first.result.agents.find((agent) => agent.agentId === "ember")?.issues.map((issue) => issue.code)).toEqual([
      "heartbeat_stale",
      "task_cursor_stale",
    ]);
    expect(published).toHaveLength(1);
    expect(published[0]?.kind).toBe("agent.unhealthy");
    expect(published[0]?.targetIds).toEqual(["ember"]);

    const second = await runOfficeHealthTick({
      viewerId: "anvil",
      flairUrl: "http://127.0.0.1:9926",
      keyPath,
      nowMs,
      state: first.state,
    });
    expect(second.result.publishedEvents).toBe(0);
    expect(published).toHaveLength(1);

    agentList = [
      { id: "ember", name: "Ember", publicKey: "pk1", lastHeartbeat: freshIso },
      { id: "flint", name: "Flint", publicKey: "pk2", lastHeartbeat: freshIso },
    ];
    const freshCursorTime = new Date(nowMs - 60 * 1000);
    utimesSync(cursorFile, freshCursorTime, freshCursorTime);
    const recovered = await runOfficeHealthTick({
      viewerId: "anvil",
      flairUrl: "http://127.0.0.1:9926",
      keyPath,
      nowMs,
      state: second.state,
    });
    expect(recovered.result.staleAgents).toBe(0);
    expect(recovered.result.publishedEvents).toBe(0);

    agentList = [
      { id: "ember", name: "Ember", publicKey: "pk1", lastHeartbeat: staleIso },
      { id: "flint", name: "Flint", publicKey: "pk2", lastHeartbeat: freshIso },
    ];
    const staleAgainCursorTime = new Date(nowMs - 6 * 60 * 1000);
    utimesSync(cursorFile, staleAgainCursorTime, staleAgainCursorTime);
    const republished = await runOfficeHealthTick({
      viewerId: "anvil",
      flairUrl: "http://127.0.0.1:9926",
      keyPath,
      nowMs,
      state: recovered.state,
    });
    expect(republished.result.publishedEvents).toBe(1);
    expect(published).toHaveLength(2);
  });

  test("runOfficeHealth emits one json object per tick when --json is enabled", async () => {
    const logs: string[] = [];
    console.log = mock((value?: unknown) => logs.push(String(value ?? ""))) as typeof console.log;
    globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/Agent/") && method === "GET") {
        return new Response(JSON.stringify([
          { id: "ember", name: "Ember", publicKey: "pk1", lastHeartbeat: new Date().toISOString() },
        ]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const { runOfficeHealth } = await import("../src/commands/office-health.js");
    await runOfficeHealth({ once: true, json: true, flairUrl: "http://127.0.0.1:9926", viewerId: "anvil", keyPath: join(tempHome, ".tps", "identity", "anvil.key") });

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.viewerId).toBe("anvil");
    expect(parsed.checkedAgents).toBe(1);
    expect(parsed.staleAgents).toBe(0);
    expect(parsed.agents[0].agentId).toBe("ember");
  });
});
