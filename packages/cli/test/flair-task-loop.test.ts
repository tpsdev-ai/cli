/**
 * cli#624 — the task loop and `FlairClient.getEventsSince` read Flair's
 * catch-up envelope through `readOrgEvents` (org-event-read.ts, cli#619):
 * paging with `nextAfter`, a resume cursor, a bounded unavailable read, and a
 * cursor advanced from the feed's position rather than a timestamp.
 *
 * The catch-up route is `orgEventCatchupRoute`, a fake modelled on Flair's
 * coded catch-up contract (see its doc; the real resource is not exercised).
 * Both readers run through the real FlairClient, signer and envelope reader, so
 * the signing and parsing seams are exercised; only the HTTP endpoint is faked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { SnoopLogg } from "snooplogg";
import { createFlairClient } from "../src/utils/flair-client.js";
import { startTaskLoop } from "../src/utils/flair-task-loop.js";
import {
  type CatchupFeed,
  type CatchupRoute,
  installStubFlairFetch,
  orgEventCatchupRoute,
  type StubFlair,
  writeKeyFile,
} from "./helpers/stub-flair.js";

const AGENT = "agent-a";
const AUTHOR = "agent-b";
const SEED = Buffer.alloc(32, 0x24);
const LOOKBACK = new Date(Date.now() - 6 * 3_600_000);

let stub: StubFlair | undefined;
let home: string;
let keyPath: string;
let warnings = "";
let output: Writable;
let logger: SnoopLogg;
const savedHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tps-task-loop-"));
  process.env.HOME = home;
  keyPath = writeKeyFile(join(home, ".tps", "identity"), AGENT, SEED);
  warnings = "";
  output = new Writable({ write(chunk, _encoding, done) { warnings += chunk.toString(); done(); } });
  logger = new SnoopLogg().enable("tps:flair").snoop().pipe(output, { colors: false });
});

afterEach(() => {
  logger.unsnoop().unpipe(output);
  stub?.stop();
  stub = undefined;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

/** The cursor position the loop persisted, or undefined when it wrote none. */
function cursorPosition(): string | undefined {
  try {
    return JSON.parse(readFileSync(join(home, ".tps", "cursors", `${AGENT}-task-loop.json`), "utf-8")).position;
  } catch {
    return undefined;
  }
}

/** Serve `feed` for `AGENT` through the verifying stub; return the route the requests are recorded on. */
function serveFeed(feed: CatchupFeed): CatchupRoute {
  stub?.stop();
  const catchup = orgEventCatchupRoute(feed);
  stub = installStubFlairFetch({ [AGENT]: SEED }, (req, url, caller) =>
    url.pathname.startsWith("/OrgEventCatchup/") ? catchup(req, url, caller) : undefined,
  );
  return catchup;
}

/** Serve `answer` for every catch-up request, whatever the query. */
function serveAnswer(answer: (req: Request, url: URL, caller: string) => Response): CatchupRoute {
  stub?.stop();
  const catchup = ((req: Request, url: URL, caller: string) => {
    catchup.afters.push(url.searchParams.get("after") ?? "");
    return answer(req, url, caller);
  }) as CatchupRoute;
  catchup.afters = [];
  catchup.served = [];
  stub = installStubFlairFetch({ [AGENT]: SEED }, (req, url) => url.pathname.startsWith("/OrgEventCatchup/") ? catchup(req, url, "") : undefined);
  return catchup;
}

const client = () => createFlairClient(AGENT, stub!.url, keyPath);

/** Poll `cond` until it holds or `timeoutMs` elapses; return whether it held. */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(10);
  }
  return cond();
}

const assigned = (id: string, minutesAgo: number, targetIds: string[] = [AGENT]) => ({
  id, kind: "task.assigned", authorId: AUTHOR, summary: `task ${id}`,
  createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), targetIds,
});

describe("cli#624 — FlairClient.getEventsSince reads the envelope", () => {
  test("an empty feed is ok with no events; a refused or malformed read is unavailable with a bounded reason", async () => {
    serveFeed({ events: [] });
    const empty = await client().getEventsSince(AGENT, LOOKBACK);
    expect(empty.status).toBe("ok");
    if (empty.status === "ok") expect(empty.events).toEqual([]);

    const refusals: Array<[string, (req: Request, url: URL) => Response, string]> = [
      ["400", (_req, url) => Response.json({ error: "invalid since timestamp" }, { status: 400 }), "HTTP 400"],
      ["403", (_req, url) => Response.json({ error: "forbidden: can only fetch events for yourself" }, { status: 403 }), "HTTP 403"],
      ["malformed", () => Response.json({ events: "not an array" }), "malformed response (events is not an array)"],
    ];
    for (const [name, answer, reason] of refusals) {
      serveAnswer((req, url) => answer(req, url));
      expect([name, await client().getEventsSince(AGENT, LOOKBACK)]).toEqual([name, { status: "unavailable", reason }]);
    }
  });

  test("an envelope with events is ok, carrying the events in feed order", async () => {
    const e1 = assigned("e1", 30);
    const e2 = assigned("e2", 10);
    serveFeed({ events: [e1, e2] });
    const read = await client().getEventsSince(AGENT, LOOKBACK);
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.events.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});

describe("cli#624 — the task loop reads the catch-up envelope", () => {
  test("a task.assigned event in the envelope reaches the handler", async () => {
    serveFeed({ events: [assigned("e1", 5)] });
    const handled: string[] = [];
    const loop = startTaskLoop(client(), AGENT, async (e) => { handled.push(e.id); }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => handled.length > 0);
    } finally {
      loop.stop();
    }
    expect(handled).toEqual(["e1"]);
  });

  test("the read pages across two pages, and a task event on the second page is handled", async () => {
    const base = Date.now() - 600_000;
    const events = Array.from({ length: 201 }, (_, n) => ({
      id: `e${String(n).padStart(3, "0")}`,
      kind: n === 200 ? "task.assigned" : "note",
      authorId: AUTHOR,
      summary: `event ${n}`,
      createdAt: new Date(base + n).toISOString(),
      ...(n === 200 ? { targetIds: [AGENT] } : {}),
    }));
    const catchup = serveFeed({ events });
    const handled: string[] = [];
    const loop = startTaskLoop(client(), AGENT, async (e) => { handled.push(e.id); }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => handled.length > 0);
    } finally {
      loop.stop();
    }
    expect(handled).toEqual(["e200"]);
    // Page 1 started with no resume cursor; page 2 resumed after the last event page 1 served.
    expect(catchup.afters).toHaveLength(2);
    expect(catchup.afters[0]).toBe("");
    expect(catchup.afters[1]).toBe(`${events[199]!.createdAt}\te199`);
  });

  for (const [name, answer, reason] of [
    ["an invalid since (HTTP 400)", () => Response.json({ error: "invalid since timestamp" }, { status: 400 }), "HTTP 400"],
    ["a refused read (HTTP 403)", () => Response.json({ error: "forbidden" }, { status: 403 }), "HTTP 403"],
    ["a malformed envelope", () => Response.json({ events: "not an array" }), "malformed response (events is not an array)"],
  ] as Array<[string, () => Response, string]>) {
    test(`${name} is logged with its reason and the loop retries rather than reading it as empty`, async () => {
      const catchup = serveAnswer(() => answer());
      const handled: string[] = [];
      const loop = startTaskLoop(client(), AGENT, async (e) => { handled.push(e.id); }, { pollIntervalMs: 30 });
      try {
        // More than one attempt proves the loop retried after the refusal instead of exiting.
        expect(await waitFor(() => catchup.afters.length >= 2, 3_000)).toBe(true);
      } finally {
        loop.stop();
      }
      expect(handled).toEqual([]);
      expect(cursorPosition()).toBeUndefined();
      expect(warnings).toContain(reason);
    });
  }

  test("a restart resumes from the persisted position without re-handling", async () => {
    const e1 = assigned("e1", 30);
    const catchup = serveFeed({ events: [e1] });
    const first: string[] = [];
    const loop1 = startTaskLoop(client(), AGENT, async (e) => { first.push(e.id); }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => first.length > 0);
    } finally {
      loop1.stop();
    }
    expect(first).toEqual(["e1"]);
    expect(cursorPosition()).toBe(`${e1.createdAt}\te1`);

    const second: string[] = [];
    const loop2 = startTaskLoop(client(), AGENT, async (e) => { second.push(e.id); }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => catchup.afters.length >= 2, 3_000);
      await Bun.sleep(50);
    } finally {
      loop2.stop();
    }
    expect(second).toEqual([]);
    expect(catchup.afters.at(-1)).toBe(`${e1.createdAt}\te1`);
  });
});
