/**
 * cli#631 — the review-trigger loop reads only feeds the agent may read: it
 * reads the agent's OWN catch-up feed (`agentId`), the feed Flair serves an
 * event addressed to that agent to. Flair refuses a non-admin agent's read of
 * `<agentId>-review-trigger` with 403.
 *
 * The catch-up route is `orgEventCatchupRoute`, the shared signed stub modelled
 * on Flair's coded catch-up contract; it refuses a non-admin read of another
 * participant's feed with 403, so a non-admin agent gets nothing from a foreign feed.
 * The loop runs through the real FlairClient, signer and envelope reader; the
 * HTTP catch-up endpoint is faked, and the case that drives the review request
 * fakes the `gh-as` process call too (`spawnSyncImpl`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { SnoopLogg } from "snooplogg";
import { createFlairClient } from "../src/utils/flair-client.js";
import { InvalidLoopIdError } from "../src/utils/flair-task-loop.js";
import { REVIEW_TRIGGER_MAX_ATTEMPTS, startReviewTriggerLoop } from "../src/utils/pr-review-trigger.js";
import {
  type CatchupFeed,
  type CatchupRoute,
  installStubFlairFetch,
  orgEventCatchupRoute,
  type StubFlair,
  writeKeyFile,
} from "./helpers/stub-flair.js";

const AGENT = "agent-a";
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
const cursorFile = (agentId = AGENT) => join(home, ".tps", "cursors", `${agentId}-review-trigger-task-loop.json`);

/** The cursor position the loop persisted, or undefined when it wrote none. */
function cursorPosition(agentId = AGENT): string | undefined {
  try {
    return JSON.parse(readFileSync(cursorFile(agentId), "utf-8")).position;
  } catch {
    return undefined;
  }
}

const client = (agentId = AGENT) => createFlairClient(agentId, stub!.url, keyPath);

/** A pr.opened event in the shape the runtime publishes after a successful PR:
 *  authored by the agent, `detail` the PR URL `runAutoCommit` returned. */
const prOpened = (id: string, minutesAgo: number, targetIds: string[] = [AGENT], prNumber = 1, authorId = AGENT) => ({
  id, kind: "pr.opened", authorId, summary: `PR ${id}`,
  detail: `https://github.com/${REPO}/pull/${prNumber}`,
  createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), targetIds,
});

/** The feed position Flair gives an event: `<createdAt>\t<id>`. */
const positionOf = (e: { createdAt: string; id: string }) => `${e.createdAt}\t${e.id}`;

/** Serve `feed` through the verifying stub, recording every participant a catch-up request names. */
function serve(feed: CatchupFeed, agentId = AGENT): { route: CatchupRoute; asked: string[] } {
  stub?.stop();
  const route = orgEventCatchupRoute(feed);
  const asked: string[] = [];
  stub = installStubFlairFetch({ [agentId]: SEED }, (req, url, caller) => {
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
  test.each([AGENT, "a".repeat(64)])("agent %s: with the HTTP catch-up endpoint faked and the gh-as process call faked (spawnSyncImpl), it reads the agent's own feed and requests the configured reviewers for a trigger addressed to the agent", async (agentId) => {
    keyPath = writeKeyFile(join(home, ".tps", "identity"), agentId, SEED);
    const e1 = prOpened("e1", 5, [agentId], 1, agentId);
    const { route, asked } = serve({ events: [e1] }, agentId);
    const ghCalls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const deps = {
      spawnSyncImpl: ((cmd: string, args: string[], opts?: { input?: string }) => {
        ghCalls.push({ cmd, args, input: opts?.input });
        return { status: 0, stdout: "", stderr: "" };
      }) as any,
    };
    const loop = startReviewTriggerLoop(client(agentId), agentId, { reviewers: ["reviewer-1"], repo: REPO }, { ...LOOP_OPTS, deps });
    try {
      // The cursor advances only after the handler succeeds; a refused read advances nothing.
      expect(await waitFor(() => cursorPosition(agentId) === positionOf(e1))).toBe(true);
      expect(ghCalls).toHaveLength(1);
    } finally {
      await loop.stop();
    }
    // The handler issued the review request the review-trigger loop exists for: gh-as, as the agent,
    // on the PR in the event's /pull/<n> URL, with the configured reviewers as the payload.
    expect(ghCalls[0]?.cmd).toBe("gh-as");
    expect(ghCalls[0]?.args).toEqual([
      agentId, "api", "--method", "POST", `repos/${REPO}/pulls/1/requested_reviewers`, "--input", "-",
    ]);
    expect(ghCalls[0]?.input).toBe(JSON.stringify({ reviewers: ["reviewer-1"] }));
    // Every request named the agent's own feed. A non-admin agent's foreign-feed read would get 403.
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set([agentId]));
    expect(route.served).toEqual(["e1"]);
    expect(warnings).not.toContain("unavailable");
  });

  test("refuses the 80-character review loop ID derived from a 65-character agent ID before cursor access", () => {
    serve({ events: [] });
    expect(() => startReviewTriggerLoop(client(), "a".repeat(65), { reviewers: [], repo: REPO }))
      .toThrow(InvalidLoopIdError);
    expect(existsSync(join(home, ".tps", "cursors"))).toBe(false);
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

  test.each([[[] as string[]], [[AGENT]]])(
    "a pr.opened authored by another agent, broadcast or addressed to this agent, never reaches the review-request command, and the cursor advances past it",
    async (targetIds) => {
      // A foreign author, broadcast or addressed to this agent, is ineligible.
      const foreign = prOpened("e1", 5, targetIds, 1, "agent-b");
      const good = prOpened("e2", 4, [AGENT], 2, AGENT);
      const { route } = serve({ events: [foreign, good] });
      const ghCalls: Array<{ cmd: string; args: string[]; input?: string }> = [];
      const deps = {
        spawnSyncImpl: ((cmd: string, args: string[], opts?: { input?: string }) => {
          ghCalls.push({ cmd, args, input: opts?.input });
          return { status: 0, stdout: "", stderr: "" };
        }) as any,
      };
      const loop = startReviewTriggerLoop(client(), AGENT, { reviewers: ["reviewer-1"], repo: REPO }, { ...LOOP_OPTS, deps });
      try {
        // The cursor advances over both: the foreign event is skipped, the good one handled.
        expect(await waitFor(() => cursorPosition() === positionOf(good))).toBe(true);
        expect(ghCalls).toHaveLength(1);
      } finally {
        await loop.stop();
      }
      // Only the agent's own PR #2 event reached the command.
      expect(ghCalls[0]?.args).toEqual([
        AGENT, "api", "--method", "POST", `repos/${REPO}/pulls/2/requested_reviewers`, "--input", "-",
      ]);
      expect(new Set(route.served)).toEqual(new Set(["e1", "e2"]));
    },
  );

  test("a permanently bad pr.opened is recorded and skipped, and a later good one still gets its review request", async () => {
    // A branch-only detail is permanently rejected by this handler.
    const bad = { ...prOpened("e1", 5, [AGENT], 1, AGENT), detail: "branch-only" };
    const good = prOpened("e2", 4, [AGENT], 2, AGENT);
    const { route } = serve({ events: [bad, good] });
    const ghCalls: Array<{ args: string[] }> = [];
    const deps = {
      spawnSyncImpl: ((_cmd: string, args: string[]) => {
        ghCalls.push({ args });
        return { status: 0, stdout: "", stderr: "" };
      }) as any,
    };
    const loop = startReviewTriggerLoop(client(), AGENT, { reviewers: ["reviewer-1"], repo: REPO }, { ...LOOP_OPTS, deps });
    try {
      expect(await waitFor(() => cursorPosition() === positionOf(good))).toBe(true);
      expect(ghCalls).toHaveLength(1);
    } finally {
      await loop.stop();
    }
    expect(ghCalls[0]?.args).toEqual([
      AGENT, "api", "--method", "POST", `repos/${REPO}/pulls/2/requested_reviewers`, "--input", "-",
    ]);
    expect(route.served).toEqual(expect.arrayContaining(["e1", "e2"]));
    expect(warnings).toContain("failed permanently");
  });

  test("a transient review-request failure is retried, and the event is handled when it recovers within the bound", async () => {
    const e1 = prOpened("e1", 5);
    const { route } = serve({ events: [e1] });
    let attempts = 0;
    const deps = {
      spawnSyncImpl: ((_cmd: string, _args: string[]) => {
        attempts++;
        // A network error is transient: the first call fails, the retry succeeds.
        return attempts < 2
          ? { status: 1, stdout: "", stderr: "gh-as: connection reset" }
          : { status: 0, stdout: "", stderr: "" };
      }) as any,
    };
    const loop = startReviewTriggerLoop(client(), AGENT, { reviewers: ["reviewer-1"], repo: REPO }, { ...LOOP_OPTS, deps });
    try {
      expect(await waitFor(() => cursorPosition() === positionOf(e1))).toBe(true);
    } finally {
      await loop.stop();
    }
    // Retried once, then handled: the cursor advanced past the event.
    expect(attempts).toBe(2);
    expect(route.served).toContain("e1");
    expect(warnings).toContain("it will be retried");
  });

  test("a transient review-request failure that never recovers is skipped after the attempt bound, and a later event is still handled", async () => {
    const e1 = prOpened("e1", 5, [AGENT], 1, AGENT);
    const good = prOpened("e2", 4, [AGENT], 2, AGENT);
    const { route } = serve({ events: [e1, good] });
    let attempts = 0;
    const deps = {
      spawnSyncImpl: ((_cmd: string, args: string[]) => {
        attempts++;
        // PR #1 always fails transiently; PR #2 succeeds.
        return args[4]?.includes("/pulls/1/")
          ? { status: 1, stdout: "", stderr: "gh-as: server unavailable" }
          : { status: 0, stdout: "", stderr: "" };
      }) as any,
    };
    const loop = startReviewTriggerLoop(client(), AGENT, { reviewers: ["reviewer-1"], repo: REPO }, { ...LOOP_OPTS, deps });
    try {
      // The bound is spent on e1, it is skipped, and e2 then gets its request.
      expect(await waitFor(() => cursorPosition() === positionOf(good))).toBe(true);
    } finally {
      await loop.stop();
    }
    expect(attempts).toBe(REVIEW_TRIGGER_MAX_ATTEMPTS + 1);
    expect(new Set(route.served)).toEqual(new Set(["e1", "e2"]));
    expect(warnings).toContain("skipped after the attempt bound");
  });

  test("a duplicate pr.opened from a retried publish is handled again harmlessly: the same reviewer is requested, which GitHub treats as idempotent", async () => {
    // A lost publication response makes the runtime POST the same pr.opened
    // twice; each copy reaches a review request for the same PR and reviewer.
    const first = prOpened("e1", 5, [AGENT], 1, AGENT);
    const duplicate = { ...first, id: "e2" };
    const { route } = serve({ events: [first, duplicate] });
    const ghCalls: Array<{ args: string[] }> = [];
    const deps = {
      spawnSyncImpl: ((_cmd: string, args: string[]) => {
        ghCalls.push({ args });
        return { status: 0, stdout: "", stderr: "" };
      }) as any,
    };
    const loop = startReviewTriggerLoop(client(), AGENT, { reviewers: ["reviewer-1"], repo: REPO }, { ...LOOP_OPTS, deps });
    try {
      expect(await waitFor(() => cursorPosition() === positionOf(duplicate))).toBe(true);
    } finally {
      await loop.stop();
    }
    // Both copies requested the same reviewer on the same PR; the second is a no-op on GitHub.
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls[1]).toEqual(ghCalls[0]);
    expect(new Set(route.served)).toEqual(new Set(["e1", "e2"]));
  });
});
