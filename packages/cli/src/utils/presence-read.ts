/**
 * presence-read.ts — the office-wide per-agent presence read behind
 * `tps roster dashboard` and `tps office status` (cli#622).
 *
 * `GET /Presence` is Flair's roster of per-agent presence: one record per
 * agent that has pushed presence, each carrying the liveness and activity the
 * agent last asserted. Unlike the viewer's OrgEvent catch-up feed
 * (events addressed to the viewer or broadcast, from the viewer's
 * acknowledged position), this is office-wide and per-agent — the source that
 * matches "what is each agent doing / when was it last active".
 *
 * A verified reader (a registered agent's TPS-Ed25519 signature, which is what
 * both commands sign with) may read the roster. `readPresence` sends one signed
 * GET, validates the body is an array of records carrying the fields the
 * commands read, and returns it. The result is either
 *
 *   - `ok`, with the presence records, or
 *   - `unavailable`, with a bounded reason: the HTTP status, a fixed note
 *     naming the malformed part of the response, or the code or class of the
 *     error a rejected request raised. The reason never includes the response
 *     body or an error message.
 */

/** A Presence record as the commands read it. */
export interface PresenceRecord {
  id: string;
  /** "active" | "idle" | "offline" (Flair's derivePresenceStatus). */
  presenceStatus: string;
  /** Epoch ms of the agent's last heartbeat. */
  lastHeartbeatAt: number;
  /** "coding" | "reviewing" | "planning" | "debugging" | "idle" once stale. */
  activity: string;
  lastActivity?: string | null;
  activityUpdatedAt?: number | null;
  activityAgeMs?: number | null;
  activityFresh?: boolean;
  currentTask?: string | null;
  displayName?: string | null;
  role?: string | null;
  runtime?: string | null;
  [field: string]: unknown;
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

/** Does this record carry every field the commands read? */
function isPresenceRecord(value: unknown): value is PresenceRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.presenceStatus === "string" &&
    typeof r.lastHeartbeatAt === "number" &&
    Number.isFinite(r.lastHeartbeatAt) &&
    typeof r.activity === "string"
  );
}

/** Read the office-wide Presence roster; see the module doc. */
export async function readPresence(opts: PresenceReadOpts): Promise<PresenceRead> {
  const path = "/Presence";
  const auth = opts.sign("GET", path);
  let res: Response;
  try {
    res = await fetch(`${opts.flairUrl}${path}`, auth ? { headers: { Authorization: auth } } : {});
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
  if (!body.every(isPresenceRecord)) return { status: "unavailable", reason: "malformed response (a presence record lacks a field the command reads)" };
  return { status: "ok", agents: body };
}

/** The per-agent presence state both commands print and emit as JSON. */
export type PresenceState = "ok" | "unavailable";

export function presenceState(read: PresenceRead): PresenceState {
  return read.status === "ok" ? "ok" : "unavailable";
}

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
