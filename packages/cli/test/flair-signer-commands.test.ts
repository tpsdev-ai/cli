/**
 * cli#554 — the command-level Flair signers. `runInit` registers through
 * `registerWithFlair`, and `runDashboard`'s nested `makeAuth` signs its Agent
 * and Presence reads. Each is driven against the shared verifying stub
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
  type PresenceRow,
  presenceRecords,
  presenceRoute,
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
 * cli#622 — the dashboard's last-seen column reads the queried Flair instance's
 * Presence roster through `readPresence`. `/Presence` is served by
 * `presenceRoute`, the shared stub's fake of Flair's coded contract: it derives
 * each record's status from stored heartbeat rows as resources/Presence.ts
 * does, and the stub refuses an unsigned read with Flair's 401 (see their
 * docs). The fixtures name no production agent.
 */
describe("cli#622 — runDashboard reads the Presence roster", () => {
  const VIEWER = "viewer-a";
  const AGENTS = [{ id: "agent-a", name: "Agent A" }, { id: "agent-b", name: "Agent B" }];
  /** A stored Presence row: `id`'s last heartbeat `minutesAgo` minutes ago, asserting `coding`. */
  const beat = (id: string, minutesAgo: number, over: Partial<PresenceRow> = {}): PresenceRow => ({
    agentId: id, lastHeartbeatAt: Date.now() - minutesAgo * 60_000, activity: "coding", ...over,
  });

  let stub: StubFlair | undefined;
  afterEach(() => {
    stub?.stop();
    stub = undefined;
  });

  /**
   * Run the dashboard against a viewer whose Presence read is answered by
   * `answer`; return the output. `afterAgentRead` runs once the Agent list has
   * been answered, before the Presence read.
   */
  async function dashboard(answer: FlairRoutes, opts: { json?: boolean; afterAgentRead?: (keyPath: string) => void } = {}): Promise<string> {
    const keyPath = join(root, `${VIEWER}.key`);
    writeFileSync(keyPath, SEED);
    stub = installStubFlairFetch({ [VIEWER]: SEED }, (req, url, caller) => {
      if (url.pathname === "/Agent/") {
        opts.afterAgentRead?.(keyPath);
        return Response.json(AGENTS);
      }
      return url.pathname === "/Presence" ? answer(req, url, caller) : undefined;
    });
    await runDashboard({ flairUrl: stub.url, agentId: VIEWER, keyPath, json: opts.json });
    return logs.join("\n");
  }
  const row = (out: string, id: string) => out.split("\n").find((line) => line.startsWith(`${id} `)) ?? "";
  const jsonRows = () => JSON.parse(logs.filter((l) => !l.startsWith("[ERR] ")).join("\n")) as Array<Record<string, any>>;

  test.each([
    ["under Flair's idle threshold", 0.5, "active (just now)"],
    ["past Flair's idle threshold", 5, "idle (5m ago)"],
    ["past Flair's offline threshold", 3 * 1440, "offline (3d ago)"],
  ])("a heartbeat %s shows the status Flair derives and its age; an agent with no record here reads 'no presence on this instance'", async (_label, minutesAgo, shown) => {
    const out = await dashboard(presenceRoute([beat("agent-a", minutesAgo)]));
    expect(out).not.toContain("Cannot read Presence");
    expect(out).toContain("Last Seen");
    expect(row(out, "agent-a")).toContain(shown);
    expect(row(out, "agent-b")).toContain("no presence on this instance");
    expect(out).not.toContain("never seen");
  });

  test("a Presence read signed with a key Flair does not hold for the viewer gets Flair's 401, is reported, and the column reads unavailable", async () => {
    const out = await dashboard(presenceRoute([beat("agent-a", 0.5)]), { afterAgentRead: (keyPath) => writeFileSync(keyPath, Buffer.alloc(32, 0x52)) });
    expect(out).toContain(`Cannot read Presence from ${stub!.url} (HTTP 401); presence is unavailable.`);
    expect(row(out, "agent-a")).toContain("unavailable");
    expect(row(out, "agent-b")).toContain("unavailable");
    expect(out).not.toContain("no presence on this instance");
  });

  test("a Presence read the command cannot sign is not sent, is reported, and the column reads unavailable", async () => {
    const out = await dashboard(presenceRoute([beat("agent-a", 0.5)]), { afterAgentRead: (keyPath) => rmSync(keyPath) });
    expect(out).toContain(`Cannot read Presence from ${stub!.url} (not signed (no request sent)); presence is unavailable.`);
    expect(row(out, "agent-a")).toContain("unavailable");
    expect(row(out, "agent-b")).toContain("unavailable");
    expect(out).not.toContain("no presence on this instance");
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
    ["a record missing lastHeartbeatAt", () => Response.json(presenceRecords([beat("agent-a", 0.5)]).map((r) => ({ ...r, lastHeartbeatAt: undefined }))), "a presence record has a missing or invalid lastHeartbeatAt"],
    ["a status outside Flair's vocabulary", () => Response.json(presenceRecords([beat("agent-a", 0.5)]).map((r) => ({ ...r, presenceStatus: "busy" }))), "a presence record has a missing or invalid presenceStatus"],
    ["two records for one agent", () => Response.json(presenceRecords([beat("agent-a", 0.5), beat("agent-a", 5)])), "two presence records share an id"],
    ["a body that is not JSON", () => new Response("not json"), "body is not JSON"],
  ])("a malformed response (%s) is reported, and the column reads unavailable", async (_label, answer, note) => {
    const out = await dashboard(answer);
    expect(out).toContain(`Cannot read Presence from ${stub!.url} (malformed response (${note})); presence is unavailable.`);
    expect(row(out, "agent-a")).toContain("unavailable");
    expect(out).not.toContain("busy");
    expect(out).not.toContain("no presence on this instance");
  });

  test("JSON output carries each agent's validated Presence fields, last-seen text and presence state", async () => {
    await dashboard(presenceRoute([beat("agent-a", 5, { currentTask: "reviewing agent-b PR" })]), { json: true });
    const out = jsonRows();
    expect(out.map((r) => r.presenceState)).toEqual(["ok", "ok"]);
    expect(out[0]!.presence.id).toBe("agent-a");
    expect(out[0]!.presence.currentTask).toBe("reviewing agent-b PR");
    expect(out[0]!.lastSeen).toBe("idle (5m ago)");
    expect(out[1]!.presence).toBeNull();
    expect(out[1]!.lastSeen).toBe("no presence on this instance");
  });
});
