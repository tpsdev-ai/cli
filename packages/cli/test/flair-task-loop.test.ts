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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    serveAnswer(() =>
      Response.json({ events: [{ ...assigned("e1", 5), ...change }], hasMore: false, nextAfter: "x" }),
    );
    expect(await client().getEventsSince(AGENT, LOOKBACK)).toEqual({
      status: "unavailable",
      reason: "malformed response (an event lacks a field the command reads)",
    });
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
      loop.stop();
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
      loop1.stop();
    }
    expect(first).toEqual(["e0", "e1"]);
    expect(cursorPosition()).toBe(positionOf(e0));

    const second: string[] = [];
    const loop2 = startTaskLoop(client(), AGENT, async (e) => { second.push(e.id); }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => second.length >= 2);
    } finally {
      loop2.stop();
    }
    expect(second).toEqual(["e1", "e2"]);
    expect(catchup.afters.at(-1)).toBe(positionOf(e0));
    expect(cursorPosition()).toBe(positionOf(e2));
  });

  test("a page whose targetIds is not an array never reaches the handler", async () => {
    // A string targetIds would pass a substring test: "agent-a-2".includes("agent-a").
    serveAnswer(() =>
      Response.json({ events: [{ ...assigned("e1", 5), targetIds: `${AGENT}-2` }], hasMore: false, nextAfter: "x" }),
    );
    const handled: string[] = [];
    const loop = startTaskLoop(client(), AGENT, async (e) => { handled.push(e.id); }, { pollIntervalMs: 30 });
    try {
      expect(await waitFor(() => warnings.includes("malformed response"), 3_000)).toBe(true);
    } finally {
      loop.stop();
    }
    expect(handled).toEqual([]);
    expect(cursorPosition()).toBeUndefined();
  });
});

describe("cli#624 — the task loop's cursor file", () => {
  test("an unreadable cursor file is logged and treated as no cursor; the first read looks back an hour", async () => {
    writeCursor("{not json");
    const [old, recent] = [assigned("old", 90), assigned("recent", 30)];
    const catchup = serveFeed({ events: [old, recent] });
    const handled: string[] = [];
    const loop = startTaskLoop(client(), AGENT, async (e) => { handled.push(e.id); }, { pollIntervalMs: 5_000 });
    try {
      await waitFor(() => handled.length > 0);
    } finally {
      loop.stop();
    }
    expect(warnings).toContain(
      `Task loop cursor at ${cursorFile()} is unusable (it is not JSON); treating it as no cursor, so the first read looks back 60 minutes`,
    );
    expect(catchup.afters[0]).toBe("");
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
      loop.stop();
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
      loop.stop();
    }
    expect(handled).toEqual(["e1"]);
    // A rename puts a new file (a new inode) at the path; an in-place write keeps the old one.
    expect(statSync(cursorFile()).ino).not.toBe(inodeBefore);
    expect(readdirSync(join(home, ".tps", "cursors"))).toEqual([`${AGENT}-task-loop.json`]);
  });
});
