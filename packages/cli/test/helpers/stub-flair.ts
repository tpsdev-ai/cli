/**
 * stub-flair.ts — the ONE shared stub Flair HTTP endpoint for the cli tests,
 * plus the signing helpers the mail tests use.
 *
 * The production Flair client signs every request:
 *   Authorization: TPS-Ed25519 <agentId>:<timestamp>:<nonce>:<signature>
 *   signature payload: <agentId>:<timestamp>:<nonce>:<METHOD>:<path?query>
 * Real Flair refuses an unverified caller, so a stub that ignores the
 * Authorization header lets a test keep passing after the client's signing
 * breaks (cli#554). `stubFlairHandler` verifies the caller before it answers:
 *   - a malformed TPS-Ed25519 header  -> 401 { error: "invalid_authorization_header" }
 *     (Flair's auth middleware, on every path)
 *   - no header, or another scheme  -> 403 { type: "error:AccessViolation", ... }
 *     (except `GET /Presence`, which gets 401 { error: "authentication required" }:
 *     Flair passes such a request to the resource as anonymous, and
 *     Presence.get() refuses an anonymous reader with 401 by default —
 *     resources/Presence.ts, flair#1880. The stub models no admin credential.)
 *   - timestamp outside the window  -> 401 { error: "timestamp_out_of_window" }
 *   - a nonce seen before           -> 401 { error: "nonce_replay_detected" }
 *   - a caller with no registered key -> 401 { error: "unknown_agent" }
 *   - a bad signature               -> 401 { error: "invalid_signature" }
 *
 * Built in it answers `GET /Health` (unauth, a liveness probe) and
 * `GET /Agent/<name>` (the public-key read the production client makes). A test
 * that needs other Flair routes passes a `routes` callback, which runs only
 * after the caller is verified.
 *
 * A test that drives a production signer must reach Flair through this helper
 * (`startStubFlair`, `installStubFlairFetch` or `stubFlairHandler`); the signer
 * inventory in flair-signer-inventory.test.ts maps each production Flair
 * signing path to such a test.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { signEnvelope, type Envelope, type ChainEntry } from "@tpsdev-ai/agent";

// Wire sha512 for sync sign operations (same pattern as the other mail tests).
import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => {
  return new Uint8Array(createHash("sha512").update(message).digest());
};

export function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

/** A registered caller: a raw 32-byte seed, or the base64 SPKI public key itself. */
export type StubFlairCaller = Buffer | string;

/**
 * Routes a stub serves AFTER the caller is verified. `caller` is the verified
 * agent id. Return a Response to answer, or undefined to fall through to the
 * built-in `/Agent/<name>` route.
 */
export type FlairRoutes = (
  req: Request,
  url: URL,
  caller: string,
) => Response | undefined | Promise<Response | undefined>;

export interface StubFlair {
  url: string;
  stop(): void;
}

function publicKeyBase64(caller: StubFlairCaller): string {
  return typeof caller === "string" ? caller : pubkeyFromSeed(caller).toString("base64");
}

/** The response Presence.get() returns to an anonymous reader (resources/Presence.ts, flair#1880). */
function presenceAuthenticationRequired(): Response {
  return Response.json({ error: "authentication required" }, { status: 401 });
}

/** The response Flair returns to an unauthenticated caller. */
function accessViolation(url: URL): Response {
  return Response.json(
    {
      type: "error:AccessViolation",
      code: "AccessViolation",
      title: "Unauthorized access to resource",
      status: 403,
      instance: url.pathname + url.search,
    },
    { status: 403 },
  );
}

/**
 * A handler that verifies the TPS-Ed25519 callers' credentials before answering
 * a Flair route. `seeds` registers each caller the tests may sign as.
 */
export function stubFlairHandler(
  seeds: Record<string, StubFlairCaller>,
  routes?: FlairRoutes,
): (req: Request) => Response | Promise<Response> {
  const pubs: Record<string, string> = {};
  for (const [name, caller] of Object.entries(seeds)) {
    pubs[name] = publicKeyBase64(caller);
  }
  const nonces = new Set<string>();
  const builtin = (url: URL): Response => {
    const m = url.pathname.match(/^\/Agent\/(.+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]!);
      const pk = Object.hasOwn(pubs, name) ? pubs[name] : undefined;
      if (!pk) return new Response("not found", { status: 404 });
      return Response.json({ id: name, name, publicKey: pk });
    }
    return new Response("not found", { status: 404 });
  };
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/Health") return new Response("ok");
    const header = req.headers.get("Authorization") ?? "";
    const tpsScheme = /^TPS-Ed25519(?:\s|$)/i.test(header);
    const auth = tpsScheme && header.length <= 4096 ? /^TPS-Ed25519\s+([^:\s]+):(\d+):([^:\s]+):(.+)$/.exec(header) : null;
    if (!auth) {
      if (tpsScheme) return Response.json({ error: "invalid_authorization_header" }, { status: 401 });
      if (req.method === "GET" && url.pathname === "/Presence") return presenceAuthenticationRequired();
      return accessViolation(url);
    }
    const [, caller, timestamp, nonce, signature] = auth;
    const refuse = (error: string) => Response.json({ error }, { status: 401 });
    const now = Date.now();
    if (!Number.isFinite(Number(timestamp)) || Math.abs(now - Number(timestamp)) > 30_000)
      return refuse("timestamp_out_of_window");
    const replayKey = `${caller}:${nonce}`;
    if (nonces.has(replayKey)) return refuse("nonce_replay_detected");
    if (!caller || !Object.hasOwn(pubs, caller)) return refuse("unknown_agent");
    try {
      const payload = `${caller}:${timestamp}:${nonce}:${req.method}:${url.pathname}${url.search}`;
      const key = createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubs[caller]!, "base64")]),
        format: "der", type: "spki",
      });
      if (!verify(null, Buffer.from(payload), key, Buffer.from(signature!, "base64")))
        return refuse("invalid_signature");
    } catch {
      return refuse("signature_verification_failed");
    }
    nonces.add(replayKey);
    if (routes) {
      const routed = routes(req, url, caller!);
      return routed instanceof Promise ? routed.then((r) => r ?? builtin(url)) : (routed ?? builtin(url));
    }
    return builtin(url);
  };
}

/** Start a stub Flair HTTP server: the production client can be pointed at `url`. */
export function startStubFlair(seeds: Record<string, StubFlairCaller>, routes?: FlairRoutes): StubFlair {
  const server = Bun.serve({ port: 0, fetch: stubFlairHandler(seeds, routes) });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * Point `globalThis.fetch` at a stub Flair, restoring the previous fetch on
 * `stop()`. The test file itself constructs no fetch stub.
 */
export function installStubFlairFetch(
  seeds: Record<string, StubFlairCaller>,
  routes?: FlairRoutes,
): StubFlair {
  const previous = globalThis.fetch;
  const handler = stubFlairHandler(seeds, routes);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
  return { url: "http://flair.test", stop: () => { globalThis.fetch = previous; } };
}

/**
 * A request signer for `agentId` with a raw 32-byte seed: the Authorization
 * header value for `<METHOD> <path?query>`, in the scheme `stubFlairHandler`
 * verifies. For tests that call a reader directly with a signer of their own.
 */
export function requestSigner(agentId: string, seed: Buffer): (method: string, path: string) => string {
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  let n = 0;
  return (method, path) => {
    const ts = Date.now().toString();
    const nonce = `n${++n}-${Math.random().toString(36).slice(2, 8)}`;
    const sig = sign(null, Buffer.from(`${agentId}:${ts}:${nonce}:${method}:${path}`), key).toString("base64");
    return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig}`;
  };
}

/** The OrgEvent rows and read positions a stub catch-up feed serves. */
export interface CatchupFeed {
  /** OrgEvent rows. `createdAt` and `id` order them; `targetIds` and `expiresAt` are honored. */
  events: ReadonlyArray<Record<string, unknown>>;
  /** Acknowledged positions (watermarks) by participant id. A GET only creates one when it has none and sends no `since`. */
  watermarks?: Record<string, string>;
  /** Callers treated as admins, who may read any participant's feed. */
  admins?: readonly string[];
  /**
   * How far back a first watermark starts, in ms: Flair's
   * `FLAIR_CATCHUP_BACKFILL_MS`, whose default is 24h; `0` starts it at now.
   * A negative or non-finite value falls back to the default, as Flair's
   * parseBackfillMs does.
   */
  backfillMs?: number;
}

/** Flair's default first-watermark backfill (agent-read-position-lib.ts DEFAULT_CATCHUP_BACKFILL_MS). */
export const DEFAULT_CATCHUP_BACKFILL_MS = 24 * 3_600_000;

/** A catch-up route, plus a record of what it was asked for and what it served. */
export interface CatchupRoute {
  (req: Request, url: URL, caller: string): Response;
  /** Each request's `after` query value, in order (`""` when absent). */
  afters: string[];
  /** The id of every event served, in order. */
  served: string[];
}

/** The position of a row: `<createdAt>\t<id>`, compared as a string. */
const positionOf = (e: Record<string, unknown>) => `${String(e.createdAt ?? "")}\t${String(e.id ?? "")}`;

/**
 * A fake of Flair's `GET /OrgEventCatchup/<participant>`, modelled on the
 * coded contract in Flair's resources/OrgEventCatchup.ts,
 * org-event-catchup-lib.ts and agent-read-position-lib.ts. It is a model of
 * that code, not Flair itself; the real resource is not exercised here.
 *
 *   - a non-admin caller reading another participant's feed gets 403;
 *   - a `since` that does not parse as a date gets 400;
 *   - the cursor is the `after` query when non-empty (an unknown value is used
 *     as a filter, not refused), else the participant's watermark, else just
 *     before `since`, else a new watermark `backfillMs` back (created and
 *     kept; 24h by default, as Flair's default, and now when it is 0);
 *   - an event is served when it has `createdAt`, is not older than `since`,
 *     sorts after the cursor, is broadcast (no `targetIds`) or targets the
 *     participant, and has not expired;
 *   - events are ordered by position, `limit` sets the page size (default 50,
 *     clamped to 1..500), and the envelope is
 *     `{ events, watermark, after, nextAfter, hasMore, pageSize }`, where
 *     `nextAfter` is the last served event's position, or the cursor itself
 *     when the page is empty.
 *
 * A GET never advances an existing watermark.
 */
export function orgEventCatchupRoute(feed: CatchupFeed): CatchupRoute {
  const watermarks = feed.watermarks ?? {};
  const admins = new Set(feed.admins ?? []);
  const route = ((req: Request, url: URL, caller: string): Response => {
    const m = /^\/OrgEventCatchup\/([^/]+)$/.exec(url.pathname);
    if (req.method !== "GET" || !m) return Response.json({ error: "not found" }, { status: 404 });
    const participant = decodeURIComponent(m[1]!);
    if (!admins.has(caller) && caller !== participant)
      return Response.json({ error: "forbidden: can only fetch events for yourself" }, { status: 403 });
    const since = url.searchParams.get("since") || null;
    if (since && Number.isNaN(new Date(since).getTime()))
      return Response.json({ error: "invalid since timestamp" }, { status: 400 });
    const afterParam = url.searchParams.get("after");
    route.afters.push(afterParam ?? "");
    let watermark: string | null = Object.hasOwn(watermarks, participant) ? watermarks[participant]! : null;
    let after: string;
    if (afterParam) after = afterParam;
    else if (watermark) after = watermark;
    else if (since) after = `${since}\t`;
    else {
      const raw = feed.backfillMs;
      const backfill = raw === undefined || !Number.isFinite(raw) || raw < 0 ? DEFAULT_CATCHUP_BACKFILL_MS : raw;
      after = `${new Date(Math.max(0, Date.now() - backfill)).toISOString()}\t`;
      watermarks[participant] = after;
      watermark = after;
    }
    const raw = url.searchParams.get("limit");
    const n = raw !== null && raw !== "" ? Number(raw) : 50;
    const pageSize = Number.isFinite(n) ? Math.min(500, Math.max(1, Math.floor(n))) : 50;
    const now = new Date();
    const eligible = feed.events
      .filter((e) => {
        const createdAt = typeof e.createdAt === "string" ? e.createdAt : "";
        if (!createdAt) return false;
        if (since && createdAt < since) return false;
        if (positionOf(e) <= after) return false;
        const targets = e.targetIds as string[] | null | undefined;
        if (targets && targets.length > 0 && !targets.includes(participant)) return false;
        if (typeof e.expiresAt === "string" && new Date(e.expiresAt) < now) return false;
        return true;
      })
      .map((e) => ({ ...e, position: positionOf(e) }))
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    const hasMore = eligible.length > pageSize;
    const page = hasMore ? eligible.slice(0, pageSize) : eligible;
    const nextAfter = page.length > 0 ? page[page.length - 1]!.position : after;
    for (const e of page) route.served.push(String(e.id));
    return Response.json({ events: page, watermark, after, nextAfter, hasMore, pageSize });
  }) as CatchupRoute;
  route.afters = [];
  route.served = [];
  return route;
}

/** A Presence row as a heartbeat stores it (Flair's buildPresenceRecord). */
export interface PresenceRow {
  agentId: string;
  /** Epoch ms of the agent's last heartbeat. */
  lastHeartbeatAt: number;
  /** The activity the agent last asserted; Flair reads a missing one as "idle". */
  activity?: string;
  /** Epoch ms the activity was last asserted; null falls back to lastHeartbeatAt. */
  activityUpdatedAt?: number | null;
  /** The current task the agent last asserted. */
  currentTask?: string | null;
}

/** Flair's default presence thresholds (resources/Presence.ts idleThresholdMs / offlineThresholdMs). */
export const PRESENCE_IDLE_THRESHOLD_MS = 90_000;
export const PRESENCE_OFFLINE_THRESHOLD_MS = 600_000;

/**
 * The records Flair's `GET /Presence` serves a signature-verified reader for
 * `rows`, derived as resources/Presence.ts get() derives them at `now`, with
 * the default thresholds:
 *
 *   - `presenceStatus` from the heartbeat's age: `active` under 90 s (or in
 *     the future), `idle` under 10 min, else `offline`;
 *   - the activity is fresh while its stamp (`activityUpdatedAt`, else
 *     `lastHeartbeatAt`) is under 10 min old (or in the future);
 *   - `activity` is the asserted activity while fresh and `idle` once stale;
 *     `lastActivity` is the asserted activity either way (`idle` when none);
 *   - `currentTask` is the trimmed task capped at 200 characters while fresh,
 *     else null (an empty task is null);
 *   - `activityUpdatedAt` is the resolved stamp and `activityAgeMs` its age.
 *
 * It is a model of that code, not Flair itself; the real resource is not
 * exercised here. Agent metadata and the version stamps are not modelled:
 * `displayName` is the id, `role` is "agent", and `runtime`, `flairVersion` and
 * `harperVersion` are null.
 */
export function presenceRecords(rows: ReadonlyArray<PresenceRow>, now = Date.now()): Record<string, unknown>[] {
  return rows.map((row) => {
    const freshnessAt =
      typeof row.activityUpdatedAt === "number" && Number.isFinite(row.activityUpdatedAt)
        ? row.activityUpdatedAt
        : row.lastHeartbeatAt;
    const sinceBeat = now - row.lastHeartbeatAt;
    const presenceStatus =
      sinceBeat < PRESENCE_IDLE_THRESHOLD_MS ? "active" : sinceBeat < PRESENCE_OFFLINE_THRESHOLD_MS ? "idle" : "offline";
    const activityFresh = now - freshnessAt < PRESENCE_OFFLINE_THRESHOLD_MS;
    const rawActivity = typeof row.activity === "string" && row.activity.length > 0 ? row.activity : "idle";
    const task = typeof row.currentTask === "string" ? row.currentTask.trim().slice(0, 200) : "";
    return {
      id: row.agentId,
      displayName: row.agentId,
      role: "agent",
      runtime: null,
      activity: activityFresh ? rawActivity : "idle",
      lastActivity: rawActivity,
      activityUpdatedAt: freshnessAt,
      activityAgeMs: Math.max(0, now - freshnessAt),
      activityFresh,
      presenceStatus,
      currentTask: activityFresh && task.length > 0 ? task : null,
      lastHeartbeatAt: row.lastHeartbeatAt,
      flairVersion: null,
      harperVersion: null,
    };
  });
}

/**
 * A fake of Flair's `GET /Presence` for a verified caller: answers with
 * `presenceRecords(rows)` at the time of the request. The shared stub has
 * already refused an unverified caller with 401 (see `stubFlairHandler`).
 */
export function presenceRoute(rows: ReadonlyArray<PresenceRow>): FlairRoutes {
  return (req, url) =>
    req.method === "GET" && url.pathname === "/Presence" ? Response.json(presenceRecords(rows)) : undefined;
}

/** Write a raw 32-byte key file usable for both request signing and FLAIR_KEY_PATH. */
export function writeKeyFile(dir: string, agent: string, seed: Buffer): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${agent}.key`);
  writeFileSync(p, seed);
  return p;
}

export function buildSignedEnvelope(
  from: string,
  to: string,
  body: string,
  seeds: Record<string, Buffer>,
  opts: { messageId?: string; chain?: ChainEntry[]; trust?: string } = {},
): Envelope {
  const now = new Date().toISOString();
  const chain: ChainEntry[] = opts.chain ?? [
    { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: now, rationale: `agent ${from} dispatches`, signature: null },
  ];
  const envelope: Envelope = {
    v: 1,
    from,
    to,
    body,
    messageId: opts.messageId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: now,
    delegationChain: chain,
  };
  // `trust` is a signed envelope field. The cast lets a test plant an
  // out-of-union value (the unknown-trust-refused case).
  if (opts.trust !== undefined) (envelope as { trust?: unknown }).trust = opts.trust;
  return signEnvelope(envelope, seeds);
}
