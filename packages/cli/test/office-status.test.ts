/**
 * cli#554 — `tps office status` reads Flair through the shared verifying stub
 * (`helpers/stub-flair.ts`). The stub refuses a caller without a valid
 * TPS-Ed25519 signature, so the accepted tests prove office-status signs its
 * requests, and the no-key test asserts the refusal the real server returns
 * (HTTP 403) and how office-status reports it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatchShared } from "./helpers/patch-shared.js";
import { runOfficeStatus } from "../src/commands/office-status.js";
import {
  type FlairRoutes,
  installStubFlairFetch,
  type PresenceRow,
  presenceRecords,
  presenceRoute,
  writeKeyFile,
  type StubFlair,
} from "./helpers/stub-flair.js";

const patchShared = createPatchShared();

const SEED = Buffer.alloc(32, 0x71);
/** A key the stub does not hold for the viewer. */
const OTHER_SEED = Buffer.alloc(32, 0x72);

const AGENTS = [
  { id: "agent-a", name: "Agent A", role: "engineer", model: "vendor/model-a", status: "active" },
  { id: "agent-b", name: "Agent B", role: "implementer", status: "idle" },
];

/** A stored Presence row: `id`'s last heartbeat `minutesAgo` minutes ago, asserting `coding`. */
const beat = (id: string, minutesAgo: number, over: Partial<PresenceRow> = {}): PresenceRow => ({
  agentId: id, lastHeartbeatAt: Date.now() - minutesAgo * 60_000, activity: "coding", ...over,
});

/** Flair routes the stub serves once it has verified the caller. */
const routes: FlairRoutes = (req, url, caller) => {
  if (url.pathname === "/Agent/") return Response.json(AGENTS);
  return presenceRoute([beat("agent-a", 5, { currentTask: "reviewing a PR" })])(req, url, caller);
};

let root: string;
let stub: StubFlair;
let keyPath: string;
let output: string[];
let savedLog: typeof console.log;
let savedError: typeof console.error;
let savedExit: typeof process.exit;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli554-office-status-"));
  keyPath = writeKeyFile(root, "viewer-a", SEED);
  stub = installStubFlairFetch({ "viewer-a": SEED }, routes);
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
  return { flairUrl: stub.url, agentId: "viewer-a", keyPath, noColor: true };
}

describe("tps office status", () => {
  test("renders agent table from Flair", async () => {
    await runOfficeStatus(baseOpts());
    const joined = output.join("\n");
    expect(joined).toContain("Agent A");
    expect(joined).toContain("Agent B");
    expect(joined).toContain("implementer");
    expect(joined).toContain("engineer");
  });

  test("shows stored presence status, heartbeat age and current task on the queried instance", async () => {
    await runOfficeStatus(baseOpts());
    const joined = output.join("\n");
    expect(joined).toContain("reviewing a PR");
    expect(joined).toContain("idle (5m ago)");
    expect(joined).toContain("no presence on this instance");
  });

  test("json output includes agents and openPrs arrays", async () => {
    await runOfficeStatus({ ...baseOpts(), json: true });
    const parsed = JSON.parse(output.join(""));
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.openPrs).toBeArray();
    expect(parsed.agents[0].id).toBe("agent-a");
  });

  test("no PR section when repo not configured", async () => {
    await runOfficeStatus(baseOpts());
    expect(output.join("\n")).not.toContain("open PR");
  });

  test("a missing key sends no Authorization and office-status reports the refusal (HTTP 403)", async () => {
    await expect(runOfficeStatus({ ...baseOpts(), keyPath: "/nonexistent" })).rejects.toThrow("exit:1");
    expect(output.join("\n")).toContain(`Flair unreachable at ${stub.url} (HTTP 403)`);
  });
});

/**
 * cli#622 — office status reads the queried Flair instance's Presence roster
 * through `readPresence`. `/Presence` is served by `presenceRoute`, the shared
 * stub's fake of Flair's coded contract: it derives each record's status and
 * activity freshness from stored heartbeat rows as resources/Presence.ts does,
 * and the stub refuses an unsigned read with Flair's 401 (see their docs). The
 * fixtures name no production agent.
 */
describe("cli#622 — office status reads the Presence roster", () => {
  const VIEWER = "viewer-a";
  const AGENT_LIST = [
    { id: "agent-a", name: "Agent A", role: "engineer", status: "active" },
    { id: "agent-b", name: "Agent B", role: "reviewer", status: "active" },
  ];

  /**
   * Run office status against a viewer whose Presence read is answered by
   * `answer`; return the output. `afterAgentRead` runs once the Agent list has
   * been answered, before the Presence read.
   */
  async function status(answer: FlairRoutes, opts: { json?: boolean; afterAgentRead?: (keyPath: string) => void } = {}): Promise<string> {
    stub.stop();
    output.length = 0;
    const key = writeKeyFile(root, VIEWER, SEED);
    stub = installStubFlairFetch({ [VIEWER]: SEED }, (req, url, caller) => {
      if (url.pathname === "/Agent/") {
        opts.afterAgentRead?.(key);
        return Response.json(AGENT_LIST);
      }
      return url.pathname === "/Presence" ? answer(req, url, caller) : undefined;
    });
    await runOfficeStatus({ flairUrl: stub.url, agentId: VIEWER, keyPath: key, noColor: true, json: opts.json });
    return output.join("\n");
  }
  const row = (out: string, name: string) => out.split("\n").find((line) => line.includes(` ${name} `)) ?? "";
  const jsonAgents = () =>
    (JSON.parse(output.filter((l) => !l.startsWith("[ERR] ")).join("\n")) as { agents: Array<Record<string, any>> }).agents;
  /** Flair's records for `rows` with `over` applied to the first. */
  const corrupt = (rows: PresenceRow[], over: Record<string, unknown>): FlairRoutes => () =>
    Response.json(presenceRecords(rows).map((r, i) => (i === 0 ? { ...r, ...over } : r)));

  test("shows presence status and current task, and 'no presence on this instance' for a listed agent with no stored Presence row on the queried instance", async () => {
    const out = await status(presenceRoute([beat("agent-a", 0.5, { currentTask: "reviewing a PR" })]));
    expect(out).not.toContain("Cannot read Presence");
    expect(out).toContain("LAST SEEN");
    expect(row(out, "Agent A")).toContain("active (just now)");
    expect(row(out, "Agent A")).toContain("reviewing a PR");
    expect(row(out, "Agent B")).toContain("no presence on this instance");
    expect(row(out, "Agent B").trimEnd().endsWith(" —")).toBe(true);
    expect(out).not.toContain("never seen");
  });

  test("accepts a task whose trim-then-slice output ends in a space", async () => {
    const task = "x".repeat(199) + " ";
    const route = presenceRoute([beat("agent-a", 0.5, { currentTask: `  ${task}tail  ` })]);
    const out = await status(route);
    expect(out).not.toContain("Cannot read Presence");
    expect(row(out, "Agent A")).toContain(task);
    await status(route, { json: true });
    expect(jsonAgents()[0]!.presence.currentTask).toBe(task);
    expect(jsonAgents()[0]!.doing).toBe(task);
  });

  test("a heartbeat past Flair's idle threshold reads idle, and its still-fresh activity shows", async () => {
    const out = await status(presenceRoute([beat("agent-a", 5, { activity: "debugging" })]));
    expect(row(out, "Agent A")).toContain("idle (5m ago)");
    expect(row(out, "Agent A")).toContain("debugging");
    expect(row(out, "Agent A")).not.toContain("was:");
  });

  test("a heartbeat past Flair's offline threshold reads offline with its last-known activity, and its stale task is not shown", async () => {
    const out = await status(presenceRoute([beat("agent-a", 3 * 1440, { activity: "debugging", currentTask: "a finished task" })]));
    expect(row(out, "Agent A")).toContain("offline (3d ago)");
    expect(row(out, "Agent A")).toContain("was: debugging");
    expect(out).not.toContain("a finished task");
  });

  test("an activity Flair reports stale reads was: <activity> while the heartbeat is live", async () => {
    const out = await status(presenceRoute([beat("agent-a", 0.5, { activity: "planning", activityUpdatedAt: Date.now() - 20 * 60_000 })]));
    expect(row(out, "Agent A")).toContain("active (just now)");
    expect(row(out, "Agent A")).toContain("was: planning");
  });

  test("a Presence read signed with a key Flair does not hold for the viewer gets Flair's 401, is reported, and the columns read unavailable", async () => {
    const out = await status(presenceRoute([beat("agent-a", 0.5)]), { afterAgentRead: (key) => writeFileSync(key, OTHER_SEED) });
    expect(out).toContain(`Cannot read Presence from ${stub.url} (HTTP 401); presence is unavailable.`);
    expect(row(out, "Agent A")).toContain("unavailable");
    expect(row(out, "Agent B")).toContain("unavailable");
    expect(out).not.toContain("no presence on this instance");
  });

  test("a Presence read the command cannot sign is not sent, is reported, and the columns read unavailable", async () => {
    const out = await status(presenceRoute([beat("agent-a", 0.5)]), { afterAgentRead: (key) => rmSync(key) });
    expect(out).toContain(`Cannot read Presence from ${stub.url} (not signed (no request sent)); presence is unavailable.`);
    expect(row(out, "Agent A")).toContain("unavailable");
    expect(row(out, "Agent B")).toContain("unavailable");
    expect(out).not.toContain("no presence on this instance");
  });

  test("a rejected request is reported with its code, never its message", async () => {
    const out = await status(() => {
      throw Object.assign(new TypeError("message-text-not-printed"), { code: "ECONNREFUSED" });
    });
    expect(out).toContain(`Cannot read Presence from ${stub.url} (request failed (ECONNREFUSED)); presence is unavailable.`);
    expect(out).not.toContain("message-text-not-printed");
    expect(row(out, "Agent A")).toContain("unavailable");
  });

  test.each([
    ["a body that is not an array", () => Response.json({ agents: [] }), "body is not an array"],
    ["a body that is not JSON", () => new Response("not json"), "body is not JSON"],
    ["a status outside Flair's vocabulary", corrupt([beat("agent-a", 0.5)], { presenceStatus: "busy" }), "a presence record has a missing or invalid presenceStatus"],
    ["a current task that is not a string", corrupt([beat("agent-a", 0.5)], { currentTask: 42 }), "a presence record has a missing or invalid currentTask"],
    ["an activityFresh that is not a boolean", corrupt([beat("agent-a", 0.5)], { activityFresh: "yes" }), "a presence record has a missing or invalid activityFresh"],
    ["a record missing lastActivity", corrupt([beat("agent-a", 0.5)], { lastActivity: undefined }), "a presence record has a missing or invalid lastActivity"],
    ["a current task of only whitespace", corrupt([beat("agent-a", 0.5)], { currentTask: "   " }), "a presence record has a missing or invalid currentTask"],
    ["a stale record with a current task", corrupt([beat("agent-a", 60)], { currentTask: "a stale task" }), "a stale presence record carries a current task or an activity other than idle"],
    ["two records for one agent", () => Response.json(presenceRecords([beat("agent-a", 0.5), beat("agent-a", 5)])), "two presence records share an id"],
  ])("a malformed response (%s) is reported, and the columns read unavailable", async (_label, answer, note) => {
    const out = await status(answer);
    expect(out).toContain(`Cannot read Presence from ${stub.url} (malformed response (${note})); presence is unavailable.`);
    expect(row(out, "Agent A")).toContain("unavailable");
    expect(row(out, "Agent B")).toContain("unavailable");
    expect(out).not.toContain("a stale task");
    expect(out).not.toContain("no presence on this instance");
  });

  test("JSON output carries each agent's validated Presence fields, last-seen text, activity and presence state", async () => {
    await status(presenceRoute([beat("agent-a", 5, { currentTask: "reviewing a PR" })]), { json: true });
    const agents = jsonAgents();
    expect(agents.map((a) => a.presenceState)).toEqual(["ok", "ok"]);
    expect(Object.keys(agents[0]!.presence).sort()).toEqual(
      ["activity", "activityFresh", "currentTask", "id", "lastActivity", "lastHeartbeatAt", "presenceStatus"],
    );
    expect(agents[0]!.presence.presenceStatus).toBe("idle");
    expect(agents[0]!.lastSeen).toBe("idle (5m ago)");
    expect(agents[0]!.doing).toBe("reviewing a PR");
    expect(agents[1]!.presence).toBeNull();
    expect(agents[1]!.lastSeen).toBe("no presence on this instance");
    expect(agents[1]!.doing).toBeNull();
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
    writeCursor("agent-a", JSON.stringify(body(ts)));

    await runOfficeStatus({ ...baseOpts(), json: true });
    const agents = jsonAgents();
    expect(agents.find((a) => a.id === "agent-a")!.cursorSince).toBe(ts);
    expect(agents.find((a) => a.id === "agent-b")!.cursorSince).toBeNull();

    output.length = 0;
    await runOfficeStatus(baseOpts());
    expect(output.join("\n")).toContain("cursor: 7m ago");
  });

  test.each([
    ["not JSON", "{not json"],
    ["neither a position nor a since", JSON.stringify({ updatedAt: new Date().toISOString() })],
    ["a position with no parseable timestamp", JSON.stringify({ position: "not-a-date\te9" })],
  ])("a cursor file holding %s shows no cursor", async (_label, content) => {
    writeCursor("agent-a", content);
    await runOfficeStatus({ ...baseOpts(), json: true });
    expect(jsonAgents().find((a) => a.id === "agent-a")!.cursorSince).toBeNull();
    output.length = 0;
    await runOfficeStatus(baseOpts());
    expect(output.join("\n")).not.toContain("cursor:");
  });
});
