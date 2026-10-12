/**
 * cli#606 — the catch-up fake (`orgEventCatchupRoute` in helpers/stub-flair.ts)
 * holds to the coded contract of Flair's `GET /OrgEventCatchup/<participant>`
 * (resources/OrgEventCatchup.ts, org-event-catchup-lib.ts and
 * agent-read-position-lib.ts): participant ownership, the `since`, target,
 * expiry and watermark filters, the requested page size, an unknown `after` used
 * as a filter, and the prior cursor returned as `nextAfter` on an empty page.
 * Each case reads through the production reader (`readOrgEvents`) or a signed
 * request against the shared verifying stub. This checks the fake against a
 * reading of Flair's code; it does not exercise a running Flair.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readOrgEvents } from "../src/utils/org-event-read.js";
import {
  type CatchupFeed,
  type CatchupRoute,
  installStubFlairFetch,
  orgEventCatchupRoute,
  requestSigner,
  type StubFlair,
} from "./helpers/stub-flair.js";

const SEEDS: Record<string, Buffer> = { "viewer-a": Buffer.alloc(32, 0x41), "viewer-b": Buffer.alloc(32, 0x42) };

let stub: StubFlair | undefined;
afterEach(() => {
  stub?.stop();
  stub = undefined;
});

/** Serve `feed` behind the verifying stub, for callers viewer-a and viewer-b. */
function serve(feed: CatchupFeed): CatchupRoute {
  const route = orgEventCatchupRoute(feed);
  stub = installStubFlairFetch(SEEDS, (req, url, caller) =>
    url.pathname.startsWith("/OrgEventCatchup/") ? route(req, url, caller) : undefined,
  );
  return route;
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const event = (id: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "note",
  authorId: "agent-x",
  summary: id,
  createdAt: at(minutesAgo),
  ...extra,
});
const position = (e: { id: string; createdAt: string }) => `${e.createdAt}\t${e.id}`;

/** Read `viewerId`'s feed over the last `sinceMinutes`, signed as `signerId`; the ids read, or the unavailable result. */
async function readIds(viewerId: string, signerId = viewerId, sinceMinutes = 60) {
  const result = await readOrgEvents({
    flairUrl: stub!.url,
    viewerId,
    since: new Date(Date.now() - sinceMinutes * 60_000),
    sign: requestSigner(signerId, SEEDS[signerId]!),
  });
  return result.status === "ok" ? result.events.map((e) => e.id) : result;
}

/** A signed GET of viewer-a's feed with `query`; the status and parsed body. */
async function getFeed(query: Record<string, string>): Promise<{ status: number; body: Record<string, any> }> {
  const search = new URLSearchParams(query).toString();
  const path = search ? `/OrgEventCatchup/viewer-a?${search}` : "/OrgEventCatchup/viewer-a";
  const res = await fetch(`${stub!.url}${path}`, {
    headers: { Authorization: requestSigner("viewer-a", SEEDS["viewer-a"]!)("GET", path) },
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("cli#606 — the catch-up fake holds to Flair's coded catch-up contract", () => {
  test("a signed non-admin request for another participant's feed is refused (HTTP 403)", async () => {
    serve({ events: [event("e1", 5)] });
    expect(await readIds("viewer-b", "viewer-a")).toEqual({ status: "unavailable", reason: "HTTP 403" });
  });

  test("an admin may read another participant's feed", async () => {
    serve({ events: [event("e1", 5)], admins: ["viewer-a"] });
    expect(await readIds("viewer-b", "viewer-a")).toEqual(["e1"]);
  });

  test("an event older than since is not served, even when it sorts after the viewer's watermark", async () => {
    const watermarks = { "viewer-a": `${at(120)}\t` };
    serve({ events: [event("old", 90), event("new", 30)], watermarks });
    expect(await readIds("viewer-a")).toEqual(["new"]);
  });

  test("an event targeted at another participant is not served; broadcast and own-targeted ones are", async () => {
    serve({
      events: [
        event("other", 40, { targetIds: ["viewer-b"] }),
        event("empty", 30, { targetIds: [] }),
        event("mine", 20, { targetIds: ["viewer-a"] }),
        event("none", 10),
      ],
    });
    expect(await readIds("viewer-a")).toEqual(["empty", "mine", "none"]);
  });

  test("an expired event is not served", async () => {
    serve({ events: [event("expired", 30, { expiresAt: at(1) }), event("live", 20, { expiresAt: at(-60) })] });
    expect(await readIds("viewer-a")).toEqual(["live"]);
  });

  test("the feed resumes after the viewer's acknowledged position, and a read leaves it", async () => {
    const seen = event("seen", 30);
    const watermarks = { "viewer-a": position(seen) };
    serve({ events: [event("before", 40), seen, event("after", 20)], watermarks });
    expect(await readIds("viewer-a")).toEqual(["after"]);
    expect(watermarks).toEqual({ "viewer-a": position(seen) });
  });

  test("pageSize is the requested page size, clamped to 1..500, and 50 by default", async () => {
    serve({ events: [1, 2, 3, 4, 5].map((n) => event(`e${n}`, 10 - n)) });
    const since = at(60);
    const two = await getFeed({ since, limit: "2" });
    expect(two.body.pageSize).toBe(2);
    expect(two.body.events.map((e: { id: string }) => e.id)).toEqual(["e1", "e2"]);
    expect(two.body.hasMore).toBe(true);
    expect((await getFeed({ since })).body.pageSize).toBe(50);
    expect((await getFeed({ since, limit: "9999" })).body.pageSize).toBe(500);
    expect((await getFeed({ since, limit: "0" })).body.pageSize).toBe(1);
  });

  test("an unknown after cursor filters the feed instead of being refused", async () => {
    serve({ events: [event("e1", 30), event("e2", 10)] });
    const res = await getFeed({ since: at(60), after: `${at(20)}\tno-such-event` });
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { id: string }) => e.id)).toEqual(["e2"]);
  });

  test("an empty page returns the prior after cursor as nextAfter", async () => {
    serve({ events: [event("e1", 30)] });
    const after = `${at(5)}\tpast-every-event`;
    const res = await getFeed({ since: at(60), after });
    expect(res.body.events).toEqual([]);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextAfter).toBe(after);
  });

  test("with no since and no watermark, a read creates the viewer's watermark 24h back and serves after it", async () => {
    const watermarks: Record<string, string> = {};
    serve({ events: [event("day-old", 25 * 60), event("recent", 10)], watermarks });
    const res = await getFeed({});
    expect(res.body.events.map((e: { id: string }) => e.id)).toEqual(["recent"]);
    expect(Object.keys(watermarks)).toEqual(["viewer-a"]);
    expect(res.body.watermark).toBe(watermarks["viewer-a"]);
  });
});
