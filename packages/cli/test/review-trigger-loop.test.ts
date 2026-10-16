/**
 * cli#631 — the review-trigger loop reads only feeds the agent may read: it
 * reads the agent's OWN catch-up feed (`agentId`), the feed Flair serves an
 * event addressed to that agent to. Flair refuses a non-admin agent's read of
 * `<agentId>-review-trigger` with 403.
 *
 * cli#644 — the loop runs end to end on the events the runtime itself produces:
 * an agent config's `reviewTrigger` (validated by `parseReviewTriggerConfig`, as
 * the launcher passes it) starts the loop, and the `pr.opened` event the runtime
 * publishes after a successful PR carries its URL in `detail`. A failed review
 * request fails the handler, so the cursor stays before the event and the loop
 * retries it.
 *
 * The catch-up route is `orgEventCatchupRoute`, the shared signed stub modelled
 * on Flair's coded catch-up contract; it refuses a non-admin read of another
 * participant's feed with 403, so a non-admin agent gets nothing from a foreign feed.
 * The loop runs through the real FlairClient, signer and envelope reader; the
 * HTTP catch-up endpoint is faked, and the case that drives the review request
 * fakes the `gh-as` process call too (`spawnSyncImpl`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { load as parseYaml } from "js-yaml";
import { SnoopLogg } from "snooplogg";
import { createFlairClient } from "../src/utils/flair-client.js";
import { InvalidLoopIdError } from "../src/utils/flair-task-loop.js";
import { parseReviewTriggerConfig, startReviewTriggerLoop } from "../src/utils/pr-review-trigger.js";
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
const prOpened = (id: string, minutesAgo: number, targetIds: string[] = [AGENT]) => ({
  id, kind: "pr.opened", authorId: AGENT, summary: `PR ${id}`,
  detail: `https://github.com/${REPO}/pull/1`,
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
    const e1 = prOpened("e1", 5, [agentId]);
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

  test("a failed review request fails the handler, so the cursor stays before the event and the loop retries", async () => {
    const e1 = prOpened("e1", 5);
    const { route } = serve({ events: [e1] });
    let attempts = 0;
    const deps = {
      spawnSyncImpl: ((_cmd: string, _args: string[]) => {
        attempts++;
        return { status: 1, stdout: "", stderr: "gh-as: request failed" };
      }) as any,
    };
    const loop = startReviewTriggerLoop(client(), AGENT, { reviewers: ["reviewer-1"], repo: REPO }, { ...LOOP_OPTS, deps });
    try {
      // The handler ran and the loop retried the same event after it threw.
      expect(await waitFor(() => attempts >= 2)).toBe(true);
      expect(await waitFor(() => warnings.includes("handler error"))).toBe(true);
      expect(route.served).toContain("e1");
      // A failed request is not consumed: the cursor stayed at its initial
      // position, before the event.
      expect(cursorPosition()).toBe(route.afters[0]);
    } finally {
      await loop.stop();
    }
  });

  test("a real agent.yaml reviewTrigger starts the loop and requests its configured reviewers", async () => {
    const cfgPath = join(home, "agent.yaml");
    writeFileSync(cfgPath, [
      "agentId: agent-a",
      "reviewTrigger:",
      "  reviewers: [reviewer-1, reviewer-2]",
      "  repo: example/repo",
      "",
    ].join("\n"));
    const agentCfg = parseYaml(readFileSync(cfgPath, "utf-8")) as { reviewTrigger?: unknown };
    const reviewTrigger = parseReviewTriggerConfig(agentCfg.reviewTrigger);
    expect(reviewTrigger).toEqual({ reviewers: ["reviewer-1", "reviewer-2"], repo: REPO });

    serve({ events: [prOpened("e1", 5)] });
    const ghCalls: Array<{ args: string[]; input?: string }> = [];
    const deps = {
      spawnSyncImpl: ((_cmd: string, args: string[], opts?: { input?: string }) => {
        ghCalls.push({ args, input: opts?.input });
        return { status: 0, stdout: "", stderr: "" };
      }) as any,
    };
    const loop = startReviewTriggerLoop(client(), AGENT, reviewTrigger!, { ...LOOP_OPTS, deps });
    try {
      expect(await waitFor(() => ghCalls.length === 1)).toBe(true);
    } finally {
      await loop.stop();
    }
    expect(ghCalls[0]?.args).toEqual([
      AGENT, "api", "--method", "POST", `repos/${REPO}/pulls/1/requested_reviewers`, "--input", "-",
    ]);
    expect(ghCalls[0]?.input).toBe(JSON.stringify({ reviewers: ["reviewer-1", "reviewer-2"] }));
  });
});
