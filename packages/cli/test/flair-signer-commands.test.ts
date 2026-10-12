/**
 * cli#554 — the command-level Flair signers. `runInit` registers through
 * `registerWithFlair`, and `runDashboard`'s nested `makeAuth` signs its Agent
 * and OrgEvent reads. Each is driven against the shared verifying stub
 * (`helpers/stub-flair.ts`): the stub accepts a request signed by a caller it
 * knows and refuses one it does not, exactly as real Flair does.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatchShared } from "./helpers/patch-shared.js";
import { runInit } from "../src/commands/init.js";
import { runDashboard } from "../src/commands/roster.js";
import { ORG_EVENT_MAX_PAGES, ORG_EVENT_PAGE_SIZE } from "../src/utils/org-event-read.js";
import {
  installStubFlairFetch,
  type FlairRoutes,
  orgEventCatchupRoute,
  pubkeyFromSeed,
  startStubFlair,
  type StubFlair,
} from "./helpers/stub-flair.js";

const patchShared = createPatchShared();

const SEED = Buffer.alloc(32, 0x51);

let root: string;
let savedHome: string | undefined;
let savedAgentId: string | undefined;
let logs: string[];
let savedLog: typeof console.log;
let savedError: typeof console.error;
let savedStdout: typeof process.stdout.write;
let savedExit: typeof process.exit;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli554-signers-"));
  savedHome = process.env.HOME;
  savedAgentId = process.env.TPS_AGENT_ID;
  process.env.HOME = root;
  delete process.env.TPS_AGENT_ID;
  logs = [];
  savedLog = console.log;
  savedError = console.error;
  savedStdout = process.stdout.write;
  savedExit = process.exit;
  // A refused Agent read exits the command; here it throws, so it fails the test instead of ending the run.
  patchShared(process, "exit", ((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as typeof process.exit);
  patchShared(console, "log", ((...args: unknown[]) => { logs.push(args.join(" ")); }) as typeof console.log);
  patchShared(console, "error", ((...args: unknown[]) => { logs.push("[ERR] " + args.join(" ")); }) as typeof console.error);
  patchShared(process.stdout, "write", ((chunk: string) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write);
});

afterEach(() => {
  patchShared(console, "log", savedLog);
  patchShared(console, "error", savedError);
  patchShared(process.stdout, "write", savedStdout);
  patchShared(process, "exit", savedExit);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedAgentId === undefined) delete process.env.TPS_AGENT_ID;
  else process.env.TPS_AGENT_ID = savedAgentId;
  rmSync(root, { recursive: true, force: true });
});

/** A 32-byte seed file plus the `.pub` hex the registration body reads. */
afterEach(() => {
  mock.restore();
});

function seedKeyFile(agentId: string): void {
  const dir = join(root, ".tps", "identity");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agentId}.key`), SEED);
  writeFileSync(join(dir, `${agentId}.pub`), pubkeyFromSeed(SEED).toString("hex"));
}

describe("cli#554 — runInit registers signed with Flair", () => {
  /** The route Flair serves for the identity registration the signer posts. */
  const identityRoute = (req: Request, url: URL) =>
    req.method === "POST" && url.pathname === "/Identity" ? new Response(null, { status: 201 }) : undefined;

  test("a caller the stub knows is registered", async () => {
    const stub: StubFlair = startStubFlair({ "agent-a": SEED }, identityRoute);
    try {
      seedKeyFile("agent-a");
      await runInit({ agentId: "agent-a", flairUrl: stub.url });
      expect(logs.join("\n")).toContain("registered");
      expect(logs.join("\n")).not.toContain("skipped");
    } finally {
      stub.stop();
    }
  });

  test("a caller the stub does not know is refused and reported as skipped", async () => {
    const stub = startStubFlair({}, identityRoute);
    try {
      seedKeyFile("agent-b");
      await runInit({ agentId: "agent-b", flairUrl: stub.url });
      expect(logs.join("\n")).toContain("skipped");
      expect(logs.join("\n")).not.toContain("registered");
    } finally {
      stub.stop();
    }
  });
});

describe("cli#554 — runDashboard signs its Flair reads", () => {
  function routes(req: Request, url: URL, caller: string): Response | undefined {
    if (req.method === "GET" && url.pathname === "/Agent/") return Response.json([{ id: "ember", name: "Ember" }]);
    if (req.method === "GET" && url.pathname.startsWith("/OrgEventCatchup/")) return orgEventCatchupRoute({ events: [] })(req, url, caller);
    return undefined;
  }

  test("a signed viewer's reads are answered", async () => {
    const stub = startStubFlair({ "viewer-a": SEED }, routes);
    try {
      const keyPath = join(root, "viewer-a.key");
      writeFileSync(keyPath, SEED);
      await expect(runDashboard({ flairUrl: stub.url, agentId: "viewer-a", keyPath })).resolves.toBeUndefined();
      expect(logs.join("\n")).toContain("ember");
    } finally {
      stub.stop();
    }
  });

  test("a viewer with no key sends no Authorization and the read is refused", async () => {
    const restoreExit = patchShared(process, "exit", mock(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as typeof process.exit));
    const stub = startStubFlair({ "viewer-a": SEED }, routes);
    try {
      await expect(
        runDashboard({ flairUrl: stub.url, agentId: "viewer-a", keyPath: "/nonexistent" }),
      ).rejects.toThrow("exit:1");
      expect(logs.join("\n")).toContain(`Cannot reach Flair at ${stub.url} (HTTP 403)`);
    } finally {
      stub.stop();
      restoreExit();
    }
  });
});

/**
 * cli#606 — the dashboard's activity column reads the viewer's OrgEvent
 * catch-up feed through `readOrgEvents`. The catch-up route is
 * `orgEventCatchupRoute`, a fake modelled on Flair's coded catch-up contract
 * (see its doc; the real resource is not exercised). The fixtures name no
 * production agent.
 */
describe("cli#606 — runDashboard reads the OrgEvent catch-up feed", () => {
  const VIEWER = "viewer-a";
  const AGENTS = [{ id: "agent-a", name: "Agent A" }, { id: "agent-b", name: "Agent B" }];
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

  let stub: StubFlair | undefined;
  afterEach(() => {
    stub?.stop();
    stub = undefined;
  });

  /** Run the dashboard against a viewer whose OrgEvent read is answered by `answer`; return the output. */
  async function dashboard(answer: FlairRoutes, json = false): Promise<string> {
    const keyPath = join(root, `${VIEWER}.key`);
    writeFileSync(keyPath, SEED);
    stub = installStubFlairFetch({ [VIEWER]: SEED }, (req, url, caller) =>
      url.pathname === "/Agent/"
        ? Response.json(AGENTS)
        : url.pathname.startsWith("/OrgEventCatchup/")
          ? answer(req, url, caller)
          : undefined,
    );
    await runDashboard({ flairUrl: stub.url, agentId: VIEWER, keyPath, json });
    return logs.join("\n");
  }
  const row = (out: string, id: string) => out.split("\n").find((line) => line.startsWith(`${id} `)) ?? "";
  const jsonRows = () => JSON.parse(logs.filter((l) => !l.startsWith("[ERR] ")).join("\n")) as Array<Record<string, any>>;

  test("a nonempty read shows each agent's newest activity", async () => {
    const out = await dashboard(orgEventCatchupRoute({ events: [OLDER, NEWER] }));
    expect(out).not.toContain("Cannot read OrgEvents");
    expect(row(out, "agent-a")).toContain("5m ago");
    expect(row(out, "agent-a")).toContain("newer task");
    expect(row(out, "agent-a")).not.toContain("older task");
    expect(row(out, "agent-b")).toContain("no activity");
  });

  test("a feed of several pages is read to the end, each page after the last", async () => {
    const route = orgEventCatchupRoute({ events: [OLDER, ...rows(ORG_EVENT_PAGE_SIZE, "agent-c", 40, "f"), NEWER] });
    const out = await dashboard(route);
    expect(route.afters).toHaveLength(2);
    expect(route.afters[1]! > route.afters[0]!).toBe(true);
    expect(new Set(route.served).size).toBe(ORG_EVENT_PAGE_SIZE + 2);
    expect(out).not.toContain("incomplete");
    expect(row(out, "agent-a")).toContain("newer task");
  });

  test("a refused read (HTTP 403) is reported, and activity reads unavailable", async () => {
    const out = await dashboard(() => new Response(null, { status: 403 }));
    expect(out).toContain(`Cannot read OrgEvents from ${stub!.url} (HTTP 403); activity is unavailable.`);
    expect(row(out, "agent-a")).toContain("unavailable");
    expect(row(out, "agent-b")).toContain("unavailable");
    expect(out).not.toContain("no activity");
  });

  test("a rejected request is reported with its code, never its message", async () => {
    const out = await dashboard(() => {
      throw Object.assign(new TypeError("message-text-not-printed"), { code: "ECONNREFUSED" });
    });
    expect(out).toContain(`Cannot read OrgEvents from ${stub!.url} (request failed (ECONNREFUSED)); activity is unavailable.`);
    expect(out).not.toContain("message-text-not-printed");
    expect(row(out, "agent-a")).toContain("unavailable");
  });

  test.each([
    ["an array body", () => Response.json([NEWER]), "not an object"],
    ["an event missing a field", () => Response.json({ events: [{ ...NEWER, summary: undefined }], hasMore: false }), "an event lacks a field the command reads"],
    ["a body that is not JSON", () => new Response("not json"), "body is not JSON"],
  ])("a malformed response (%s) is reported, and activity reads unavailable", async (_label, answer, note) => {
    const out = await dashboard(answer);
    expect(out).toContain(`Cannot read OrgEvents from ${stub!.url} (malformed response (${note})); activity is unavailable.`);
    expect(out).not.toContain("newer task");
    expect(row(out, "agent-a")).toContain("unavailable");
  });

  test("a feed past the page bound is read up to the bound, with advancing cursors over distinct events, and marked incomplete", async () => {
    const route = orgEventCatchupRoute({ events: rows(PAST_BOUND, "agent-a", 60, "b") });
    const out = await dashboard(route);
    expect(route.afters).toHaveLength(ORG_EVENT_MAX_PAGES);
    for (let i = 1; i < route.afters.length; i++) expect(route.afters[i]! > route.afters[i - 1]!).toBe(true);
    expect(route.served).toHaveLength(ORG_EVENT_MAX_PAGES * ORG_EVENT_PAGE_SIZE);
    expect(new Set(route.served).size).toBe(route.served.length);
    expect(out).toContain(`OrgEvents from ${stub!.url} exceed the ${ORG_EVENT_MAX_PAGES}-page read bound; newer events were not read and activity is incomplete.`);
    expect(row(out, "agent-a")).toContain("(incomplete)");
    expect(row(out, "agent-a")).not.toContain(`b task ${PAST_BOUND - 1}`);
    expect(row(out, "agent-b")).toContain("incomplete");
    expect(out).not.toContain("no activity");
  });

  test.each([
    ["ok", () => orgEventCatchupRoute({ events: [OLDER, NEWER] }), "newer task"],
    ["unavailable", () => () => new Response(null, { status: 403 }), undefined],
    ["incomplete", () => orgEventCatchupRoute({ events: rows(PAST_BOUND, "agent-a", 60, "b") }), `b task ${PAST_BOUND - 2}`],
  ])("JSON output gives each agent the activity state %s", async (state, answer, summary) => {
    await dashboard(answer(), true);
    const out = jsonRows();
    expect(out.map((r) => r.activity)).toEqual([state, state]);
    expect(out[0]!.lastEvent?.summary).toBe(summary);
  });
});
