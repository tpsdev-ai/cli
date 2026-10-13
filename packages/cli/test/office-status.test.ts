/**
 * cli#554 — `tps office status` reads Flair through the shared verifying stub
 * (`helpers/stub-flair.ts`). The stub refuses a caller without a valid
 * TPS-Ed25519 signature, so the accepted tests prove office-status signs its
 * requests, and the no-key test asserts the refusal the real server returns
 * (HTTP 403) and how office-status reports it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatchShared } from "./helpers/patch-shared.js";
import { runOfficeStatus } from "../src/commands/office-status.js";
import { ORG_EVENT_MAX_PAGES, ORG_EVENT_PAGE_SIZE } from "../src/utils/org-event-read.js";
import {
  type FlairRoutes,
  installStubFlairFetch,
  orgEventCatchupRoute,
  writeKeyFile,
  type StubFlair,
} from "./helpers/stub-flair.js";

const patchShared = createPatchShared();

const SEED = Buffer.alloc(32, 0x71);

const AGENTS = [
  { id: "anvil", name: "Anvil", role: "engineer", model: "anthropic/claude-sonnet-4-6", status: "active", lastHeartbeat: new Date(Date.now() - 3 * 60_000).toISOString() },
  { id: "ember", name: "Ember", role: "implementer", status: "idle" },
];

const EVENTS = [
  { id: "e1", kind: "task.completed", authorId: "ember", summary: "Implemented ops-71", createdAt: new Date().toISOString() },
  { id: "e2", kind: "agent.heartbeat", authorId: "anvil", summary: "heartbeat", createdAt: new Date().toISOString() },
];

/** Flair routes the stub serves once it has verified the caller. */
function routes(req: Request, url: URL, caller: string): Response | undefined {
  if (url.pathname === "/Agent/") return Response.json(AGENTS);
  if (url.pathname.startsWith("/OrgEventCatchup/")) return orgEventCatchupRoute({ events: EVENTS })(req, url, caller);
  return undefined;
}

afterEach(() => {
  mock.restore();
});

let root: string;
let stub: StubFlair;
let keyPath: string;
let output: string[];
let savedLog: typeof console.log;
let savedError: typeof console.error;
let savedExit: typeof process.exit;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli554-office-status-"));
  keyPath = writeKeyFile(root, "anvil", SEED);
  stub = installStubFlairFetch({ anvil: SEED }, routes);
  output = [];
  savedLog = console.log;
  savedError = console.error;
  savedExit = process.exit;
  // A refused Agent read exits the command. Here an exit throws instead of ending the run: an unexpected
  // exit fails its test, and the refusal tests expect it and assert the rejection (`rejects.toThrow`).
  patchShared(process, "exit", ((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as typeof process.exit);
  patchShared(console, "log", (...args: unknown[]) => { output.push(args.join(" ")); });
  patchShared(console, "error", (...args: unknown[]) => { output.push("[ERR] " + args.join(" ")); });
});

afterEach(() => {
  stub.stop();
  patchShared(console, "log", savedLog);
  patchShared(console, "error", savedError);
  patchShared(process, "exit", savedExit);
  rmSync(root, { recursive: true, force: true });
});

function baseOpts() {
  return { flairUrl: stub.url, agentId: "anvil", keyPath, noColor: true };
}

describe("tps office status", () => {
  test("renders agent table from Flair", async () => {
    await runOfficeStatus(baseOpts());
    const joined = output.join("\n");
    expect(joined).toContain("Anvil");
    expect(joined).toContain("Ember");
    expect(joined).toContain("implementer");
    expect(joined).toContain("engineer");
  });

  test("shows task status from OrgEvents", async () => {
    await runOfficeStatus(baseOpts());
    expect(output.join("\n")).toContain("Implemented ops-71");
  });

  test("json output includes agents and openPrs arrays", async () => {
    await runOfficeStatus({ ...baseOpts(), json: true });
    const parsed = JSON.parse(output.join(""));
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.openPrs).toBeArray();
    expect(parsed.agents[0].id).toBe("anvil");
  });

  test("no PR section when repo not configured", async () => {
    await runOfficeStatus(baseOpts());
    expect(output.join("\n")).not.toContain("open PR");
  });

  test("shows blocker from OrgEvents", async () => {
    stub.stop();
    const blocker = [{ id: "b1", kind: "blocker", authorId: "ember", summary: "Missing Ember PAT", createdAt: new Date().toISOString() }];
    stub = installStubFlairFetch({ anvil: SEED }, (req, url, caller) =>
      url.pathname === "/Agent/" ? Response.json(AGENTS) : url.pathname.startsWith("/OrgEventCatchup/") ? orgEventCatchupRoute({ events: blocker })(req, url, caller) : undefined,
    );
    await runOfficeStatus(baseOpts());
    expect(output.join("\n")).toContain("BLOCKER: Missing Ember PAT");
  });

  test("a missing key sends no Authorization and office-status reports the refusal (HTTP 403)", async () => {
    patchShared(process, "exit", mock(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as typeof process.exit));
    await expect(runOfficeStatus({ ...baseOpts(), keyPath: "/nonexistent" })).rejects.toThrow("exit:1");
    expect(output.join("\n")).toContain(`Flair unreachable at ${stub.url} (HTTP 403)`);
  });
});

/**
 * cli#620 — office status reads the viewer's OrgEvent catch-up feed through
 * `readOrgEvents`. The catch-up route is `orgEventCatchupRoute`, a fake
 * modelled on Flair's coded catch-up contract (see its doc; the real resource
 * is not exercised). It registers its own viewer, so the fixtures here name no
 * production agent.
 */
describe("cli#620 — office status reads the OrgEvent catch-up feed", () => {
  const VIEWER = "viewer-a";
  const AGENT_LIST = [
    { id: "agent-a", name: "Agent A", role: "engineer", status: "active" },
    { id: "agent-b", name: "Agent B", role: "reviewer", status: "active" },
  ];
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const OLDER = { id: "e1", kind: "task.completed", authorId: "agent-a", summary: "older task", createdAt: at(50) };
  const NEWER = { id: "e2", kind: "task.completed", authorId: "agent-a", summary: "newer task", createdAt: at(5) };
  /** `count` distinct events by `authorId`, one millisecond apart from `minutesAgo`, ids `<prefix><n>`. */
  const rows = (count: number, authorId: string, minutesAgo: number, prefix: string) =>
    Array.from({ length: count }, (_, n) => ({
      id: `${prefix}${String(n).padStart(5, "0")}`,
      kind: "task.completed",
      authorId,
      summary: `${prefix} task ${n}`,
      createdAt: new Date(Date.now() - minutesAgo * 60_000 + n).toISOString(),
    }));
  /** More distinct events than the read bound holds: the bound's pages, plus one. */
  const PAST_BOUND = ORG_EVENT_MAX_PAGES * ORG_EVENT_PAGE_SIZE + 1;

  /** Run office status against a viewer whose OrgEvent read is answered by `answer`; return the output. */
  async function status(answer: FlairRoutes, json = false): Promise<string> {
    stub.stop();
    const key = writeKeyFile(root, VIEWER, SEED);
    stub = installStubFlairFetch({ [VIEWER]: SEED }, (req, url, caller) =>
      url.pathname === "/Agent/"
        ? Response.json(AGENT_LIST)
        : url.pathname.startsWith("/OrgEventCatchup/")
          ? answer(req, url, caller)
          : undefined,
    );
    await runOfficeStatus({ flairUrl: stub.url, agentId: VIEWER, keyPath: key, noColor: true, json });
    return output.join("\n");
  }
  const row = (out: string, name: string) => out.split("\n").find((line) => line.includes(` ${name} `)) ?? "";
  const jsonAgents = () =>
    (JSON.parse(output.filter((l) => !l.startsWith("[ERR] ")).join("\n")) as { agents: Array<Record<string, any>> }).agents;

  test("a nonempty read shows each agent's newest selected task event and, with no record heartbeat, the newest feed heartbeat", async () => {
    const beats = [
      { id: "h1", kind: "agent.heartbeat", authorId: "agent-b", summary: "heartbeat", createdAt: at(50) },
      { id: "h2", kind: "agent.heartbeat", authorId: "agent-b", summary: "heartbeat", createdAt: at(3) },
    ];
    const out = await status(orgEventCatchupRoute({ events: [OLDER, NEWER, ...beats] }));
    expect(out).not.toContain("Cannot read OrgEvents");
    expect(row(out, "Agent A")).toContain("newer task");
    expect(row(out, "Agent A")).not.toContain("older task");
    expect(row(out, "Agent B")).toContain("3m ago");
    expect(row(out, "Agent B")).toContain("idle");
  });

  test("the Agent record's heartbeat takes precedence over a newer feed heartbeat, in the table and JSON", async () => {
    const recordBeat = at(30);
    const agents = [{ ...AGENT_LIST[0]!, lastHeartbeat: recordBeat }, AGENT_LIST[1]!];
    const feed = orgEventCatchupRoute({
      events: [{ id: "h1", kind: "agent.heartbeat", authorId: "agent-a", summary: "heartbeat", createdAt: at(3) }],
    });
    const run = async (json: boolean) => {
      stub.stop();
      output.length = 0;
      const key = writeKeyFile(root, VIEWER, SEED);
      stub = installStubFlairFetch({ [VIEWER]: SEED }, (req, url, caller) =>
        url.pathname === "/Agent/" ? Response.json(agents) : url.pathname.startsWith("/OrgEventCatchup/") ? feed(req, url, caller) : undefined,
      );
      await runOfficeStatus({ flairUrl: stub.url, agentId: VIEWER, keyPath: key, noColor: true, json });
      return output.join("\n");
    };
    const table = await run(false);
    expect(row(table, "Agent A")).toContain("30m ago");
    expect(row(table, "Agent A")).not.toContain("3m ago");
    await run(true);
    expect(jsonAgents()[0]!.lastHeartbeat).toBe(recordBeat);
  });

  test("the blocker line shows the newest blocker read, not the first", async () => {
    const blockers = [
      { id: "b1", kind: "blocker", authorId: "agent-a", summary: "older blocker", createdAt: at(40) },
      { id: "b2", kind: "blocker", authorId: "agent-b", summary: "newer blocker", createdAt: at(4) },
    ];
    const out = await status(orgEventCatchupRoute({ events: blockers }));
    expect(out).toContain("BLOCKER: newer blocker");
    expect(out).not.toContain("older blocker");
  });

  test("a feed of several pages is read to the end, each page after the last", async () => {
    const route = orgEventCatchupRoute({ events: [OLDER, ...rows(ORG_EVENT_PAGE_SIZE, "agent-c", 40, "f"), NEWER] });
    const out = await status(route);
    expect(route.afters).toHaveLength(2);
    expect(route.afters[1]! > route.afters[0]!).toBe(true);
    expect(new Set(route.served).size).toBe(ORG_EVENT_PAGE_SIZE + 2);
    expect(out).not.toContain("incomplete");
    expect(row(out, "Agent A")).toContain("newer task");
  });

  test("a refused read (HTTP 403) is reported, and the task column reads unavailable", async () => {
    const out = await status(() => new Response(null, { status: 403 }));
    expect(out).toContain(`Cannot read OrgEvents from ${stub.url} (HTTP 403); activity is unavailable.`);
    expect(row(out, "Agent A")).toContain("unavailable");
    expect(row(out, "Agent B")).toContain("unavailable");
    expect(out).not.toContain("idle");
  });

  test("a rejected request is reported with its code, never its message", async () => {
    const out = await status(() => {
      throw Object.assign(new TypeError("message-text-not-printed"), { code: "ECONNREFUSED" });
    });
    expect(out).toContain(`Cannot read OrgEvents from ${stub.url} (request failed (ECONNREFUSED)); activity is unavailable.`);
    expect(out).not.toContain("message-text-not-printed");
    expect(row(out, "Agent A")).toContain("unavailable");
  });

  test.each([
    ["an array body", () => Response.json([NEWER]), "not an object"],
    ["an event missing a field", () => Response.json({ events: [{ ...NEWER, authorId: 7 }], hasMore: false }), "an event lacks a field the command reads"],
    ["a page with no cursor", () => Response.json({ events: [{ ...NEWER, position: `${NEWER.createdAt}\t${NEWER.id}` }], hasMore: true }), "nextAfter is missing"],
  ])("a malformed response (%s) is reported, and the task column reads unavailable", async (_label, answer, note) => {
    const out = await status(answer);
    expect(out).toContain(`Cannot read OrgEvents from ${stub.url} (malformed response (${note})); activity is unavailable.`);
    expect(out).not.toContain("newer task");
    expect(row(out, "Agent A")).toContain("unavailable");
  });

  test("a feed past the page bound is read up to the bound, with advancing cursors over distinct events, and marked incomplete", async () => {
    const route = orgEventCatchupRoute({ events: rows(PAST_BOUND, "agent-a", 60, "b") });
    const out = await status(route);
    expect(route.afters).toHaveLength(ORG_EVENT_MAX_PAGES);
    for (let i = 1; i < route.afters.length; i++) expect(route.afters[i]! > route.afters[i - 1]!).toBe(true);
    expect(route.served).toHaveLength(ORG_EVENT_MAX_PAGES * ORG_EVENT_PAGE_SIZE);
    expect(new Set(route.served).size).toBe(route.served.length);
    expect(out).toContain(`OrgEvents from ${stub.url} exceed the ${ORG_EVENT_MAX_PAGES}-page read bound; newer events were not read and activity is incomplete.`);
    expect(row(out, "Agent A")).toContain("(incomplete)");
    expect(row(out, "Agent B")).toContain("incomplete");
    expect(out).not.toContain("idle");
  });

  test.each([
    ["ok", () => orgEventCatchupRoute({ events: [OLDER, NEWER] }), "newer task"],
    ["unavailable", () => () => new Response(null, { status: 403 }), undefined],
    ["incomplete", () => orgEventCatchupRoute({ events: rows(PAST_BOUND, "agent-a", 60, "b") }), `b task ${PAST_BOUND - 2}`],
  ])("JSON output gives each agent the activity state %s", async (state, answer, summary) => {
    await status(answer(), true);
    const agents = jsonAgents();
    expect(agents.map((a) => a.activity)).toEqual([state, state]);
    expect(agents[0]!.lastTask?.summary).toBe(summary);
  });
});

/**
 * cli#624 — the task loop persists its cursor as `{ position, updatedAt }`;
 * earlier releases wrote `{ since }`. Office status reads a real cursor file
 * under the current HOME in either format and shows the cursor's timestamp:
 * the position's createdAt, or the legacy since.
 */
describe("cli#624 — office status reads the task loop cursor in either format", () => {
  const savedHome = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = root;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  function writeCursor(agentId: string, content: string): void {
    mkdirSync(join(root, ".tps", "cursors"), { recursive: true });
    writeFileSync(join(root, ".tps", "cursors", `${agentId}-task-loop.json`), content);
  }
  const jsonAgents = () =>
    (JSON.parse(output.filter((l) => !l.startsWith("[ERR] ")).join("\n")) as { agents: Array<Record<string, any>> }).agents;

  test.each([
    ["the position format", (ts: string) => ({ position: `${ts}\te9`, updatedAt: new Date().toISOString() })],
    ["the legacy since format", (ts: string) => ({ since: ts })],
  ])("a cursor in %s gives its timestamp in JSON and its age in the table", async (_label, body) => {
    const ts = new Date(Date.now() - 7 * 60_000).toISOString();
    writeCursor("anvil", JSON.stringify(body(ts)));

    await runOfficeStatus({ ...baseOpts(), json: true });
    const agents = jsonAgents();
    expect(agents.find((a) => a.id === "anvil")!.cursorSince).toBe(ts);
    expect(agents.find((a) => a.id === "ember")!.cursorSince).toBeNull();

    output.length = 0;
    await runOfficeStatus(baseOpts());
    expect(output.join("\n")).toContain("cursor: 7m ago");
  });

  test.each([
    ["not JSON", "{not json"],
    ["neither a position nor a since", JSON.stringify({ updatedAt: new Date().toISOString() })],
    ["a position with no parseable timestamp", JSON.stringify({ position: "not-a-date\te9" })],
  ])("a cursor file holding %s shows no cursor", async (_label, content) => {
    writeCursor("anvil", content);
    await runOfficeStatus({ ...baseOpts(), json: true });
    expect(jsonAgents().find((a) => a.id === "anvil")!.cursorSince).toBeNull();
    output.length = 0;
    await runOfficeStatus(baseOpts());
    expect(output.join("\n")).not.toContain("cursor:");
  });
});
