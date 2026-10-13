/**
 * cli#554 — `tps office status` reads Flair through the shared verifying stub
 * (`helpers/stub-flair.ts`). The stub refuses a caller without a valid
 * TPS-Ed25519 signature, so the accepted tests prove office-status signs its
 * requests, and the no-key test asserts the refusal the real server returns
 * (HTTP 403) and how office-status reports it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatchShared } from "./helpers/patch-shared.js";
import { runOfficeStatus } from "../src/commands/office-status.js";
import {
  type FlairRoutes,
  installStubFlairFetch,
  writeKeyFile,
  type StubFlair,
} from "./helpers/stub-flair.js";

const patchShared = createPatchShared();

const SEED = Buffer.alloc(32, 0x71);

const AGENTS = [
  { id: "agent-a", name: "Agent A", role: "engineer", model: "vendor/model-a", status: "active" },
  { id: "agent-b", name: "Agent B", role: "implementer", status: "idle" },
];

/** A Presence record for `id`, 5 minutes stale by default. */
const presence = (id: string, over: Record<string, unknown> = {}) => ({
  id, displayName: id, role: "agent", runtime: "cli",
  activity: "coding", lastActivity: "coding",
  activityUpdatedAt: Date.now() - 5 * 60_000, activityAgeMs: 5 * 60_000, activityFresh: true,
  presenceStatus: "active", currentTask: null,
  lastHeartbeatAt: Date.now() - 5 * 60_000,
  flairVersion: "1.2.3", harperVersion: "4.5.6",
  ...over,
});

/** Flair routes the stub serves once it has verified the caller. */
function routes(req: Request, url: URL, caller: string): Response | undefined {
  if (url.pathname === "/Agent/") return Response.json(AGENTS);
  if (url.pathname === "/Presence") return Response.json([presence("agent-a", { currentTask: "reviewing a PR" })]);
  return undefined;
}

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

  test("shows each agent's last-seen presence and current activity", async () => {
    await runOfficeStatus(baseOpts());
    const joined = output.join("\n");
    expect(joined).toContain("reviewing a PR");
    expect(joined).toContain("active (5m ago)");
    expect(joined).toContain("never seen");
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
 * cli#622 — office status reads Flair's office-wide Presence roster through
 * `readPresence`. The /Presence fixture is served by the shared verifying stub
 * (see its doc); the fixture names no production agent.
 */
describe("cli#622 — office status reads the Presence roster", () => {
  const VIEWER = "viewer-a";
  const AGENT_LIST = [
    { id: "agent-a", name: "Agent A", role: "engineer", status: "active" },
    { id: "agent-b", name: "Agent B", role: "reviewer", status: "active" },
  ];

  /** Run office status against a viewer whose Presence read is answered by `answer`; return the output. */
  async function status(answer: FlairRoutes, json = false): Promise<string> {
    stub.stop();
    output.length = 0;
    const key = writeKeyFile(root, VIEWER, SEED);
    stub = installStubFlairFetch({ [VIEWER]: SEED }, (req, url, caller) =>
      url.pathname === "/Agent/"
        ? Response.json(AGENT_LIST)
        : url.pathname === "/Presence"
          ? answer(req, url, caller)
          : undefined,
    );
    await runOfficeStatus({ flairUrl: stub.url, agentId: VIEWER, keyPath: key, noColor: true, json });
    return output.join("\n");
  }
  const row = (out: string, name: string) => out.split("\n").find((line) => line.includes(` ${name} `)) ?? "";
  const jsonAgents = () =>
    (JSON.parse(output.filter((l) => !l.startsWith("[ERR] ")).join("\n")) as { agents: Array<Record<string, any>> }).agents;

  test("shows each agent's last-seen presence and current activity, and 'never seen' for an agent with no record", async () => {
    const out = await status(() => Response.json([presence("agent-a", { presenceStatus: "active", lastHeartbeatAt: Date.now() - 3 * 60_000, currentTask: "reviewing a PR" })]));
    expect(out).not.toContain("Cannot read Presence");
    expect(out).toContain("LAST SEEN");
    expect(row(out, "Agent A")).toContain("active (3m ago)");
    expect(row(out, "Agent A")).toContain("reviewing a PR");
    expect(row(out, "Agent B")).toContain("never seen");
  });

  test("a stale record shows the offline status and its last-known activity", async () => {
    const out = await status(() => Response.json([presence("agent-a", { presenceStatus: "offline", activityFresh: false, currentTask: null, lastActivity: "debugging", lastHeartbeatAt: Date.now() - 3 * 86_400_000 })]));
    expect(row(out, "Agent A")).toContain("offline (3d ago)");
    expect(row(out, "Agent A")).toContain("was: debugging");
  });

  test("a refused read (HTTP 403) is reported, and the columns read unavailable, not never seen", async () => {
    const out = await status(() => new Response(null, { status: 403 }));
    expect(out).toContain(`Cannot read Presence from ${stub.url} (HTTP 403); presence is unavailable.`);
    expect(row(out, "Agent A")).toContain("unavailable");
    expect(row(out, "Agent B")).toContain("unavailable");
    expect(out).not.toContain("never seen");
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
    ["a record missing a field", () => Response.json([{ ...presence("agent-a"), presenceStatus: undefined }]), "a presence record lacks a field the command reads"],
    ["a body that is not JSON", () => new Response("not json"), "body is not JSON"],
  ])("a malformed response (%s) is reported, and the columns read unavailable", async (_label, answer, note) => {
    const out = await status(answer);
    expect(out).toContain(`Cannot read Presence from ${stub.url} (malformed response (${note})); presence is unavailable.`);
    expect(row(out, "Agent A")).toContain("unavailable");
    expect(out).not.toContain("never seen");
  });

  test("JSON output carries each agent's Presence record, last-seen text and presence state", async () => {
    await status(() => Response.json([presence("agent-a", { currentTask: "reviewing a PR" })]), true);
    const agents = jsonAgents();
    expect(agents.map((a) => a.presenceState)).toEqual(["ok", "ok"]);
    expect(agents[0]!.presence.id).toBe("agent-a");
    expect(agents[0]!.lastSeen).toBe("active (5m ago)");
    expect(agents[0]!.doing).toBe("reviewing a PR");
    expect(agents[1]!.presence).toBeNull();
    expect(agents[1]!.lastSeen).toBe("never seen");
  });
});
