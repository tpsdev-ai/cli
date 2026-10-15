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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { SnoopLogg } from "snooplogg";
import { createFlairClient, type FlairClient } from "../src/utils/flair-client.js";
import { InvalidLoopIdError, MAX_POSITION_SKEW_MS, startTaskLoop } from "../src/utils/flair-task-loop.js";
import { createPatchShared } from "./helpers/patch-shared.js";
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
const patchShared = createPatchShared();

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

/** The task loop's cursor file under the test HOME. */
const cursorFile = () => join(home, ".tps", "cursors", `${AGENT}-task-loop.json`);

/** The cursor position the loop persisted, or undefined when it wrote none. */
function cursorPosition(): string | undefined {
  try {
    return JSON.parse(readFileSync(cursorFile(), "utf-8")).position;
  } catch {
    return undefined;
  }
}

/** Write the cursor file with `content` (an object is written as JSON). */
function writeCursor(content: string | Record<string, unknown>): void {
  mkdirSync(join(home, ".tps", "cursors"), { recursive: true });
  writeFileSync(cursorFile(), typeof content === "string" ? content : JSON.stringify(content));
}

/** The feed position Flair gives an event: `<createdAt>\t<id>`. */
const positionOf = (e: { createdAt: string; id: string }) => `${e.createdAt}\t${e.id}`;

/** `e` as Flair serves it, carrying its position. */
const served = <E extends { createdAt: string; id: string }>(e: E) => ({ ...e, position: positionOf(e) });

/** Whether `position` is an initial position: just before an instant about an hour before `nowMs`. */
function isInitialPosition(position: string | undefined, nowMs = Date.now()): boolean {
  if (!position?.endsWith("\t")) return false;
  const ms = Date.parse(position.slice(0, -1));
  return Math.abs(nowMs - 3_600_000 - ms) < 60_000;
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

/**
 * Poll `cond` until it holds or `timeoutMs` elapses; return whether it held. The
 * default stays under bun's 5 s test timeout, so a failing test still stops its
 * loop in `finally`. (performance.now: a test may move Date.now.)
 */
async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(10);
  }
  return cond();
}

const assigned = (id: string, minutesAgo: number, targetIds: string[] = [AGENT]) => ({
  id, kind: "task.assigned", authorId: AUTHOR, summary: `task ${id}`,
  createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), targetIds,
});
type Ev = ReturnType<typeof assigned> & { position: string };

/** `res` with a `Date` header giving `at` (to the second, as HTTP dates are). */
function withDate(res: Response, at: Date): Response {
  const headers = new Headers(res.headers);
  headers.set("Date", at.toUTCString());
  return new Response(res.body, { status: res.status, headers });
}

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

  test("a signing failure and an invalid since are unavailable with a bounded reason, never thrown, and send no request", async () => {
    const catchup = serveFeed({ events: [assigned("e1", 5)] });
    const missingKey = join(home, "no-such.key");
    const unsigned = await createFlairClient(AGENT, stub!.url, missingKey).getEventsSince(AGENT, LOOKBACK);
    expect(unsigned).toEqual({ status: "unavailable", reason: "request not signed (ENOENT)" });
    // The reason names the error's code, never its message (which names the key path).
    expect(JSON.stringify(unsigned)).not.toContain(missingKey);

    const garbled = join(home, "garbled.key");
    writeFileSync(garbled, "not a key");
    const badKey = await createFlairClient(AGENT, stub!.url, garbled).getEventsSince(AGENT, LOOKBACK);
    expect(badKey.status).toBe("unavailable");
    if (badKey.status === "unavailable") expect(badKey.reason).toMatch(/^request not signed \([A-Za-z][A-Za-z0-9_]*\)$/);

    expect(await client().getEventsSince(AGENT, new Date("not a date"))).toEqual({
      status: "unavailable",
      reason: "invalid since (not a valid date)",
    });
    expect(catchup.afters).toEqual([]);
  });

  test.each([
    ["a missing id", { id: undefined }],
    ["a non-string id", { id: 42 }],
    ["an empty id", { id: "" }],
    ["targetIds that is a string", { targetIds: AGENT }],
    ["targetIds holding a non-string", { targetIds: [AGENT, 7] }],
    ["a non-string detail", { detail: { text: "x" } }],
  ])("a page with an event with %s is unavailable (malformed), not ok", async (_label, change) => {
    // Otherwise well-formed: the event carries its position, and nextAfter is that position.
    const e1 = served(assigned("e1", 5));
    serveAnswer(() => Response.json({ events: [{ ...e1, ...change }], hasMore: false, nextAfter: e1.position }));
    expect(await client().getEventsSince(AGENT, LOOKBACK)).toEqual({
      status: "unavailable",
      reason: "malformed response (an event lacks a field the command reads)",
    });
  });

  test.each([
    ["a terminal page with no nextAfter", (e1: Ev, _e2: Ev) => ({ events: [e1], hasMore: false }), "nextAfter is missing"],
    ["an empty terminal page with no nextAfter", () => ({ events: [], hasMore: false }), "nextAfter is missing"],
    ["an event with no position", (e1: Ev) => ({ events: [{ ...e1, position: undefined }], hasMore: false, nextAfter: e1.position }), "an event lacks a field the command reads"],
    ["a position that is not the event's createdAt and id", (e1: Ev) => ({ events: [{ ...e1, position: `${e1.createdAt}\tother` }], hasMore: false, nextAfter: `${e1.createdAt}\tother` }), "an event's position is not its createdAt and id"],
    ["events out of order", (e1: Ev, e2: Ev) => ({ events: [e2, e1], hasMore: false, nextAfter: e1.position }), "events are not in position order after the cursor"],
    ["a repeated event", (e1: Ev) => ({ events: [e1, e1], hasMore: false, nextAfter: e1.position }), "events are not in position order after the cursor"],
    ["an event at or before the request's cursor", (_e1: Ev, _e2: Ev, before: Ev) => ({ events: [before], hasMore: false, nextAfter: before.position }), "events are not in position order after the cursor"],
    ["a nextAfter past the last event", (e1: Ev, e2: Ev) => ({ events: [e1], hasMore: false, nextAfter: e2.position }), "nextAfter is not the last event's position"],
    ["a nextAfter before the last event", (e1: Ev, e2: Ev) => ({ events: [e1, e2], hasMore: true, nextAfter: e1.position }), "nextAfter is not the last event's position"],
    ["an empty page whose nextAfter moves the cursor forward", (_e1: Ev, e2: Ev) => ({ events: [], hasMore: false, nextAfter: e2.position }), "nextAfter of an empty page is not the request's cursor"],
    ["an empty page whose nextAfter moves the cursor back", (_e1: Ev, _e2: Ev, before: Ev) => ({ events: [], hasMore: false, nextAfter: `${before.createdAt}\t` }), "nextAfter of an empty page is not the request's cursor"],
  ] as Array<[string, (e1: Ev, e2: Ev, before: Ev) => Record<string, unknown>, string]>)(
    "a page with %s is unavailable (malformed), not ok",
    async (_label, page, note) => {
      const [before, e1, e2] = [served(assigned("before", 30)), served(assigned("e1", 20)), served(assigned("e2", 10))];
      serveAnswer(() => Response.json(page(e1, e2, before)));
      // The read resumes after `before`, as the task loop always sends its position.
      expect(await client().getEventsSince(AGENT, LOOKBACK, before.position)).toEqual({
        status: "unavailable",
        reason: `malformed response (${note})`,
      });
    },
  );

  test("a well-formed page reports the server's time from the response's Date header", async () => {
    const catchup = orgEventCatchupRoute({ events: [assigned("e1", 5)] });
    const serverTime = new Date(Date.now() + 3 * 3_600_000);
    serveAnswer((req, url) => withDate(catchup(req, url, AGENT), serverTime));
    const read = await client().getEventsSince(AGENT, LOOKBACK);
    expect(read.status === "ok" && read.serverTime).toBe(new Date(Math.floor(serverTime.getTime() / 1000) * 1000).toISOString());
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
      await loop.stop();
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
      await loop.stop();
    }
    expect(handled).toEqual(["e200"]);
    // Page 1 started at the initial position; page 2 resumed after the last event page 1 served.
    expect(catchup.afters).toHaveLength(2);
    expect(isInitialPosition(catchup.afters[0])).toBe(true);
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
        await loop.stop();
      }
      expect(handled).toEqual([]);
      // Every attempt sent the initial position, which stays the persisted cursor.
      expect(isInitialPosition(catchup.afters[0])).toBe(true);
      expect(new Set(catchup.afters).size).toBe(1);
      expect(cursorPosition()).toBe(catchup.afters[0]);
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
      await loop1.stop();
    }
    expect(first).toEqual(["e1"]);
    expect(cursorPosition()).toBe(`${e1.createdAt}\te1`);

    const second: string[] = [];
    const loop2 = startTaskLoop(client(), AGENT, async (e) => { second.push(e.id); }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => catchup.afters.length >= 2, 3_000);
      await Bun.sleep(50);
    } finally {
      await loop2.stop();
    }
    expect(second).toEqual([]);
    expect(catchup.afters.at(-1)).toBe(`${e1.createdAt}\te1`);
  });

  test("a handler failure leaves the event eligible: the same process retries it before any later event, and the cursor never passes it", async () => {
    const [e0, e1, e2] = [assigned("e0", 30), assigned("e1", 20), assigned("e2", 10)];
    const catchup = serveFeed({ events: [e0, e1, e2] });
    const calls: string[] = [];
    let cursorAtRetry: string | undefined;
    let failedOnce = false;
    const loop = startTaskLoop(client(), AGENT, async (e) => {
      calls.push(e.id);
      if (e.id !== "e1") return;
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("transient failure");
      }
      cursorAtRetry = cursorPosition();
    }, { pollIntervalMs: 30 });
    try {
      await waitFor(() => calls.includes("e2"));
    } finally {
      await loop.stop();
    }
    // e1 failed, then was handled again before e2 was handled at all.
    expect(calls).toEqual(["e0", "e1", "e1", "e2"]);
    // The read after the failure resumed after e0, the last event done before it;
    // when e1 was retried, the persisted cursor had not passed it.
    expect(catchup.afters[1]).toBe(positionOf(e0));
    expect(cursorAtRetry).toBe(positionOf(e0));
    expect(cursorPosition()).toBe(positionOf(e2));
    expect(warnings).toContain("Task handler error for e1: transient failure");
  });

  test("after a handler failure, a restart retries the failed event: the persisted cursor stops before it", async () => {
    const [e0, e1, e2] = [assigned("e0", 30), assigned("e1", 20), assigned("e2", 10)];
    const catchup = serveFeed({ events: [e0, e1, e2] });
    const first: string[] = [];
    const loop1 = startTaskLoop(client(), AGENT, async (e) => {
      first.push(e.id);
      if (e.id === "e1") throw new Error("handler down");
    }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => first.includes("e1"));
      await Bun.sleep(50);
    } finally {
      await loop1.stop();
    }
    expect(first).toEqual(["e0", "e1"]);
    expect(cursorPosition()).toBe(positionOf(e0));

    const second: string[] = [];
    const loop2 = startTaskLoop(client(), AGENT, async (e) => { second.push(e.id); }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => second.length >= 2);
    } finally {
      await loop2.stop();
    }
    expect(second).toEqual(["e1", "e2"]);
    expect(catchup.afters.at(-1)).toBe(positionOf(e0));
    expect(cursorPosition()).toBe(positionOf(e2));
  });

  test("a page whose targetIds is not an array never reaches the handler", async () => {
    // A string targetIds would pass a substring test: "agent-a-2".includes("agent-a").
    const e1 = served(assigned("e1", 5));
    const catchup = serveAnswer(() =>
      Response.json({ events: [{ ...e1, targetIds: `${AGENT}-2` }], hasMore: false, nextAfter: e1.position }),
    );
    const handled: string[] = [];
    const loop = startTaskLoop(client(), AGENT, async (e) => { handled.push(e.id); }, { pollIntervalMs: 30 });
    try {
      expect(await waitFor(() => warnings.includes("malformed response"), 3_000)).toBe(true);
    } finally {
      await loop.stop();
    }
    expect(handled).toEqual([]);
    expect(cursorPosition()).toBe(catchup.afters[0]);
  });

  test("a terminal page whose nextAfter would move the cursor past a task is refused, nothing is persisted, and the task is delivered from a well-formed page", async () => {
    const task = assigned("task", 10);
    // An empty terminal page whose nextAfter lies after the task: accepted, it would skip it.
    const steering = { events: [], hasMore: false, nextAfter: `${new Date(Date.now() - 60_000).toISOString()}\tzzzz` };
    let answer: (req: Request, url: URL) => Response = () => Response.json(steering);
    const feed = orgEventCatchupRoute({ events: [task] });
    const catchup = serveAnswer((req, url) => answer(req, url));
    const handled: string[] = [];
    const persisted: Array<string | undefined> = [];
    const loop = startTaskLoop(client(), AGENT, async (e) => { handled.push(e.id); }, { pollIntervalMs: 30 });
    try {
      expect(await waitFor(() => catchup.afters.length >= 2, 3_000)).toBe(true);
      persisted.push(cursorPosition());
      answer = (req, url) => feed(req, url, AGENT);
      await waitFor(() => handled.length > 0);
    } finally {
      await loop.stop();
    }
    expect(warnings).toContain("malformed response (nextAfter of an empty page is not the request's cursor)");
    expect(isInitialPosition(persisted[0])).toBe(true);
    expect(new Set(catchup.afters.slice(0, 2)).size).toBe(1);
    expect(handled).toEqual(["task"]);
    expect(cursorPosition()).toBe(positionOf(task));
  });
});

describe("cli#624 — the initial position is set once and always sent", () => {
  /** Move Date.now by `offsetMs` until the returned function is called. */
  function shiftClock(): { advance: (ms: number) => void; restore: () => void } {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const restore = patchShared(Date, "now", () => realNow() + offset);
    return { advance: (ms) => { offset += ms; }, restore };
  }

  test("with a server watermark past the first event, the failed first event is retried in the same process after time advances", async () => {
    const [e1, e2] = [assigned("e1", 50), assigned("e2", 5)];
    // Flair's own watermark for the agent lies past e1: a read without `after` would start there.
    const catchup = serveFeed({ events: [e1, e2], watermarks: { [AGENT]: `${new Date(Date.now() - 10 * 60_000).toISOString()}\t` } });
    const clock = shiftClock();
    const calls: string[] = [];
    let failedOnce = false;
    const loop = startTaskLoop(client(), AGENT, async (e) => {
      calls.push(e.id);
      if (e.id === "e1" && !failedOnce) {
        failedOnce = true;
        // Half an hour passes before the retry: a floor recomputed now would exclude e1.
        clock.advance(30 * 60_000);
        throw new Error("transient failure");
      }
    }, { pollIntervalMs: 30 });
    try {
      await waitFor(() => calls.includes("e2"));
    } finally {
      await loop.stop();
      clock.restore();
    }
    expect(calls).toEqual(["e1", "e1", "e2"]);
    // The retry sent the same initial position as the first read.
    expect(isInitialPosition(catchup.afters[0])).toBe(true);
    expect(catchup.afters[1]).toBe(catchup.afters[0]);
    expect(cursorPosition()).toBe(positionOf(e2));
  });

  test("with a server watermark past the first event, a restart after time advances retries the failed first event from the persisted initial position", async () => {
    const [e1, e2] = [assigned("e1", 50), assigned("e2", 5)];
    const catchup = serveFeed({ events: [e1, e2], watermarks: { [AGENT]: `${new Date(Date.now() - 10 * 60_000).toISOString()}\t` } });
    const clock = shiftClock();
    try {
      const first: string[] = [];
      const loop1 = startTaskLoop(client(), AGENT, async (e) => {
        first.push(e.id);
        if (e.id === "e1") throw new Error("handler down");
      }, { pollIntervalMs: 5_000 });
      try {
        await waitFor(() => first.includes("e1"));
        await Bun.sleep(50);
      } finally {
        await loop1.stop();
      }
      expect(first).toEqual(["e1"]);
      const initial = catchup.afters[0];
      expect(isInitialPosition(initial)).toBe(true);
      expect(cursorPosition()).toBe(initial);

      clock.advance(30 * 60_000);
      const second: string[] = [];
      const loop2 = startTaskLoop(client(), AGENT, async (e) => { second.push(e.id); }, { pollIntervalMs: 5_000 });
      try {
        await waitFor(() => second.length >= 2);
      } finally {
        await loop2.stop();
      }
      expect(second).toEqual(["e1", "e2"]);
      expect(catchup.afters[1]).toBe(initial);
      expect(cursorPosition()).toBe(positionOf(e2));
    } finally {
      clock.restore();
    }
  });
});

describe("cli#624 — the initial position is saved before the first read", () => {
  // A regular file blocks creation of the cursor directory, including for root.
  const cursors = () => join(home, ".tps", "cursors");
  const lockCursors = () => {
    mkdirSync(join(home, ".tps"), { recursive: true });
    writeFileSync(cursors(), "blocked");
  };
  const unlockCursors = () => rmSync(cursors());
  const saveFailures = () => warnings.split("cannot save its initial position").length - 1;

  test(
    "while the initial position cannot be saved nothing is read; after recovery the saved position is the one fixed at start, and a restart retries the first task",
    async () => {
      const startNow = Date.now();
      const e1 = assigned("e1", 45);
      const catchup = serveFeed({ events: [e1] });
      const realNow = Date.now.bind(Date);
      let offset = 0;
      const restoreClock = patchShared(Date, "now", () => realNow() + offset);
      lockCursors();
      let locked = true;
      try {
        const first: string[] = [];
        const loop1 = startTaskLoop(client(), AGENT, async (e) => {
          first.push(e.id);
          throw new Error("handler down");
        }, { pollIntervalMs: 20 });
        try {
          expect(await waitFor(() => saveFailures() >= 3)).toBe(true);
          expect(warnings).toContain(`cannot save its initial position to ${cursorFile()} (EEXIST)`);
          expect(catchup.afters).toEqual([]);
          // Half an hour passes before the directory can be created: an initial
          // position recomputed now would start after e1.
          offset = 30 * 60_000;
          unlockCursors();
          locked = false;
          expect(await waitFor(() => first.includes("e1"))).toBe(true);
        } finally {
          if (locked) unlockCursors();
          await loop1.stop();
        }
        const initial = cursorPosition();
        expect(isInitialPosition(initial, startNow)).toBe(true);
        expect(catchup.afters[0]).toBe(initial);

        const second: string[] = [];
        const loop2 = startTaskLoop(client(), AGENT, async (e) => { second.push(e.id); }, { pollIntervalMs: 5_000 });
        try {
          await waitFor(() => second.length > 0);
        } finally {
          await loop2.stop();
        }
        expect(second).toEqual(["e1"]);
        expect(catchup.afters.at(-1)).toBe(initial);
        expect(cursorPosition()).toBe(positionOf(e1));
      } finally {
        restoreClock();
      }
    },
  );

  test("stop ends the retrying of the initial save promptly, and nothing is read", async () => {
    const catchup = serveFeed({ events: [assigned("e1", 5)] });
    lockCursors();
    try {
      const loop = startTaskLoop(client(), AGENT, async () => {}, { pollIntervalMs: 60_000 });
      expect(await waitFor(() => saveFailures() >= 1)).toBe(true);
      const t0 = performance.now();
      await loop.stop();
      expect(performance.now() - t0).toBeLessThan(1_000);
    } finally {
      unlockCursors();
    }
    await Bun.sleep(50);
    expect(catchup.afters).toEqual([]);
    expect(cursorPosition()).toBeUndefined();
  });
});

describe("cli#624 — the cursor is not persisted past the server's time plus the skew", () => {
  const AHEAD_MS = 2 * 3_600_000;
  const ahead = (kind: string) => ({
    id: "ahead", kind, authorId: AUTHOR, summary: "ahead", targetIds: [AGENT],
    createdAt: new Date(Date.now() + AHEAD_MS).toISOString(),
  });

  test.each([
    ["a non-task event", "note", ["now"]],
    ["a task", "task.assigned", ["ahead", "now"]],
  ])("%s positioned past the limit is read, the cursor holds before it, and a task created afterwards is delivered", async (_label, kind, expected) => {
    const events: Array<Record<string, unknown>> = [ahead(kind)];
    const catchup = serveFeed({ events });
    const handled: string[] = [];
    const loop = startTaskLoop(client(), AGENT, async (e) => { handled.push(e.id); }, { pollIntervalMs: 30 });
    let now: ReturnType<typeof assigned> | undefined;
    try {
      expect(await waitFor(() => catchup.served.includes("ahead"), 3_000)).toBe(true);
      await Bun.sleep(50);
      // The cursor did not move to the event past the limit.
      expect(isInitialPosition(cursorPosition())).toBe(true);
      now = assigned("now", 0);
      events.push(now);
      await waitFor(() => handled.includes("now"));
    } finally {
      await loop.stop();
    }
    expect(handled).toEqual(expected);
    expect(cursorPosition()).toBe(positionOf(now!));
    expect(warnings).toContain(
      `Task loop cursor held before ahead: its position is later than the server's time plus ${MAX_POSITION_SKEW_MS / 60_000} minutes`,
    );
  });

  test("the limit follows the server's time from the response's Date header", async () => {
    const event = ahead("note");
    const feed = orgEventCatchupRoute({ events: [event] });
    // The server's clock is ahead of this host's by more than the event is.
    serveAnswer((req, url) => withDate(feed(req, url, AGENT), new Date(Date.now() + AHEAD_MS + 3_600_000)));
    const loop = startTaskLoop(client(), AGENT, async () => {}, { pollIntervalMs: 5_000 });
    try {
      expect(await waitFor(() => cursorPosition() === positionOf(event), 3_000)).toBe(true);
    } finally {
      await loop.stop();
    }
    expect(warnings).not.toContain("Task loop cursor held");
  });
});

describe("cli#624 — stopping the task loop", () => {
  test("stop resolves once the loop has exited: an in-flight handler and its cursor write finish first, and no read follows", async () => {
    const e1 = assigned("e1", 5);
    const catchup = serveFeed({ events: [e1] });
    let inHandler = false;
    const loop = startTaskLoop(client(), AGENT, async () => {
      inHandler = true;
      await Bun.sleep(100);
    }, { pollIntervalMs: 60_000 });
    expect(await waitFor(() => inHandler)).toBe(true);
    await loop.stop();
    // The read that was in flight completed, cursor write included, before stop resolved.
    expect(cursorPosition()).toBe(positionOf(e1));
    const reads = catchup.afters.length;
    await Bun.sleep(50);
    expect(catchup.afters.length).toBe(reads);
  });
});

describe("cli#624 — the task loop's cursor file", () => {
  test("an unreadable cursor file is logged and treated as no cursor; the initial position is an hour back", async () => {
    writeCursor("{not json");
    const [old, recent] = [assigned("old", 90), assigned("recent", 30)];
    const catchup = serveFeed({ events: [old, recent] });
    const handled: string[] = [];
    const loop = startTaskLoop(client(), AGENT, async (e) => { handled.push(e.id); }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => handled.length > 0);
    } finally {
      await loop.stop();
    }
    expect(warnings).toContain(
      `Task loop cursor at ${cursorFile()} is unusable (it is not JSON); treating it as no cursor, so the initial position is set 60 minutes back`,
    );
    expect(isInitialPosition(catchup.afters[0])).toBe(true);
    expect(handled).toEqual(["recent"]);
    expect(cursorPosition()).toBe(positionOf(recent));
  });

  test("a legacy { since } cursor resumes from that timestamp", async () => {
    const since = new Date(Date.now() - 20 * 60_000).toISOString();
    writeCursor({ since });
    const [before, after] = [assigned("before", 30), assigned("after", 10)];
    const catchup = serveFeed({ events: [before, after] });
    const handled: string[] = [];
    const loop = startTaskLoop(client(), AGENT, async (e) => { handled.push(e.id); }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => handled.length > 0);
      await Bun.sleep(50);
    } finally {
      await loop.stop();
    }
    expect(catchup.afters[0]).toBe(`${since}\t`);
    expect(handled).toEqual(["after"]);
    expect(cursorPosition()).toBe(positionOf(after));
  });

  test("the cursor is replaced by a rename, never rewritten in place, and no temporary file is left beside it", async () => {
    const [e0, e1] = [assigned("e0", 30), assigned("e1", 10)];
    writeCursor({ position: positionOf(e0), updatedAt: new Date().toISOString() });
    const inodeBefore = statSync(cursorFile()).ino;
    serveFeed({ events: [e0, e1] });
    const handled: string[] = [];
    const loop = startTaskLoop(client(), AGENT, async (e) => { handled.push(e.id); }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => cursorPosition() === positionOf(e1));
    } finally {
      await loop.stop();
    }
    expect(handled).toEqual(["e1"]);
    // A rename puts a new file (a new inode) at the path; an in-place write keeps the old one.
    expect(statSync(cursorFile()).ino).not.toBe(inodeBefore);
    expect(readdirSync(join(home, ".tps", "cursors"))).toEqual([`${AGENT}-task-loop.json`]);
  });
});

describe("cli#631 — loopId is a single safe filename component", () => {
  test("refuses a traversal, separator, dot or over-long loopId before reading or writing a cursor", () => {
    // A client the loop could not use even if it got past the check: the refusal must come first.
    const untouched = {} as FlairClient;
    for (const bad of ["../../outside", "a/b", "..", ".", "a\\b", "x".repeat(80), "a\0b"]) {
      expect(() => startTaskLoop(untouched, AGENT, async () => {}, { loopId: bad })).toThrow(InvalidLoopIdError);
    }
    // Nothing was read or written: the cursors directory does not exist, and the
    // path a traversal loopId would reach is untouched.
    expect(existsSync(join(home, ".tps", "cursors"))).toBe(false);
    expect(existsSync(join(home, "outside-task-loop.json"))).toBe(false);
  });

  test("accepts a valid loopId and names its cursor file with it", async () => {
    serveFeed({ events: [] });
    const loop = startTaskLoop(client(), AGENT, async () => {}, { loopId: "agent-a-review-trigger", pollIntervalMs: 60_000 });
    try {
      expect(await waitFor(() => existsSync(join(home, ".tps", "cursors", "agent-a-review-trigger-task-loop.json")))).toBe(true);
    } finally {
      await loop.stop();
    }
  });
});
