/**
 * `tps agent logs` — OrgEvents and mail on one timeline.
 *
 * Flair is the shared verifying stub (helpers/stub-flair.ts) with its catch-up
 * route, `orgEventCatchupRoute`, a fake modelled on Flair's coded catch-up
 * contract (see its doc; the real resource is not exercised). Like Flair, it
 * refuses a non-admin caller reading another participant's feed (HTTP 403),
 * applies the `since` floor, and serves only events that are broadcast or
 * target the participant, so a test cannot pass on events Flair would not send
 * (cli#624).
 */
import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CatchupRoute,
  installStubFlairFetch,
  orgEventCatchupRoute,
  type StubFlair,
} from "./helpers/stub-flair.js";

const SEED = Buffer.alloc(32, 7);
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

afterEach(() => {
  mock.restore();
});

describe("tps agent logs", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalAgentId: string | undefined;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;
  let stub: StubFlair | undefined;
  let out: string[];
  let errors: string[];
  let keyPath: string;
  let mailDir: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tps-agent-logs-"));
    originalHome = process.env.HOME;
    originalAgentId = process.env.TPS_AGENT_ID;
    originalLog = console.log;
    originalError = console.error;
    originalExit = process.exit;

    process.env.HOME = tempHome;
    process.env.TPS_AGENT_ID = "anvil";
    mkdirSync(join(tempHome, ".tps", "identity"), { recursive: true });
    keyPath = join(tempHome, ".tps", "identity", "anvil.key");
    writeFileSync(keyPath, SEED);
    mailDir = join(tempHome, ".tps", "mail");
    out = [];
    errors = [];
    patchShared(console, "log", mock((value?: unknown) => out.push(String(value ?? ""))) as typeof console.log);
    patchShared(console, "error", mock((value?: unknown) => errors.push(String(value ?? ""))) as typeof console.error);
  });

  afterEach(() => {
    stub?.stop();
    stub = undefined;
    process.env.HOME = originalHome;
    if (originalAgentId === undefined) delete process.env.TPS_AGENT_ID;
    else process.env.TPS_AGENT_ID = originalAgentId;
    patchShared(console, "log", originalLog);
    patchShared(console, "error", originalError);
    patchShared(process, "exit", originalExit);
    rmSync(tempHome, { recursive: true, force: true });
  });

  /** Serve `events` through the verifying stub, with `anvil` the only registered caller. */
  function serveFeed(events: Array<Record<string, unknown>>): CatchupRoute {
    const catchup = orgEventCatchupRoute({ events });
    stub = installStubFlairFetch({ anvil: SEED }, (req, url, caller) =>
      url.pathname.startsWith("/OrgEventCatchup/") ? catchup(req, url, caller) : undefined,
    );
    return catchup;
  }

  /** Deliver a mail record to `agent`'s `folder`. */
  function mail(agent: string, folder: "new" | "cur", name: string, record: Record<string, unknown>): void {
    mkdirSync(join(mailDir, agent, folder), { recursive: true });
    writeFileSync(join(mailDir, agent, folder, `${name}.json`), JSON.stringify(record));
  }

  test("interleaves the viewer's own signed feed and mail, newest first", async () => {
    const catchup = serveFeed([
      { id: "e1", authorId: "anvil", kind: "task.completed", summary: "Completed ops-72", createdAt: at(50) },
      { id: "e2", authorId: "host", kind: "task.assigned", summary: "Assigned follow-up", createdAt: at(30), targetIds: ["anvil"] },
      // Flair serves neither of these to anvil: one targets another agent, one predates the 24h floor.
      { id: "e3", authorId: "host", kind: "org.note", summary: "Targeted elsewhere", createdAt: at(10), targetIds: ["someone-else"] },
      { id: "e4", authorId: "anvil", kind: "org.note", summary: "Stale event", createdAt: at(25 * 60) },
      // Served (a broadcast), but neither by nor for anvil, so the command drops it.
      { id: "e5", authorId: "host", kind: "org.note", summary: "Someone else's broadcast", createdAt: at(15) },
    ]);
    mail("anvil", "new", "latest", { id: "m1", from: "host", to: "anvil", body: "Status update\nbody", timestamp: at(20) });
    mail("anvil", "cur", "older", { id: "m2", from: "kern", to: "anvil", body: "\nNeed review", timestamp: at(40) });

    const { runAgentLogs } = await import("../src/commands/agent-logs.js");
    await runAgentLogs({ agentId: "anvil", mailDir, limit: 10, flairUrl: stub!.url, keyPath });

    expect(errors).toEqual([]);
    expect(catchup.afters).toHaveLength(1);
    expect(catchup.served.sort()).toEqual(["e1", "e2", "e5"]);
    expect(out).toHaveLength(4);
    expect(out[0]).toContain("Status update");
    expect(out[1]).toContain("Assigned follow-up");
    expect(out[2]).toContain("Need review");
    expect(out[3]).toContain("Completed ops-72");
    const joined = out.join("\n");
    for (const absent of ["Targeted elsewhere", "Stale event", "Someone else's broadcast"]) expect(joined).not.toContain(absent);
  });

  test("another agent's feed is refused (HTTP 403), as Flair refuses a non-admin cross-agent read: the command says so and shows mail only", async () => {
    const catchup = serveFeed([
      { id: "e1", authorId: "host", kind: "task.assigned", summary: "Ember's task", createdAt: at(30), targetIds: ["ember"] },
    ]);
    mail("ember", "new", "latest", { id: "m1", from: "host", to: "ember", body: "Ember mail", timestamp: at(20) });

    const { runAgentLogs } = await import("../src/commands/agent-logs.js");
    await runAgentLogs({ agentId: "ember", mailDir, limit: 10, flairUrl: stub!.url, keyPath });

    expect(errors).toEqual([`Cannot read OrgEvents from ${stub!.url} (HTTP 403); showing mail only.`]);
    expect(catchup.served).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Ember mail");
  });

  test("an unreadable key is reported as unavailable, and the mail is still shown", async () => {
    const catchup = serveFeed([
      { id: "e1", authorId: "anvil", kind: "task.completed", summary: "Completed ops-72", createdAt: at(30) },
    ]);
    mail("anvil", "new", "latest", { id: "m1", from: "host", to: "anvil", body: "Still shown", timestamp: at(20) });
    const missingKey = join(tempHome, "no-such.key");

    const { runAgentLogs } = await import("../src/commands/agent-logs.js");
    await runAgentLogs({ agentId: "anvil", mailDir, limit: 10, flairUrl: stub!.url, keyPath: missingKey });

    expect(errors).toEqual([`Cannot read OrgEvents from ${stub!.url} (request not signed (ENOENT)); showing mail only.`]);
    expect(catchup.afters).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Still shown");
  });

  test("emits json rows and fails without a viewer identity", async () => {
    const completedAt = at(30);
    const mailedAt = at(10);
    serveFeed([
      { id: "e1", authorId: "anvil", kind: "task.completed", summary: "Completed ops-72", createdAt: completedAt, targetIds: [] },
    ]);
    mail("anvil", "new", "latest", {
      id: "m1", from: "host", to: "anvil", headers: { Subject: "Direct subject" }, body: "fallback body", timestamp: mailedAt,
    });

    const { runAgentLogs } = await import("../src/commands/agent-logs.js");
    await runAgentLogs({ agentId: "anvil", mailDir, json: true, limit: 2, keyPath, flairUrl: stub!.url });
    expect(JSON.parse(out[0]!)).toEqual([
      { source: "mail", kind: "mail", summary: "Direct subject", timestamp: mailedAt },
      { source: "flair", kind: "task.completed", summary: "Completed ops-72", timestamp: completedAt },
    ]);

    patchShared(process, "exit", mock(((code?: number) => { throw new Error("exit:" + (code ?? 0)); }) as typeof process.exit));
    delete process.env.TPS_AGENT_ID;
    await expect(runAgentLogs({ agentId: "anvil" })).rejects.toThrow("exit:1");
    expect(errors.join("\n")).toContain("Invalid viewer id");
  });
});
