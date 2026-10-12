/**
 * cli#554 — `tps office status` reads Flair through the shared verifying stub
 * (`helpers/stub-flair.ts`). The stub refuses a caller without a valid
 * TPS-Ed25519 signature, so the accepted tests prove office-status signs its
 * requests, and the no-key test asserts the refusal the real server returns
 * (HTTP 403) and how office-status reports it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatchShared } from "./helpers/patch-shared.js";
import { runOfficeStatus } from "../src/commands/office-status.js";
import { installStubFlairFetch, writeKeyFile, type StubFlair } from "./helpers/stub-flair.js";

const patchShared = createPatchShared();

const SEED = Buffer.alloc(32, 0x71);

const AGENTS = [
  { id: "anvil", name: "Anvil", role: "engineer", model: "anthropic/claude-sonnet-4-6", status: "active", lastHeartbeat: new Date(Date.now() - 3 * 60_000).toISOString() },
  { id: "ember", name: "Ember", role: "implementer", status: "idle" },
];

const EVENTS = [
  { id: "e1", kind: "task.completed", authorId: "ember", summary: "Implemented ops-71", createdAt: new Date().toISOString() },
  { id: "e2", kind: "agent.heartbeat", authorId: "anvil", createdAt: new Date().toISOString() },
];

/** Flair routes the stub serves once it has verified the caller. */
function routes(req: Request, url: URL): Response | undefined {
  if (url.pathname === "/Agent/") return Response.json(AGENTS);
  if (url.pathname.startsWith("/OrgEventCatchup/")) return Response.json(EVENTS);
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
    stub = installStubFlairFetch({ anvil: SEED }, (req, url) =>
      url.pathname === "/Agent/" ? Response.json(AGENTS) : url.pathname.startsWith("/OrgEventCatchup/") ? Response.json(blocker) : undefined,
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
 * cli#620 — the recent-events read no longer swallows a refusal or a failed
 * request. The stub registers its own viewer, so the fixtures here name no
 * production agent.
 */
describe("cli#620 — office status reports a refused or failed OrgEvent read", () => {
  const VIEWER = "viewer-a";
  const AGENT = { id: "agent-a", name: "Agent A", role: "engineer", status: "active" };
  const TASK = [
    { id: "e1", kind: "task.completed", authorId: "agent-a", summary: "Shipped a change", createdAt: new Date().toISOString() },
  ];

  /** Point the shared stub at a viewer whose OrgEvent read answers with `answer`; return its key path. */
  function install(answer: (url: URL) => Response): string {
    stub.stop();
    const key = writeKeyFile(root, VIEWER, SEED);
    stub = installStubFlairFetch({ [VIEWER]: SEED }, (req, url) =>
      url.pathname === "/Agent/"
        ? Response.json([AGENT])
        : url.pathname.startsWith("/OrgEventCatchup/")
          ? answer(url)
          : undefined,
    );
    return key;
  }

  test("a refused read is reported, and the table still renders", async () => {
    const key = install(() => new Response(null, { status: 403 }));
    await runOfficeStatus({ flairUrl: stub.url, agentId: VIEWER, keyPath: key, noColor: true });
    const joined = output.join("\n");
    expect(joined).toContain(`Cannot read OrgEvents from ${stub.url} (HTTP 403); activity is incomplete.`);
    expect(joined).toContain("Agent A");
  });

  test("a failed request is reported", async () => {
    const key = install(() => { throw new TypeError("fetch failed"); });
    await runOfficeStatus({ flairUrl: stub.url, agentId: VIEWER, keyPath: key, noColor: true });
    const joined = output.join("\n");
    expect(joined).toContain(`Cannot read OrgEvents from ${stub.url}; activity is incomplete.`);
    expect(joined).toContain("Agent A");
  });

  test("an OK read is unchanged", async () => {
    const key = install(() => Response.json(TASK));
    await runOfficeStatus({ flairUrl: stub.url, agentId: VIEWER, keyPath: key, noColor: true });
    const joined = output.join("\n");
    expect(joined).toContain("Shipped a change");
    expect(joined).not.toContain("Cannot read OrgEvents");
  });
});
