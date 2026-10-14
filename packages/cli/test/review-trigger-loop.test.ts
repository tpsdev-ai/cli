/**
 * cli#631 — the review-trigger loop reads only feeds the agent may read: it
 * reads the agent's OWN catch-up feed (`agentId`), the feed Flair serves an
 * event addressed to that agent to. Before this change the loop read the feed of
 * `<agentId>-review-trigger` while signing as `agentId`, which Flair refuses
 * with 403, so it never received its events.
 *
 * The catch-up route is `orgEventCatchupRoute`, the shared signed stub modelled
 * on Flair's coded catch-up contract; it refuses a non-admin read of another
 * participant's feed with 403, so a loop that reads a foreign feed gets nothing.
 * The loop runs through the real FlairClient, signer and envelope reader; only
 * the HTTP endpoint is faked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { SnoopLogg } from "snooplogg";
import { createFlairClient } from "../src/utils/flair-client.js";
import { startReviewTriggerLoop } from "../src/utils/pr-review-trigger.js";
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
const SEED = Buffer.alloc(32, 0x31);
const REPO = "example/repo";

let stub: StubFlair | undefined;
let home: string;
let keyPath: string;
let warnings = "";
let output: Writable;
let logger: SnoopLogg;
const savedHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tps-review-trigger-"));
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

/** The review-trigger loop's cursor file under the test HOME (its own, not the task loop's). */
const cursorFile = () => join(home, ".tps", "cursors", `${AGENT}-review-trigger-task-loop.json`);

/** The cursor position the loop persisted, or undefined when it wrote none. */
function cursorPosition(): string | undefined {
  try {
    return JSON.parse(readFileSync(cursorFile(), "utf-8")).position;
  } catch {
    return undefined;
  }
}

const client = () => createFlairClient(AGENT, stub!.url, keyPath);

/** A pr.opened event `handlePrOpened` can request reviews for. */
const prOpened = (id: string, minutesAgo: number, targetIds: string[] = [AGENT]) => ({
  id, kind: "pr.opened", authorId: AUTHOR, summary: `PR ${id}`,
  detail: `https://github.com/${REPO}/pull/1`,
  createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), targetIds,
});

/** The feed position Flair gives an event: `<createdAt>\t<id>`. */
const positionOf = (e: { createdAt: string; id: string }) => `${e.createdAt}\t${e.id}`;

/** Serve `feed` through the verifying stub, recording every participant a catch-up request names. */
function serve(feed: CatchupFeed): { route: CatchupRoute; asked: string[] } {
  stub?.stop();
  const route = orgEventCatchupRoute(feed);
  const asked: string[] = [];
  stub = installStubFlairFetch({ [AGENT]: SEED }, (req, url, caller) => {
    if (!url.pathname.startsWith("/OrgEventCatchup/")) return undefined;
    asked.push(decodeURIComponent(url.pathname.slice("/OrgEventCatchup/".length)));
    return route(req, url, caller);
  });
  return { route, asked };
}

/** Serve `answer` for every catch-up request, recording the `after` query. */
function serveAnswer(answer: (req: Request, url: URL) => Response): CatchupRoute {
  stub?.stop();
  const route = ((req: Request, url: URL) => {
    route.afters.push(url.searchParams.get("after") ?? "");
    return answer(req, url);
  }) as CatchupRoute;
  route.afters = [];
  route.served = [];
  stub = installStubFlairFetch({ [AGENT]: SEED }, (req, url) => url.pathname.startsWith("/OrgEventCatchup/") ? route(req, url, "") : undefined);
  return route;
}

/**
 * Poll `cond` until it holds or `timeoutMs` elapses; return whether it held. The
 * default stays under bun's 5 s test timeout, so a failing test still stops its
 * loop in `finally`.
 */
async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(10);
  }
  return cond();
}

const LOOP_OPTS = { pollIntervalMs: 30 };

describe("cli#631 — the review-trigger loop reads only feeds the agent may read", () => {
  test("it reads the agent's own feed, so a pr.opened trigger addressed to the agent is handled", async () => {
    const e1 = prOpened("e1", 5);
    const { route, asked } = serve({ events: [e1] });
    const loop = startReviewTriggerLoop(client(), AGENT, { reviewers: [], repo: REPO }, LOOP_OPTS);
    try {
      // The cursor advances only after the handler succeeds; a refused read advances nothing.
      expect(await waitFor(() => cursorPosition() === positionOf(e1))).toBe(true);
    } finally {
      await loop.stop();
    }
    // Every request named the agent's own feed. A foreign feed (…-review-trigger) would 403 and deliver nothing.
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set([AGENT]));
    expect(route.served).toEqual(["e1"]);
    expect(warnings).not.toContain("unavailable");
  });

  test("a refused read is reported unavailable, not treated as an empty feed", async () => {
    const route = serveAnswer(() => Response.json({ error: "forbidden" }, { status: 403 }));
    const loop = startReviewTriggerLoop(client(), AGENT, { reviewers: [], repo: REPO }, LOOP_OPTS);
    try {
      expect(await waitFor(() => route.afters.length >= 1)).toBe(true);
      expect(await waitFor(() => warnings.includes("catch-up read unavailable"))).toBe(true);
    } finally {
      await loop.stop();
    }
    expect(warnings).toContain("(HTTP 403)");
    // The initial position was saved; the refused read advanced the cursor no further.
    expect(cursorPosition()).toBe(route.afters[0]);
  });
});
