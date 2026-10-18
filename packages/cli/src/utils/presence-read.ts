/**
 * presence-read.ts — the per-agent presence read behind `tps roster dashboard`
 * and `tps office status` (cli#622), from the Flair instance the command
 * queries.
 *
 * `GET /Presence` returns one record per stored local Presence row, keyed by
 * agent. Agents push heartbeats, their activity and their current task; Flair
 * derives each record's status
 * (`active` / `idle` / `offline`) and whether its activity is still fresh when
 * it serves the read (resources/Presence.ts). Unlike the viewer's OrgEvent
 * catch-up feed (events addressed to the viewer or broadcast, from the viewer's
 * acknowledged position), it is per-agent — the source that matches "what is
 * each agent doing / when was it last seen".
 *
 * SCOPE: the commands display only agents in the Agent list. A listed agent
 * with no stored Presence row on the queried instance reads "no presence on
 * this instance". An older local row can remain after an agent moves. Flair
 * federation replicates Agent records but not Presence.
 *
 * Flair serves the roster to a verified reader (a registered agent's
 * TPS-Ed25519 signature, which is what both commands sign with); an unverified
 * caller gets 401 by default. `readPresence` signs one GET and sends it. When
 * the signer throws or returns no signature, it sends nothing: it never makes
 * an unsigned read, which an instance with Flair's public-roster opt-in would
 * answer. It validates the body and returns either
 *
 *   - `ok`, with one record per stored local Presence row, keyed by agent,
 *     holding only the fields it validated (`PresenceRecord`), or
 *   - `unavailable`, with a bounded reason: the HTTP status, a fixed note
 *     naming what is wrong with the request or the response, or the code or
 *     class of the error a failed signer or a rejected request raised. The
 *     reason never includes the response body or an error message.
 *
 * Validation covers every field the reader returns, and is all or nothing. The
 * whole read is `unavailable` when one record has such a field missing or
 * invalid (a status or activity outside Flair's vocabulary, a heartbeat time
 * that is not a finite number, or a current task other than null or the output
 * of slicing a non-empty trimmed string to 200 characters), or when two records
 * share an id. Cross-field checks reject: stale task/activity (a stale record
 * with a current task or non-`idle` activity), fresh activity equality (fresh
 * activity differing from lastActivity), and offline freshness (an offline
 * record with fresh activity). Other combinations are not checked, including
 * status versus a future heartbeat.
 */

/** Flair's derived presence status (resources/Presence.ts derivePresenceStatus). */
export type PresenceStatus = "active" | "idle" | "offline";
/** Flair's activity vocabulary (resources/Presence.ts VALID_ACTIVITIES). */
export type PresenceActivity = "coding" | "reviewing" | "planning" | "debugging" | "idle";

const PRESENCE_STATUSES: ReadonlySet<string> = new Set<PresenceStatus>(["active", "idle", "offline"]);
const PRESENCE_ACTIVITIES: ReadonlySet<string> = new Set<PresenceActivity>(["coding", "reviewing", "planning", "debugging", "idle"]);
/** Flair caps a current task at this many characters (CURRENT_TASK_MAX_LENGTH). */
const CURRENT_TASK_MAX_LENGTH = 200;

/**
 * A Presence record as the commands read it: the validated fields only. The
 * reader drops every other field Flair serves.
 */
export interface PresenceRecord {
  id: string;
  /** Derived by Flair from the heartbeat's age. */
  presenceStatus: PresenceStatus;
  /** Epoch ms of the agent's last heartbeat. */
  lastHeartbeatAt: number;
  /** The current activity; Flair serves "idle" once the activity is stale. */
  activity: PresenceActivity;
  /** The last activity the agent asserted, fresh or not; Flair serves "idle" when it asserted none. */
  lastActivity: PresenceActivity;
  /** Flair's verdict: is the activity still current? */
  activityFresh: boolean;
  /** The agent's current task; Flair serves null once the activity is stale. */
  currentTask: string | null;
}

export type PresenceRead =
  | { status: "ok"; agents: PresenceRecord[] }
  | { status: "unavailable"; reason: string };

/** Signs a Flair request: the Authorization header value, or undefined to send none. */
export type FlairRequestSigner = (method: string, path: string) => string | undefined;

export interface PresenceReadOpts {
  flairUrl: string;
  sign: FlairRequestSigner;
}

/** A code or class name safe to print: a short identifier, nothing else. */
const TAG = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function errorTag(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { code?: unknown; name?: unknown; cause?: unknown };
    const cause = typeof e.cause === "object" && e.cause !== null ? (e.cause as { code?: unknown }) : undefined;
    for (const candidate of [e.code, cause?.code, e.name]) {
      if (typeof candidate === "string" && TAG.test(candidate)) return candidate;
    }
  }
  return "unknown error";
}

/**
 * The validated record, or a fixed note saying what is wrong with it. Field
 * names in the notes are fixed strings, so a note is safe to print.
 */
function toPresenceRecord(value: unknown): PresenceRecord | { invalid: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { invalid: "an entry is not an object" };
  const r = value as Record<string, unknown>;
  const bad = (field: string) => ({ invalid: `a presence record has a missing or invalid ${field}` });
  if (typeof r.id !== "string" || r.id.length === 0) return bad("id");
  if (typeof r.presenceStatus !== "string" || !PRESENCE_STATUSES.has(r.presenceStatus)) return bad("presenceStatus");
  if (typeof r.lastHeartbeatAt !== "number" || !Number.isFinite(r.lastHeartbeatAt)) return bad("lastHeartbeatAt");
  if (typeof r.activity !== "string" || !PRESENCE_ACTIVITIES.has(r.activity)) return bad("activity");
  if (typeof r.lastActivity !== "string" || !PRESENCE_ACTIVITIES.has(r.lastActivity)) return bad("lastActivity");
  if (typeof r.activityFresh !== "boolean") return bad("activityFresh");
  const task = r.currentTask;
  // Flair trims, then slices to the cap; the slice can end in whitespace.
  if (task !== null && (
    typeof task !== "string" || task.length === 0 || task.length > CURRENT_TASK_MAX_LENGTH ||
    task.trimStart() !== task || (task.length < CURRENT_TASK_MAX_LENGTH && task.trimEnd() !== task)
  ))
    return bad("currentTask");
  // For rows written through Flair's heartbeat path, the activity stamp is
  // never newer than the heartbeat. Flair's read path does not enforce this
  // for stored rows.
  if (!r.activityFresh && (task !== null || r.activity !== "idle"))
    return { invalid: "a stale presence record carries a current task or an activity other than idle" };
  if (r.activityFresh && r.activity !== r.lastActivity)
    return { invalid: "a fresh presence record's activity differs from its last activity" };
  if (r.activityFresh && r.presenceStatus === "offline")
    return { invalid: "an offline presence record reports fresh activity" };
  return {
    id: r.id,
    presenceStatus: r.presenceStatus as PresenceStatus,
    lastHeartbeatAt: r.lastHeartbeatAt,
    activity: r.activity as PresenceActivity,
    lastActivity: r.lastActivity as PresenceActivity,
    activityFresh: r.activityFresh,
    currentTask: task,
  };
}

/** Read the queried instance's Presence roster; see the module doc. */
export async function readPresence(opts: PresenceReadOpts): Promise<PresenceRead> {
  const path = "/Presence";
  let auth: string | undefined;
  try {
    auth = opts.sign("GET", path);
  } catch (err) {
    return { status: "unavailable", reason: `signing failed (${errorTag(err)})` };
  }
  if (!auth) return { status: "unavailable", reason: "not signed (no request sent)" };
  let res: Response;
  try {
    res = await fetch(`${opts.flairUrl}${path}`, { headers: { Authorization: auth } });
  } catch (err) {
    return { status: "unavailable", reason: `request failed (${errorTag(err)})` };
  }
  if (!res.ok) return { status: "unavailable", reason: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: "unavailable", reason: "malformed response (body is not JSON)" };
  }
  if (!Array.isArray(body)) return { status: "unavailable", reason: "malformed response (body is not an array)" };
  const agents: PresenceRecord[] = [];
  const ids = new Set<string>();
  for (const value of body) {
    const rec = toPresenceRecord(value);
    if ("invalid" in rec) return { status: "unavailable", reason: `malformed response (${rec.invalid})` };
    if (ids.has(rec.id)) return { status: "unavailable", reason: "malformed response (two presence records share an id)" };
    ids.add(rec.id);
    agents.push(rec);
  }
  return { status: "ok", agents };
}

/**
 * The read's state, which both commands emit per agent in their JSON
 * (`presenceState`). Their tables print the derived status, or `unavailable`.
 */
export type PresenceState = "ok" | "unavailable";

export function presenceState(read: PresenceRead): PresenceState {
  return read.status === "ok" ? "ok" : "unavailable";
}

/** What both commands print for a listed agent with no stored Presence row on the queried instance. */
export const NO_PRESENCE_TEXT = "no presence on this instance";

/**
 * The one line a command prints about the read, or null when it was ok. It
 * names the Flair URL and, for an unavailable read, the bounded reason.
 */
export function presenceReadNotice(flairUrl: string, read: PresenceRead): string | null {
  if (read.status === "unavailable") return `Cannot read Presence from ${flairUrl} (${read.reason}); presence is unavailable.`;
  return null;
}

/** "3m ago" for a past epoch-ms timestamp; "just now" for the future or <1m. */
export function relativeAgo(at: number, now = Date.now()): string {
  const diff = now - at;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
