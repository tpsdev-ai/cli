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
import {
  installStubFlairFetch,
  type FlairRoutes,
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
  // A refused Agent read exits the command. Here an exit throws instead of ending the run: an unexpected
  // exit fails its test, and the refusal tests expect it and assert the rejection (`rejects.toThrow`).
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
    if (req.method === "GET" && url.pathname === "/Presence") return Response.json([]);
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
 * cli#622 — the dashboard's last-seen column reads Flair's office-wide Presence
 * roster through `readPresence`. The /Presence fixture is served by the shared
 * verifying stub (see its doc); the fixture names no production agent.
 */
describe("cli#622 — runDashboard reads the Presence roster", () => {
  const VIEWER = "viewer-a";
  const AGENTS = [{ id: "agent-a", name: "Agent A" }, { id: "agent-b", name: "Agent B" }];
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

  let stub: StubFlair | undefined;
  afterEach(() => {
    stub?.stop();
    stub = undefined;
  });

  /** Run the dashboard against a viewer whose Presence read is answered by `answer`; return the output. */
  async function dashboard(answer: FlairRoutes, json = false): Promise<string> {
    const keyPath = join(root, `${VIEWER}.key`);
    writeFileSync(keyPath, SEED);
    stub = installStubFlairFetch({ [VIEWER]: SEED }, (req, url, caller) =>
      url.pathname === "/Agent/"
        ? Response.json(AGENTS)
        : url.pathname === "/Presence"
          ? answer(req, url, caller)
          : undefined,
    );
    await runDashboard({ flairUrl: stub.url, agentId: VIEWER, keyPath, json });
    return logs.join("\n");
  }
  const row = (out: string, id: string) => out.split("\n").find((line) => line.startsWith(`${id} `)) ?? "";
  const jsonRows = () => JSON.parse(logs.filter((l) => !l.startsWith("[ERR] ")).join("\n")) as Array<Record<string, any>>;

  test("shows each agent's presence status and last-seen time, and 'never seen' for an agent with no record", async () => {
    const out = await dashboard(() => Response.json([presence("agent-a", { presenceStatus: "active", lastHeartbeatAt: Date.now() - 5 * 60_000 })]));
    expect(out).not.toContain("Cannot read Presence");
    expect(out).toContain("Last Seen");
    expect(row(out, "agent-a")).toContain("active (5m ago)");
    expect(row(out, "agent-b")).toContain("never seen");
  });

  test("an agent whose record has gone stale shows the offline status and its heartbeat time", async () => {
    const out = await dashboard(() => Response.json([presence("agent-a", { presenceStatus: "offline", lastHeartbeatAt: Date.now() - 3 * 86_400_000 })]));
    expect(row(out, "agent-a")).toContain("offline (3d ago)");
    expect(row(out, "agent-b")).toContain("never seen");
  });

  test("a refused read (HTTP 403) is reported, and the column reads unavailable, not never seen", async () => {
    const out = await dashboard(() => new Response(null, { status: 403 }));
    expect(out).toContain(`Cannot read Presence from ${stub!.url} (HTTP 403); presence is unavailable.`);
    expect(row(out, "agent-a")).toContain("unavailable");
    expect(row(out, "agent-b")).toContain("unavailable");
    expect(out).not.toContain("never seen");
  });

  test("a rejected request is reported with its code, never its message", async () => {
    const out = await dashboard(() => {
      throw Object.assign(new TypeError("message-text-not-printed"), { code: "ECONNREFUSED" });
    });
    expect(out).toContain(`Cannot read Presence from ${stub!.url} (request failed (ECONNREFUSED)); presence is unavailable.`);
    expect(out).not.toContain("message-text-not-printed");
    expect(row(out, "agent-a")).toContain("unavailable");
  });

  test.each([
    ["a body that is not an array", () => Response.json({ agents: [] }), "body is not an array"],
    ["a record missing a field", () => Response.json([{ ...presence("agent-a"), lastHeartbeatAt: undefined }]), "a presence record lacks a field the command reads"],
    ["a body that is not JSON", () => new Response("not json"), "body is not JSON"],
  ])("a malformed response (%s) is reported, and the column reads unavailable", async (_label, answer, note) => {
    const out = await dashboard(answer);
    expect(out).toContain(`Cannot read Presence from ${stub!.url} (malformed response (${note})); presence is unavailable.`);
    expect(row(out, "agent-a")).toContain("unavailable");
    expect(out).not.toContain("never seen");
  });

  test("JSON output carries each agent's Presence record, last-seen text and presence state", async () => {
    await dashboard(() => Response.json([presence("agent-a", { currentTask: "reviewing agent-b PR" })]), true);
    const out = jsonRows();
    expect(out.map((r) => r.presenceState)).toEqual(["ok", "ok"]);
    expect(out[0]!.presence.id).toBe("agent-a");
    expect(out[0]!.lastSeen).toBe("active (5m ago)");
    expect(out[1]!.presence).toBeNull();
    expect(out[1]!.lastSeen).toBe("never seen");
  });
});
