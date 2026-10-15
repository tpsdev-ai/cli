/**
 * cli#622 — `readPresence` is driven against the shared
 * verifying stub (`helpers/stub-flair.ts`), whose `presenceRoute` is a fake of
 * Flair's coded `GET /Presence` contract (resources/Presence.ts): a verified
 * reader gets records derived from stored heartbeat rows, and an unverified
 * caller gets 401. A read the reader cannot sign is not sent, and a refused or
 * rejected request, or a roster the reader does not accept (see its module
 * doc), returns the bounded `unavailable`. Cross-field cases cover stale
 * task/activity (a stale record with a current task or non-idle activity),
 * fresh activity equality (fresh activity differing from lastActivity), and
 * offline freshness (an offline record with fresh activity). Other combinations
 * are not checked, including status versus a future heartbeat.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readPresence } from "../src/utils/presence-read.js";
import {
  type FlairRoutes,
  installStubFlairFetch,
  type PresenceRow,
  presenceRecords,
  presenceRoute,
  requestSigner,
  type StubFlair,
  stubFlairHandler,
} from "./helpers/stub-flair.js";

const VIEWER = "viewer-a";
const SEED = Buffer.alloc(32, 0x3c);
const STRANGER_SEED = Buffer.alloc(32, 0x3d);

/** A stored Presence row: `id`'s last heartbeat `minutesAgo` minutes ago, asserting `coding`. */
const beat = (id: string, minutesAgo: number, over: Partial<PresenceRow> = {}): PresenceRow => ({
  agentId: id, lastHeartbeatAt: Date.now() - minutesAgo * 60_000, activity: "coding", ...over,
});
const ROWS = [beat("agent-a", 0.5, { currentTask: "reviewing a PR" }), beat("agent-b", 5)];

let stub: StubFlair | undefined;
let presenceRequests = 0;
afterEach(() => {
  stub?.stop();
  stub = undefined;
});

/**
 * Serve `answer` for /Presence to the registered viewer from a stub Flair HTTP
 * server, counting the Presence requests that reach it.
 */
function serve(answer: FlairRoutes): StubFlair {
  presenceRequests = 0;
  const handler = stubFlairHandler({ [VIEWER]: SEED }, answer);
  const server = Bun.serve({
    port: 0,
    fetch: (req: Request) => {
      if (new URL(req.url).pathname === "/Presence") presenceRequests++;
      return handler(req);
    },
  });
  stub = { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  return stub;
}

describe("cli#622 — readPresence", () => {
  test("a verified read returns one record per stored local Presence row, keyed by agent, holding only the validated fields", async () => {
    const { url } = serve(presenceRoute(ROWS));
    const read = await readPresence({ flairUrl: url, sign: requestSigner(VIEWER, SEED) });
    if (read.status !== "ok") throw new Error(`expected ok, got ${read.reason}`);
    expect(read.agents.map((a) => [a.id, a.presenceStatus, a.currentTask])).toEqual([
      ["agent-a", "active", "reviewing a PR"],
      ["agent-b", "idle", null],
    ]);
    for (const agent of read.agents) {
      expect(Object.keys(agent).sort()).toEqual(
        ["activity", "activityFresh", "currentTask", "id", "lastActivity", "lastHeartbeatAt", "presenceStatus"],
      );
    }
  });

  test.each([
    ["short", "  reviewing a PR  ", "reviewing a PR"],
    ["at the cap", "  " + "x".repeat(200) + "tail  ", "x".repeat(200)],
    ["ending in a space", "  " + "x".repeat(199) + " tail  ", "x".repeat(199) + " "],
    ["ending in whitespace", "  " + "x".repeat(198) + " \ttail  ", "x".repeat(198) + " \t"],
  ])("accepts Flair's trim-then-slice task output %s", async (_label, input, expected) => {
    stub = installStubFlairFetch({ [VIEWER]: SEED }, presenceRoute([beat("agent-a", 0.5, { currentTask: input })]));
    const read = await readPresence({ flairUrl: stub.url, sign: requestSigner(VIEWER, SEED) });
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.agents[0]!.currentTask).toBe(expected);
  });

  test("accepts a lowercase TPS-Ed25519 scheme with a valid signature", async () => {
    stub = installStubFlairFetch({ [VIEWER]: SEED }, presenceRoute(ROWS));
    const signer = requestSigner(VIEWER, SEED);
    const read = await readPresence({ flairUrl: stub.url, sign: (method, path) => signer(method, path).replace("TPS-Ed25519", "tps-ed25519") });
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.agents).toHaveLength(ROWS.length);
  });

  test.each([
    ["with a code", () => { throw Object.assign(new Error("signer-message-not-printed"), { code: "EACCES" }); }, "EACCES"],
    ["with only a class", () => { throw new RangeError("signer-message-not-printed"); }, "RangeError"],
    ["a non-error value", () => { throw "signer-message-not-printed"; }, "unknown error"],
  ])("a signer that throws (%s) reads unavailable by its code or class, never its message, and sends no request", async (_label, sign, tag) => {
    const { url } = serve(presenceRoute(ROWS));
    const read = await readPresence({ flairUrl: url, sign });
    expect(read).toEqual({ status: "unavailable", reason: `signing failed (${tag})` });
    expect(JSON.stringify(read)).not.toContain("signer-message-not-printed");
    expect(presenceRequests).toBe(0);
  });

  test("a signer that returns no signature reads unavailable and sends no unsigned request", async () => {
    const { url } = serve(presenceRoute(ROWS));
    const read = await readPresence({ flairUrl: url, sign: () => undefined });
    expect(read).toEqual({ status: "unavailable", reason: "not signed (no request sent)" });
    expect(presenceRequests).toBe(0);
  });

  test.each([
    ["a read signed by an agent not registered on the instance", requestSigner("stranger", STRANGER_SEED)],
    ["a read whose TPS-Ed25519 header is malformed", () => "TPS-Ed25519 not-a-credential"],
  ])("%s gets Flair's 401 and reads unavailable", async (_label, sign) => {
    const { url } = serve(presenceRoute(ROWS));
    const read = await readPresence({ flairUrl: url, sign });
    expect(read).toEqual({ status: "unavailable", reason: "HTTP 401" });
    expect(presenceRequests).toBe(1);
  });

  /** Flair's records for ROWS with `over` applied to the record at `index`. */
  const corrupt = (index: number, over: Record<string, unknown>): FlairRoutes => () =>
    Response.json(presenceRecords(ROWS).map((r, i) => (i === index ? { ...r, ...over } : r)));
  const invalid = (field: string) => `malformed response (a presence record has a missing or invalid ${field})`;

  test.each([
    ["an entry that is not an object", () => Response.json([null, ...presenceRecords(ROWS)]), "malformed response (an entry is not an object)"],
    ["an empty id", corrupt(0, { id: "" }), invalid("id")],
    ["an id that is not a string", corrupt(0, { id: 7 }), invalid("id")],
    ["a status outside Flair's vocabulary", corrupt(0, { presenceStatus: "busy" }), invalid("presenceStatus")],
    ["a missing status", corrupt(0, { presenceStatus: undefined }), invalid("presenceStatus")],
    ["a heartbeat time that is not a number", corrupt(0, { lastHeartbeatAt: "1700000000000" }), invalid("lastHeartbeatAt")],
    ["a missing heartbeat time", corrupt(0, { lastHeartbeatAt: null }), invalid("lastHeartbeatAt")],
    ["an activity outside Flair's vocabulary", corrupt(0, { activity: "sleeping" }), invalid("activity")],
    ["a missing activity", corrupt(0, { activity: undefined }), invalid("activity")],
    ["a last activity outside Flair's vocabulary", corrupt(0, { lastActivity: "sleeping" }), invalid("lastActivity")],
    ["a missing last activity", corrupt(0, { lastActivity: undefined }), invalid("lastActivity")],
    ["an activityFresh that is not a boolean", corrupt(0, { activityFresh: "true" }), invalid("activityFresh")],
    ["a missing activityFresh", corrupt(0, { activityFresh: undefined }), invalid("activityFresh")],
    ["a current task that is not a string", corrupt(0, { currentTask: 42 }), invalid("currentTask")],
    ["an empty current task", corrupt(0, { currentTask: "" }), invalid("currentTask")],
    ["a current task over Flair's 200-character cap", corrupt(0, { currentTask: "x".repeat(201) }), invalid("currentTask")],
    ["a current task of only whitespace", corrupt(0, { currentTask: "   " }), invalid("currentTask")],
    ["a current task with leading whitespace", corrupt(0, { currentTask: " reviewing a PR" }), invalid("currentTask")],
    ["a short current task with trailing whitespace", corrupt(0, { currentTask: "reviewing a PR " }), invalid("currentTask")],
    ["a capped current task with leading whitespace", corrupt(0, { currentTask: " " + "x".repeat(199) }), invalid("currentTask")],
    ["a capped current task of only whitespace", corrupt(0, { currentTask: " ".repeat(200) }), invalid("currentTask")],
    ["a missing current task", corrupt(0, { currentTask: undefined }), invalid("currentTask")],
    ["a valid first record and an invalid second", corrupt(1, { presenceStatus: "busy" }), invalid("presenceStatus")],
    ["a stale record with a current task", corrupt(0, { activityFresh: false }), "malformed response (a stale presence record carries a current task or an activity other than idle)"],
    ["a stale record whose activity is not idle", corrupt(1, { activityFresh: false }), "malformed response (a stale presence record carries a current task or an activity other than idle)"],
    ["a fresh record whose activity differs from its last activity", corrupt(0, { lastActivity: "planning" }), "malformed response (a fresh presence record's activity differs from its last activity)"],
    ["an offline record with fresh activity", corrupt(1, { presenceStatus: "offline" }), "malformed response (an offline presence record reports fresh activity)"],
    ["two records for one agent", () => Response.json([...presenceRecords(ROWS), presenceRecords(ROWS)[0]]), "malformed response (two presence records share an id)"],
  ])("a roster with %s reads unavailable as a whole", async (_label, answer, reason) => {
    const { url } = serve(answer);
    const read = await readPresence({ flairUrl: url, sign: requestSigner(VIEWER, SEED) });
    expect(read).toEqual({ status: "unavailable", reason });
  });
});

/**
 * The fake's refusals, against Flair's coded responses: an anonymous reader of
 * `GET /Presence` gets Presence.get()'s 401 (resources/Presence.ts, flair#1880),
 * and a malformed TPS-Ed25519 header gets the auth middleware's 401
 * (resources/auth-middleware.ts).
 */
describe("cli#622 — the Presence fake refuses as Flair does", () => {
  test.each([
    ["no Authorization header", undefined, "authentication required"],
    ["another scheme", "Bearer not-a-credential", "authentication required"],
    ["a malformed TPS-Ed25519 header", "TPS-Ed25519 not-a-credential", "invalid_authorization_header"],
  ])("a GET /Presence with %s gets 401", async (_label, header, error) => {
    const { url } = serve(presenceRoute(ROWS));
    const res = await fetch(`${url}/Presence`, header === undefined ? {} : { headers: { Authorization: header } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error });
  });
});
