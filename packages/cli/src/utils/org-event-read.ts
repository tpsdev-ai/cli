/**
 * org-event-read.ts — the validated OrgEvent catch-up read behind
 * `FlairClient.getEventsSince`: the task loop, `tps agent logs`, `tps status`
 * and the agent boot context read through it (cli#606, cli#620, cli#624). The
 * dashboard and office status read Presence instead (presence-read.ts, cli#622).
 *
 * `GET /OrgEventCatchup/<viewer>` is the viewer's catch-up feed in Flair: the
 * events addressed to the viewer or broadcast, after the viewer's acknowledged
 * position when it has one, created at or after the `since` floor. Flair
 * answers one page at a time, in position order (oldest first), as an object
 * `{ events, nextAfter, hasMore, ... }`, and refuses a `since` it cannot parse
 * with HTTP 400. A GET acknowledges nothing.
 *
 * `readOrgEvents` sends `since` as a plain ISO timestamp (and the `after`
 * resume cursor when the caller has one), signs each page request with the
 * caller's signer, validates each page (`parsePage` below lists the checks;
 * event fields other than the ones `isEvent` names pass through unchecked),
 * and follows `nextAfter` while `hasMore`, for at most `maxPages` pages. A page
 * that fails a check makes the whole read `unavailable`; no event from the read
 * is returned. The result is either
 *
 *   - `ok`, with the events in feed order, the `nextAfter` position to resume
 *     from, the server's time from the last response's `Date` header when it
 *     has a valid one, and `complete: false` when the page bound stopped the
 *     read before the feed was drained (the newest events are the ones not
 *     read), or
 *   - `unavailable`, with a bounded reason: the HTTP status, a fixed note
 *     naming the malformed part of the response, a fixed note for a `since`
 *     that is not a valid date, or the code or class of the error a rejected
 *     request or a failed signing raised. The reason never includes the
 *     response body or an error message.
 *
 * `readOrgEvents` does not throw for any of those failures: a signer that
 * throws (an unreadable key, say) is reported as `unavailable`.
 */

/** An OrgEvent as the readers consume it; `isEvent` validates these fields. */
export interface OrgEventRecord {
  id: string;
  kind: string;
  authorId: string;
  summary: string;
  createdAt: string;
  targetIds?: string[] | null;
  refId?: string | null;
  detail?: string | null;
  scope?: string | null;
  expiresAt?: string | null;
  /** The event's feed position, `<createdAt>\t<id>`, as Flair sends it. */
  position: string;
  [field: string]: unknown;
}

export type OrgEventRead =
  | {
      status: "ok";
      events: OrgEventRecord[];
      complete: boolean;
      nextAfter: string;
      /** The server's time (ISO) from the last response's `Date` header, when it had a valid one. */
      serverTime?: string;
    }
  | { status: "unavailable"; reason: string };

/** Signs a Flair request: the Authorization header value, or undefined to send none. */
export type FlairRequestSigner = (method: string, path: string) => string | undefined;

/** Events requested per page (Flair caps a page at 500). */
export const ORG_EVENT_PAGE_SIZE = 200;
/** Pages read before the result is marked incomplete. */
export const ORG_EVENT_MAX_PAGES = 10;

export interface OrgEventReadOpts {
  flairUrl: string;
  viewerId: string;
  /** The createdAt floor. */
  since: Date;
  /** Resume cursor (Flair's `after` position); reads after it instead of the viewer's watermark. */
  after?: string;
  sign: FlairRequestSigner;
  pageSize?: number;
  maxPages?: number;
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

/** Absent, null, or a string. */
const optionalString = (v: unknown) => v === undefined || v === null || typeof v === "string";

/**
 * Whether `value` is an event whose consumed fields are well-formed: the
 * required `id` (a non-empty string), `kind`, `authorId` and `summary`
 * (strings), `createdAt` (a parseable date) and `position` (a string;
 * `parsePage` checks its value); and the optional `targetIds`, which may be
 * absent or null and is otherwise an array of strings, and `refId`, `detail`,
 * `scope` and `expiresAt`, which may be absent or null and are otherwise
 * strings. These are the fields `tps agent logs`, the task loop and its
 * handlers read. Any other field is passed through unchecked.
 */
function isEvent(value: unknown): value is OrgEventRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    e.id !== "" &&
    typeof e.kind === "string" &&
    typeof e.authorId === "string" &&
    typeof e.summary === "string" &&
    typeof e.createdAt === "string" &&
    !Number.isNaN(Date.parse(e.createdAt)) &&
    (e.targetIds === undefined ||
      e.targetIds === null ||
      (Array.isArray(e.targetIds) && e.targetIds.every((t) => typeof t === "string"))) &&
    optionalString(e.refId) &&
    optionalString(e.detail) &&
    optionalString(e.scope) &&
    optionalString(e.expiresAt) &&
    typeof e.position === "string"
  );
}

/**
 * The page's events and cursor, or the fixed note naming what is malformed.
 * `requestAfter` is the `after` cursor the page was requested with, if any.
 * A page is well-formed when:
 *   - it is an object whose `events` is an array of events (`isEvent`), whose
 *     `hasMore` is a boolean, and whose `nextAfter` is a non-empty string;
 *   - each event's `position` is `<createdAt>\t<id>`;
 *   - the positions increase strictly, the first one after `requestAfter`;
 *   - `nextAfter` is the last event's position or, on a page with no events,
 *     `requestAfter` itself (Flair's paging; unchecked when no `after` was sent,
 *     since the server then chose the cursor itself).
 * Positions compare as strings, as Flair compares them.
 */
function parsePage(
  body: unknown,
  requestAfter: string | undefined,
): { events: OrgEventRecord[]; hasMore: boolean; nextAfter: string } | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "not an object";
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.events)) return "events is not an array";
  if (!page.events.every(isEvent)) return "an event lacks a field the command reads";
  const events = page.events as OrgEventRecord[];
  if (typeof page.hasMore !== "boolean") return "hasMore is not a boolean";
  if (typeof page.nextAfter !== "string" || page.nextAfter === "") return "nextAfter is missing";
  const nextAfter = page.nextAfter;
  let previous = requestAfter;
  for (const event of events) {
    if (event.position !== `${event.createdAt}\t${event.id}`) return "an event's position is not its createdAt and id";
    if (previous !== undefined && !(event.position > previous)) return "events are not in position order after the cursor";
    previous = event.position;
  }
  const last = events.at(-1);
  if (last !== undefined && nextAfter !== last.position) return "nextAfter is not the last event's position";
  if (last === undefined && requestAfter !== undefined && nextAfter !== requestAfter)
    return "nextAfter of an empty page is not the request's cursor";
  return { events, hasMore: page.hasMore, nextAfter };
}

/** The ISO time a response's `Date` header gives, or undefined when it has none or it does not parse. */
function responseTime(res: Response): string | undefined {
  const header = res.headers.get("date");
  const ms = header ? Date.parse(header) : Number.NaN;
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Read the viewer's OrgEvent catch-up feed since `since`; see the module doc. */
export async function readOrgEvents(opts: OrgEventReadOpts): Promise<OrgEventRead> {
  const pageSize = opts.pageSize ?? ORG_EVENT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? ORG_EVENT_MAX_PAGES;
  const base = `/OrgEventCatchup/${encodeURIComponent(opts.viewerId)}`;
  if (!(opts.since instanceof Date) || Number.isNaN(opts.since.getTime()))
    return { status: "unavailable", reason: "invalid since (not a valid date)" };
  const since = opts.since.toISOString();
  const events: OrgEventRecord[] = [];
  let after: string | undefined = opts.after;
  let serverTime: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ since, limit: String(pageSize) });
    if (after !== undefined) params.set("after", after);
    const path = `${base}?${params.toString()}`;
    let auth: string | undefined;
    try {
      auth = opts.sign("GET", path);
    } catch (err) {
      // The signer's message can name a key path; only its code or class is reported.
      return { status: "unavailable", reason: `request not signed (${errorTag(err)})` };
    }
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
    const parsed = parsePage(body, after);
    if (typeof parsed === "string") return { status: "unavailable", reason: `malformed response (${parsed})` };
    events.push(...parsed.events);
    after = parsed.nextAfter;
    serverTime = responseTime(res);
    if (!parsed.hasMore) return ok(events, true, parsed.nextAfter, serverTime);
  }
  return ok(events, false, after ?? "", serverTime);
}

function ok(events: OrgEventRecord[], complete: boolean, nextAfter: string, serverTime: string | undefined): OrgEventRead {
  return serverTime === undefined
    ? { status: "ok", events, complete, nextAfter }
    : { status: "ok", events, complete, nextAfter, serverTime };
}
