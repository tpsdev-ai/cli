import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runOfficeStatus } from "../src/commands/office-status.js";

let _savedFetch: typeof globalThis.fetch;
let output: string[] = [];
let _savedLog: typeof console.log;
let _savedError: typeof console.error;

beforeEach(() => {
  _savedFetch = globalThis.fetch;
  _savedLog = console.log;
  _savedError = console.error;
  output = [];
  console.log = (...args: unknown[]) => { output.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { output.push("[ERR] " + args.join(" ")); };
});

afterEach(() => {
  globalThis.fetch = _savedFetch;
  console.log = _savedLog;
  console.error = _savedError;
});

const AGENTS = [
  { id: "anvil", name: "Anvil", role: "engineer", model: "anthropic/claude-sonnet-4-6", status: "active", lastHeartbeat: new Date(Date.now() - 3 * 60_000).toISOString() },
  { id: "ember", name: "Ember", role: "implementer", status: "idle" },
];

const EVENTS = [
  { id: "e1", kind: "task.completed", authorId: "ember", summary: "Implemented ops-71", createdAt: new Date().toISOString() },
  { id: "e2", kind: "agent.heartbeat", authorId: "anvil", createdAt: new Date().toISOString() },
];

function makeFetch(agentData: object[], eventData: object[]) {
  return async function(input: string | URL): Promise<Response> {
    const url = String(input);
    if (url.includes("/Agent/")) return new Response(JSON.stringify(agentData), { status: 200 });
    if (url.includes("/OrgEventCatchup/")) return new Response(JSON.stringify(eventData), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const BASE_OPTS = { flairUrl: "http://localhost:9926", agentId: "anvil", keyPath: "/nonexistent", noColor: true };

describe("tps office status", () => {
  test("renders agent table from Flair", async () => {
    globalThis.fetch = makeFetch(AGENTS, EVENTS) as typeof globalThis.fetch;
    await runOfficeStatus(BASE_OPTS);
    const joined = output.join("\n");
    expect(joined).toContain("Anvil");
    expect(joined).toContain("Ember");
    expect(joined).toContain("implementer");
    expect(joined).toContain("engineer");
  });

  test("shows task status from OrgEvents", async () => {
    globalThis.fetch = makeFetch(AGENTS, EVENTS) as typeof globalThis.fetch;
    await runOfficeStatus(BASE_OPTS);
    expect(output.join("\n")).toContain("Implemented ops-71");
  });

  test("json output includes agents and openPrs arrays", async () => {
    globalThis.fetch = makeFetch(AGENTS, []) as typeof globalThis.fetch;
    await runOfficeStatus({ ...BASE_OPTS, json: true });
    const parsed = JSON.parse(output.join(""));
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.openPrs).toBeArray();
    expect(parsed.agents[0].id).toBe("anvil");
  });

  test("no PR section when repo not configured", async () => {
    globalThis.fetch = makeFetch(AGENTS, []) as typeof globalThis.fetch;
    await runOfficeStatus(BASE_OPTS);
    expect(output.join("\n")).not.toContain("open PR");
  });

  test("shows blocker from OrgEvents", async () => {
    const blockerEvents = [{ id: "b1", kind: "blocker", authorId: "ember", summary: "Missing Ember PAT", createdAt: new Date().toISOString() }];
    globalThis.fetch = makeFetch(AGENTS, blockerEvents) as typeof globalThis.fetch;
    await runOfficeStatus(BASE_OPTS);
    expect(output.join("\n")).toContain("BLOCKER: Missing Ember PAT");
  });
});
