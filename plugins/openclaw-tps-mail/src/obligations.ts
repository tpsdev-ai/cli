/**
 * obligations.ts — the durable reply-OBLIGATION store for the tps-mail plugin
 * (slice S2 of cli#392's follow-up).
 *
 * INVARIANT (I1): a success ack requires a committed final-reply receipt for
 * THIS inbound; yield is pending; failure is durably named with an explicit
 * disposition; exactly one obligation-discharging post per inbound (an agent's
 * own explicit mails may coincide — they never discharge).
 *
 * One JSON record per inbound lives under the agent's maildir at
 * `<mailDir>/<agent>/.obligations/<inboundId>.json`. The record is the durable
 * truth behind the ack: the ack transition is keyed on a RECEIPT for THIS
 * obligation — never on the fact that a dispatch settled.
 *
 * LIFECYCLE (cli#389 round 8). The record carries what the DELIVERY has done,
 * durably, so a restart reads the same truth as the turn did:
 *
 *   pending ──yield/deadline armed──▶ yielded
 *   pending/yielded ──write-ahead, BEFORE the delivery call──▶ delivering
 *   delivering ──the delivery call RETURNED──▶ posted
 *   posted/delivering ──receipt or sandbox evidence──▶ acked
 *   delivering/posted ──deadline, no evidence, no verdict──▶ unconfirmed
 *   any live state ──definitive non-delivery verdict──▶ failed
 *
 * `delivering` is a WRITE-AHEAD marker: it is persisted before the delivery call
 * so a crash mid-delivery is distinguishable from a crash before it, and
 * `posted` is persisted the moment the call returns. A definitive non-delivery
 * verdict (an explicit delivery rejection, a failed delivery call, or the drain
 * quarantining THIS reply's own record) fails the obligation even from
 * `delivering`/`posted`; with no verdict, a committed record at its deadline
 * becomes `unconfirmed` — never `failed`, because non-delivery cannot be proven
 * and the sender is never told a delivered reply failed.
 *
 * RECEIPTS (cli#389 round 3; PER-AGENT since round 5). A receipt is EITHER the
 * posted record that carries this obligation's `X-TPS-Obligation` marker (a
 * local maildir file, or the outbox record the branch drains) OR — for a route
 * that leaves no locally readable mail file — the small metadata-only receipt
 * `index.ts` persists at `<mailDir>/<agent>/.obligations/receipts/
 * <obligationId>.json`, INSIDE the replying agent's own obligation store. The
 * metadata receipt names the obligation, the reply and the inbound it answers
 * (`replyId`, `obligationId`, `replyToId`), its `route` (+ `branchId`) and
 * `ts` — never the body. The scan accepts a receipt ONLY when BOTH the
 * obligation id and the inbound it answers match, so a reused obligation id can
 * never be satisfied by an old receipt. It reads the metadata receipt by its
 * direct path and falls back to the marker scan for the posted-file case — and
 * the two are SEPARATE inputs: a receipts dir is never listed, only the route's
 * posted-record dirs are.
 *
 * WHY PER-AGENT (cli#389 round 5). Receipts used to live in ONE host-wide
 * directory, but obligations live in per-agent stores and a sweep can only see
 * its own agent's obligations — so no shared-directory rule could be safe: a
 * rule keyed on the inbound let a terminal obligation delete another agent's
 * receipt, and a per-agent live guard could hold another agent's aged receipt
 * forever. A receipt now lives with the obligation that owes it, so the sweep
 * owns exactly its own receipts and keys them on the obligation id, a unique
 * UUID (see sweepTerminalObligations).
 *
 * RETENTION (cli#401): records are swept at startup recovery. Only TERMINAL
 * records (acked/unconfirmed/failed) whose LAST TRANSITION is older than the
 * window are deleted; pending/delivering/posted/yielded are never touched. A
 * replayed inbound id whose
 * record was swept opens a FRESH obligation — accepted, because relay retries
 * arrive within minutes or hours, never the window later. The same sweep owns
 * the metadata receipts (cli#389 round 3), which since round 5 live in the
 * agent's OWN store, so every receipt it sees belongs to an obligation it can
 * look up: a live obligation keeps its receipt, a terminal obligation's receipt
 * goes, and a receipt with NO obligation left in the store goes once it has
 * aged past the window (an orphan). See sweepTerminalObligations.
 *
 * This module is deliberately pure of the plugin's runtime plumbing: it reads
 * and writes records and scans directories. The timer/arming and the dispatch
 * wiring live in index.ts.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

export type ObligationState =
  | "pending"
  | "yielded"
  | "delivering"
  | "posted"
  | "acked"
  | "unconfirmed"
  | "failed";

/**
 * Final states: nothing after them, never resurrected. `unconfirmed` is terminal
 * too (cli#389 round 8): a committed obligation whose evidence never arrived is
 * DONE — it is not failed (non-delivery cannot be proven), and it is not acked.
 */
export const TERMINAL_STATES: ReadonlySet<ObligationState> = new Set(["acked", "unconfirmed", "failed"]);

export interface ObligationRecord {
  obligationId: string;
  /** The mail file id this obligation is keyed on (the plugin's MessageSid). */
  inboundId: string;
  inboundTimestamp: string;
  /** The VERIFIED sender — the value promote() overwrote/wrote. */
  from: string;
  /** The agent that owes the reply. */
  to: string;
  accountId: string;
  state: ObligationState;
  /** ISO deadline armed at the yield transition; null while pending. */
  deadlineAt: string | null;
  attempts: number;
  /** Named reason for a non-ack terminal state: the failure when the delivery
   *  was proven not to have happened (`failed`), or WHY the obligation could
   *  not be resolved either way (`unconfirmed`). Never set on a live record. */
  failure?: string;
  /** ISO time of the LAST state transition (create counts as the pending
   *  transition). The retention sweep ages a terminal record by THIS, falling
   *  back to `inboundTimestamp` for records written before this field existed —
   *  never the file mtime. See sweepTerminalObligations. */
  lastTransitionAt?: string;
  /** The id of the reply this obligation was discharged by, recorded at the
   *  `posted` transition (cli#389 round 6). The receipt scan pins a receipt's
   *  `replyId` to THIS when the record knows it, so a body copied from an older
   *  reply under the CURRENT obligation id and inbound id does not satisfy the
   *  obligation. Absent until the obligation is posted (and absent on records
   *  written before the field existed) — when absent there is nothing to pin. */
  replyId?: string;
  /** cli#389 round 10, item 1: the nack mail is OWED for this settled failure.
   *  Written in the SAME transition that sets `failed`, and CLEARED when
   *  `nackSentAt` records that the mail was handed to its route — so the durable
   *  record, never the cur/ `nackedAt` stamp, says whether the sender has been
   *  told. Only ever present on a `failed` record; absent once the send landed. */
  nackPending?: boolean;
  /** cli#389 round 10, item 1: ISO time the nack mail was handed to its route.
   *  AT-LEAST-ONCE: a crash after the hand-off but before this is written
   *  retries delivery, so the sender may see the nack twice, and the record keeps
   *  `nackPending` until a hand-off is recorded — the debt outlives a crash,
   *  never the other way round. */
  nackSentAt?: string;
  /** cli#389 round 13, item 2: ISO time an owed nack was ABANDONED — the debt
   *  was given up because the record sat past the hold window and the sender
   *  still had no route. The abandonment CLEARS `nackPending` in the same write
   *  (like `markNackSent` clears it on a hand-off), so it happens ONCE and the
   *  startup retry no longer fires for that record. */
  nackAbandonedAt?: string;
}

export interface ObligationLog {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export function obligationsDir(mailDir: string, agent: string): string {
  return resolve(mailDir, agent, ".obligations");
}

export function obligationPath(mailDir: string, agent: string, inboundId: string): string {
  return resolve(obligationsDir(mailDir, agent), `${inboundId}.json`);
}

export function readObligation(mailDir: string, agent: string, inboundId: string): ObligationRecord | null {
  const p = obligationPath(mailDir, agent, inboundId);
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ObligationRecord;
  } catch {
    return null;
  }
}

export function listObligations(mailDir: string, agent: string): ObligationRecord[] {
  const dir = obligationsDir(mailDir, agent);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ObligationRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    try {
      out.push(JSON.parse(readFileSync(resolve(dir, name), "utf-8")) as ObligationRecord);
    } catch {
      // A torn record is not readable truth; skip it rather than crash recovery.
    }
  }
  return out;
}

/** Atomic write: stage to a dot temp in the same dir, then rename into place. */
export function writeObligation(mailDir: string, agent: string, record: ObligationRecord): void {
  const dir = obligationsDir(mailDir, agent);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${record.inboundId}.json`);
  const tmp = resolve(dir, `.${record.inboundId}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
  renameSync(tmp, target);
}

/**
 * Create the obligation for an inbound. KEYED ON inboundId: a second create for
 * the same inbound is a NO-OP (logged) and returns the existing record — a
 * replayed inbound must never open a second obligation.
 */
export function createObligation(
  mailDir: string,
  agent: string,
  make: () => ObligationRecord,
  log?: ObligationLog,
): { created: boolean; record: ObligationRecord } {
  const draft = make();
  const existing = readObligation(mailDir, agent, draft.inboundId);
  if (existing) {
    log?.info?.(
      `tps-mail: obligation for inbound ${draft.inboundId} already exists (${existing.obligationId}); not creating a second`,
    );
    return { created: false, record: existing };
  }
  draft.lastTransitionAt = draft.lastTransitionAt ?? new Date().toISOString();
  writeObligation(mailDir, agent, draft);
  return { created: true, record: draft };
}

/**
 * One-way transition. A late event after a TERMINAL state (acked/unconfirmed/
 * failed) is a NO-OP, logged — never a state resurrection. Transitions do not
 * enforce a strict order among non-terminal states (pending → posted → acked is
 * the happy path; pending → yielded → failed is the yield path), but terminal is
 * final.
 *
 * Returns the UPDATED record, or `null` when the record is GONE **or the
 * transition was REFUSED** because the record is already terminal (cli#389 round
 * 9, item 4). A refusal must be distinguishable from a landing: a caller that
 * needs to act on "this transition did not happen" (markDelivering, before a
 * delivery call) may never be handed the old record as though it were the result.
 */
export function transitionObligation(
  mailDir: string,
  agent: string,
  inboundId: string,
  next: ObligationState,
  patch: Partial<ObligationRecord> = {},
  log?: ObligationLog,
): ObligationRecord | null {
  const current = readObligation(mailDir, agent, inboundId);
  if (!current) return null;
  if (TERMINAL_STATES.has(current.state)) {
    log?.info?.(
      `tps-mail: obligation ${current.obligationId} is ${current.state}; refusing the late transition to ${next}`,
    );
    return null;
  }
  const updated: ObligationRecord = { ...current, ...patch, state: next, lastTransitionAt: new Date().toISOString() };
  writeObligation(mailDir, agent, updated);
  return updated;
}

/**
 * cli#389 round 10, item 1: a settled failure whose nack mail is STILL OWED —
 * the durable shape a crash between settling the failure and sending its nack
 * (or a send that could not be delivered) leaves behind. Restart recovery
 * retries delivery for exactly these records and no others. A record written
 * before these fields existed carries no `nackPending`, so it is never retried
 * on a guess about a mail the plugin cannot prove was owed.
 */
export function nackOwed(record: unknown): boolean {
  const r = record as ObligationRecord | null;
  return r?.state === "failed" && r?.nackPending === true && !r?.nackSentAt;
}

/**
 * cli#389 round 10, item 1: record that the nack mail for a settled failure was
 * handed to its route, and CLEAR the pending flag in the same write.
 *
 * The record is TERMINAL (`failed`) here, so this is NOT a state transition and
 * `transitionObligation` — which refuses everything after a terminal state —
 * would refuse it; this patches the two nack fields only, keeping the record's
 * state and every other field exactly as they are.
 *
 * Best-effort by design: a store that cannot be written leaves `nackPending`
 * set, so a later start retries delivery of the mail (at-least-once). Returns
 * true when the write landed.
 *
 * cli#389 round 11, item 2: a FAILED write is not silent. The mail may already
 * have left, but the record still owes it, so the next start may send it again
 * — logged BY NAME (the inbound the record belongs to) so an operator can see
 * which mail may repeat.
 */
export function markNackSent(
  mailDir: string,
  agent: string,
  inboundId: string,
  log?: ObligationLog,
  when?: string,
): boolean {
  const current = readObligation(mailDir, agent, inboundId);
  if (!current || current.state !== "failed") return false;
  const { nackPending: _clear, ...rest } = current;
  try {
    writeObligation(mailDir, agent, { ...rest, nackSentAt: when ?? new Date().toISOString() });
    return true;
  } catch (err) {
    log?.warn?.(
      `tps-mail: obligation-write-failed: could not record nackSentAt for ${inboundId} ` +
        `(${err instanceof Error ? err.message : String(err)}); the record keeps nackPending, so a later start may send the nack again`,
    );
    return false;
  }
}

/**
 * cli#389 round 13, item 2: GIVE UP an owed nack — the record sat past the hold
 * window and the sender still had no route. Clears `nackPending` and records
 * `nackAbandonedAt` in the same write, so the debt is RELEASED: `nackOwed`
 * becomes false, the sweep no longer abandons (and logs) it on every pass, and
 * the startup retry stops for that record. Unlike `markNackSent` this is not a
 * hand-off — nothing was delivered — so the record keeps its OWN
 * `lastTransitionAt` and ages out by normal retention from there.
 *
 * Best-effort by design: a store that cannot be written leaves `nackPending`
 * set, so a later sweep abandons it again (logged by name). Returns true when
 * the write landed.
 */
export function abandonOwedNack(
  mailDir: string,
  agent: string,
  inboundId: string,
  log?: ObligationLog,
  when?: string,
): boolean {
  const current = readObligation(mailDir, agent, inboundId);
  if (!current || current.state !== "failed") return false;
  const { nackPending: _cleared, ...rest } = current;
  try {
    writeObligation(mailDir, agent, { ...rest, nackAbandonedAt: when ?? new Date().toISOString() });
    return true;
  } catch (err) {
    log?.warn?.(
      `tps-mail: obligation-write-failed: could not record the nack abandonment for ${inboundId} ` +
        `(${err instanceof Error ? err.message : String(err)}); the record keeps nackPending, so a later sweep will abandon it again`,
    );
    return false;
  }
}

// ── retention ────────────────────────────────────────────────────────────────

/** How many `retentionDays` the owed-nack hold spans before the debt is
 *  abandoned (cli#389 round 12, item 2). A caller may override it per sweep. */
export const DEFAULT_NACK_HOLD_MULTIPLE = 4;

export interface RetentionResult {
  removed: number;
  left: number;
  unreadable: number;
  /** Terminal records held back because their cur/ record is still unresolved. */
  heldForRecovery: number;
  /** Terminal records held back because their nack mail is still OWED —
   *  `nackPending` with no `nackSentAt` — and still INSIDE the hold window:
   *  startup retries delivery from that record (cli#389 round 11, item 1;
   *  bounded by age since round 12, item 2). */
  heldForNack: number;
  /** Terminal records whose owed nack was ABANDONED this pass — the debt sat
   *  past the hold window — and were handed back to normal retention
   *  (cli#389 round 12, item 2). Logged once, by name, as `nack-abandoned`. */
  abandonedForNack: number;
  /** Metadata receipts removed (a terminal obligation, or an aged orphan). */
  receiptsRemoved: number;
  /** Metadata receipts left in place because they could not be read. */
  receiptsUnreadable: number;
  /** Metadata receipts that LOOKED orphaned (no obligation in the store) but
   *  were LEFT this pass because an obligation record could not be read: with
   *  the store partly unreadable, "no obligation here" is not proof that the
   *  obligation is gone (cli#389 round 6, item 3). */
  orphanReceiptsSkipped: number;
  disabled: boolean;
}

/** Every recognized state — a record whose `state` is not one of these is a
 *  malformed shape (reported as unreadable, never swept). */
const ALL_STATES: ReadonlySet<string> = new Set([
  "pending",
  "yielded",
  "delivering",
  "posted",
  "acked",
  "unconfirmed",
  "failed",
]);

/** True when the agent's cur/ record for this inbound is still UNRESOLVED
 *  (present without ackedAt/nackedAt). Startup recovery may re-dispatch it, so
 *  its obligation must not be swept yet — a crash between ackObligation's
 *  `acked` transition and the cur/ `ackedAt` patch leaves exactly this shape. */
function curRecordUnresolved(mailDir: string, agent: string, inboundId: string): boolean {
  const p = resolve(mailDir, agent, "cur", `${inboundId}.json`);
  try {
    const rec = JSON.parse(readFileSync(p, "utf-8"));
    return !rec?.ackedAt && !rec?.nackedAt;
  } catch {
    return false; // absent/unreadable: nothing recovery can re-drive
  }
}

/** The record's OWN recorded last-transition time in ms. `lastTransitionAt`
 *  when present AND parseable; when the field is ABSENT (a record written
 *  before the field existed) it falls back to `inboundTimestamp`. When the
 *  field is PRESENT but unusable (a non-string, or a string that does not
 *  parse) it returns null — the record is UNAGEABLE and must be retained, never
 *  aged by the sender-supplied inbound timestamp. Never the file mtime. */
export function obligationLastTransitionMs(record: unknown): number | null {
  const r = record as Record<string, unknown> | null;
  const raw = r?.lastTransitionAt;
  if (raw !== undefined && raw !== null) {
    if (typeof raw === "string") {
      const t = Date.parse(raw);
      return Number.isFinite(t) ? t : null; // present but unparseable → unageable
    }
    return null; // present but not a timestamp → unageable
  }
  // ABSENT → a record written before lastTransitionAt existed → inboundTimestamp.
  const v = r?.inboundTimestamp;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Sweep the agent's obligation store: DELETE only TERMINAL records (acked,
 * unconfirmed, failed) whose LAST TRANSITION is older than `retentionDays`.
 * NEVER pending / delivering / posted / yielded, at any age — restart recovery
 * reads those.
 *
 * Ages a record by its OWN recorded timestamp (`lastTransitionAt`, else
 * `inboundTimestamp`), never the file mtime. Safe + best-effort: an
 * unreadable/malformed record (or one whose timestamp cannot be parsed) is LEFT
 * and logged ONCE; a deletion failure is logged and never blocks startup.
 * `retentionDays <= 0` disables the sweep.
 *
 * A terminal record still OWING ITS NACK MAIL (`nackPending` with no
 * `nackSentAt`) is HELD while it is INSIDE the hold window, like a terminal
 * record whose cur/ record is unresolved (cli#389 round 11, item 1): startup
 * retries delivery from that record, so sweeping it would erase the only
 * durable evidence that the sender is owed a mail. Once the debt is discharged
 * (`nackSentAt` recorded, flag cleared) the record is ordinary and ages out
 * normally.
 *
 * cli#389 round 12, item 2: that hold is BOUNDED by AGE — `nackHoldDays`, a
 * configurable multiple of `retentionDays` (default `DEFAULT_NACK_HOLD_MULTIPLE`)
 * — so a sender that never gets a route cannot pin one record per affected
 * inbound forever. Past the bound the debt is ABANDONED: logged `nack-abandoned`,
 * ONCE, by name (the record's file name), and normal retention then applies.
 *
 * The same sweep owns the agent's metadata RECEIPTS (cli#389 round 3), which
 * live in this store as `receipts/<obligationId>.json` (round 5): a live
 * obligation keeps its receipt, a terminal obligation's receipt goes, and an
 * orphan (no obligation in the store) goes once it has aged past the window.
 *
 * REPLAY AFTER A SWEEP (accepted, pinned by a test): a replayed inbound whose
 * record was swept opens a FRESH obligation — relay retries arrive within
 * minutes or hours, never `retentionDays` later.
 */
export function sweepTerminalObligations(
  mailDir: string,
  agent: string,
  retentionDays: number,
  log?: ObligationLog,
  nowMs: number = Date.now(),
  nackHoldDays: number = retentionDays * DEFAULT_NACK_HOLD_MULTIPLE,
): RetentionResult {
  const res: RetentionResult = {
    removed: 0,
    left: 0,
    unreadable: 0,
    heldForRecovery: 0,
    heldForNack: 0,
    abandonedForNack: 0,
    receiptsRemoved: 0,
    receiptsUnreadable: 0,
    orphanReceiptsSkipped: 0,
    disabled: false,
  };
  if (!(retentionDays > 0)) {
    res.disabled = true;
    return res;
  }
  const dir = obligationsDir(mailDir, agent);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch (err) {
    // Only ENOENT means "no store yet" — and even then the RECEIPTS sweep below
    // must still run (a freshly seeded tree can hold receipts for a replayed
    // inbound). Any other error (EACCES, ENOTDIR…) is reported, never silently
    // read as an empty successful sweep, and stops the sweep: with the store
    // unreadable the agent's own receipts cannot be attributed either.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      log?.warn?.(
        `tps-mail: obligation retention: could not read ${dir}: ${err instanceof Error ? err.message : String(err)}; sweep skipped`,
      );
      return res;
    }
  }
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const leftUnreadable: string[] = [];
  // WHICH OBLIGATIONS THE STORE HELD at the START of this sweep, by state. The
  // obligation loop below DELETES aged terminal records, so "is this receipt's
  // obligation live, terminal, or gone?" must be answered from a snapshot taken
  // first — else the receipt of the very record just swept looks orphaned.
  //
  // cli#389 round 5: the snapshot is keyed by the OBLIGATION ID, which is a
  // unique UUID, and the receipts live in this same store — so every receipt is
  // attributable to an obligation this sweep can see. There is no host-wide dir
  // to be careful of, and no inbound for two obligations to collide on.
  const terminalObligationIds = new Set<string>();
  const liveObligationIds = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const path = resolve(dir, name);
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      res.unreadable++;
      leftUnreadable.push(name);
      continue;
    }
    // Shape check: a parseable value that is not an object with a RECOGNIZED
    // state (null, no state, an unknown state) is a malformed record, not a
    // non-terminal one — reported as unreadable, never swept.
    const state = (record as { state?: unknown } | null)?.state;
    if (typeof record !== "object" || record === null || Array.isArray(record) || typeof state !== "string" || !ALL_STATES.has(state)) {
      res.unreadable++;
      leftUnreadable.push(name);
      continue;
    }
    if (!TERMINAL_STATES.has(state as ObligationState)) {
      const liveObligationId = (record as { obligationId?: unknown }).obligationId;
      if (typeof liveObligationId === "string") liveObligationIds.add(liveObligationId);
      res.left++; // pending / delivering / posted / yielded are never deletable
      continue;
    }
    const snapshotObligationId = (record as { obligationId?: unknown }).obligationId;
    if (typeof snapshotObligationId === "string") terminalObligationIds.add(snapshotObligationId);
    // cli#389 round 11, item 1: a record still OWING its nack mail is not
    // deletable while it is INSIDE the hold window — startup retries delivery
    // from this exact shape (`nackPending` with no `nackSentAt`), so sweeping it
    // would erase the only durable evidence that the sender is still owed a
    // mail. cli#389 round 12, item 2: past the bound the debt is ABANDONED —
    // logged once, by name — and normal retention applies to the record.
    if (nackOwed(record)) {
      const owedSince = obligationLastTransitionMs(record);
      const nackCutoff = nowMs - nackHoldDays * 24 * 60 * 60 * 1000;
      if (owedSince === null || owedSince >= nackCutoff) {
        // Unknown age, or still inside the hold: keep it. (An unageable record is
        // retained on principle elsewhere too, never aged by a guess.)
        res.heldForNack++;
        continue;
      }
      res.abandonedForNack++;
      // cli#389 round 13, item 2: RELEASE the debt in the same pass that gives up
      // on it — clear `nackPending` and record `nackAbandonedAt`. Without the
      // clear, a record retention then KEEPS would be abandoned and logged
      // again on every sweep, and the startup retry would keep firing for a debt
      // nobody is going to pay. Best-effort: an unwritable store keeps
      // `nackPending`, so a later sweep abandons it again.
      const recInbound = (record as { inboundId?: unknown }).inboundId;
      const released = abandonOwedNack(
        mailDir,
        agent,
        typeof recInbound === "string" ? recInbound : name.replace(/\.json$/, ""),
        log,
        new Date(nowMs).toISOString(),
      );
      log?.warn?.(
        `tps-mail: nack-abandoned: ${name} has owed its nack past the hold window (${nackHoldDays} day(s)); ` +
          `the debt is released${released ? "" : " (the release could not be recorded, so a later sweep will abandon it again)"} ` +
          `and normal retention applies to the record`,
      );
      // fall through to the normal terminal-retention rules below
    }
    // A terminal record whose cur/ record is still unresolved is HELD until
    // startup recovery resolves it (else a re-dispatch would open a fresh
    // obligation and double-post).
    const inboundId = (record as { inboundId?: unknown }).inboundId;
    if (typeof inboundId === "string" && curRecordUnresolved(mailDir, agent, inboundId)) {
      res.heldForRecovery++;
      continue;
    }
    const t = obligationLastTransitionMs(record);
    if (t === null) {
      res.unreadable++;
      leftUnreadable.push(name);
      continue;
    }
    if (t >= cutoff) {
      res.left++;
      continue;
    }
    try {
      unlinkSync(path);
      res.removed++;
    } catch (err) {
      log?.warn?.(
        `tps-mail: obligation retention: could not delete ${name}: ${err instanceof Error ? err.message : String(err)}; left in place`,
      );
      res.left++;
    }
  }
  // ── the metadata receipts (cli#389 round 3; per-agent since round 5) ───────
  // Nothing else ever removes a receipt, so this sweep owns them. They live in
  // THIS agent's own store, so each one names an obligation this sweep can look
  // up, and three rules cover every case:
  //   - its obligation is LIVE here → keep (an unfinished obligation has not
  //     finished with the evidence its ack depends on);
  //   - its obligation is TERMINAL here → delete (it has served its purpose;
  //     decided from the snapshot above, so the receipt of the record deleted
  //     moments ago is still attributed);
  //   - NO obligation here at all → an orphan: delete once it has aged past the
  //     window, and never before. A receipt with no readable timestamp is never
  //     aged by a missing value, exactly like an obligation record.
  //   - EXCEPT when an obligation record in the store could not be read: such a
  //     record contributes no id to either set, so its own receipt would look
  //     orphaned and be deleted, and repairing the record later would find its
  //     evidence gone. With ANY unreadable record, NO orphan is deleted this
  //     pass (the terminal rule above still applies — that evidence is not in
  //     doubt) and the skip is counted (cli#389 round 6, item 3).
  const receiptsRoot = receiptsDir(mailDir, agent);
  let receiptNames: string[];
  try {
    receiptNames = readdirSync(receiptsRoot);
  } catch {
    // No receipts directory yet (nothing was ever delivered non-locally): done.
    receiptNames = [];
  }
  for (const name of receiptNames) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const path = resolve(receiptsRoot, name);
    let receipt: unknown;
    try {
      receipt = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      res.receiptsUnreadable++;
      continue;
    }
    const obligationId = (receipt as { obligationId?: unknown } | null)?.obligationId;
    const ts = (receipt as { ts?: unknown } | null)?.ts;
    // The obligation id is the whole key (cli#389 round 5). A receipt that
    // names no obligation id cannot be attributed to one, so it is left in
    // place rather than aged out on a guess.
    if (typeof obligationId !== "string" || obligationId.length === 0) continue;
    const terminal = terminalObligationIds.has(obligationId);
    const live = liveObligationIds.has(obligationId);
    const t = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
    const agedOrphan = !live && Number.isFinite(t) && t < cutoff;
    // FAIL SAFE (cli#389 round 6, item 3): an obligation record that could not
    // be read joins neither set, so a receipt for THAT obligation looks
    // orphaned. Deleting it would destroy evidence a later repair needs, and
    // "no obligation here" is not proof while part of the store is unreadable.
    // The TERMINAL rule is unaffected: it is decided from a record this sweep
    // did read, so that evidence is not in doubt.
    if (agedOrphan && !terminal && res.unreadable > 0) {
      res.orphanReceiptsSkipped++;
      continue;
    }
    if (!terminal && !agedOrphan) continue;
    try {
      unlinkSync(path);
      res.receiptsRemoved++;
    } catch (err) {
      log?.warn?.(
        `tps-mail: obligation retention: could not delete receipt ${name}: ${err instanceof Error ? err.message : String(err)}; left in place`,
      );
    }
  }
  if (res.receiptsUnreadable > 0) {
    log?.warn?.(
      `tps-mail: obligation retention: left ${res.receiptsUnreadable} unreadable receipt(s) in place (never deleted)`,
    );
  }
  if (res.orphanReceiptsSkipped > 0) {
    log?.warn?.(
      `tps-mail: obligation retention: left ${res.orphanReceiptsSkipped} aged receipt(s) in place — ` +
        `${res.unreadable} unreadable/malformed record(s) in the store make an orphan unprovable this pass`,
    );
  }

  // Logged ONCE: a single line for the unreadable/malformed records we left.
  if (leftUnreadable.length > 0) {
    log?.warn?.(
      `tps-mail: obligation retention: left ${leftUnreadable.length} unreadable/malformed record(s) in place (never deleted): ${leftUnreadable.join(", ")}`,
    );
  }
  log?.info?.(
    `tps-mail: obligation retention: removed ${res.removed} terminal record(s) older than ${retentionDays} day(s); kept ${res.left}` +
      (res.heldForRecovery > 0 ? `; held ${res.heldForRecovery} for unresolved cur/ recovery` : "") +
      (res.heldForNack > 0 ? `; held ${res.heldForNack} still owing their nack mail` : "") +
      (res.abandonedForNack > 0 ? `; abandoned ${res.abandonedForNack} owed nack(s) past the hold` : "") +
      (res.receiptsRemoved > 0 ? `; removed ${res.receiptsRemoved} receipt(s)` : "") +
      (res.orphanReceiptsSkipped > 0 ? `; held ${res.orphanReceiptsSkipped} receipt(s) (store partly unreadable)` : ""),
  );
  return res;
}

// ── receipts (cli#389 round 3) ───────────────────────────────────────────────

/**
 * What a metadata receipt carries — and, deliberately, what it does NOT: never
 * the body. A receipt is evidence that a delivery COMMITTED, not a copy of the
 * mail, so it stays small and holds nothing that could leak the reply.
 */
export interface ReceiptRecord {
  /** The delivered reply's own id. */
  replyId: string;
  /** The obligation this receipt discharges. */
  obligationId: string;
  /** The inbound the reply answers (the obligation's `inboundId`). */
  replyToId: string;
  /** local | outbox | remote-branch | bridge */
  route: string;
  branchId?: string;
  /** ISO time the receipt was written. */
  ts: string;
}

/**
 * The receipts dir INSIDE the agent's own obligation store (cli#389 round 5).
 * It is the replying agent's, not the host's: only the sweep for THIS agent
 * reads it, and every receipt in it belongs to an obligation in the store
 * beside it.
 */
export function receiptsDir(mailDir: string, agent: string): string {
  return resolve(obligationsDir(mailDir, agent), "receipts");
}

/** One receipt per obligation, keyed by the obligation id. */
export function receiptPath(mailDir: string, agent: string, obligationId: string): string {
  return resolve(receiptsDir(mailDir, agent), `${obligationId}.json`);
}

/**
 * Persist the metadata receipt for a successful NON-LOCAL delivery (cli#389
 * round 3) into the replying agent's own store (round 5). Atomic (a dot temp +
 * rename, so a concurrent scan never reads a half-written file) and 0600 AT
 * CREATION — the mode is set on the temp file, so the final name is never once
 * world/group-readable.
 */
export function writeReceipt(mailDir: string, agent: string, record: ReceiptRecord): string {
  const dir = receiptsDir(mailDir, agent);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${record.obligationId}.json`);
  const tmp = resolve(dir, `.${record.obligationId}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, target);
  return target;
}

// ── receipt scan ─────────────────────────────────────────────────────────────

export type ReceiptScan =
  | { status: "found"; path: string }
  | {
      status: "malformed";
      path: string;
      /** cli#389 round 8 — ATTRIBUTION: true when the quarantined record IS this
       *  reply's own (its name still carries the reply id this obligation knows),
       *  which makes it a DEFINITIVE non-delivery verdict. False when the
       *  quarantine cannot be tied to this reply — then it is not a verdict and
       *  the obligation resolves at its deadline. */
      ownRecord: boolean;
    }
  | { status: "absent" };

/**
 * The dirs a receipt scan may touch, SPLIT BY HOW IT MAY READ THEM (cli#389
 * round 4, item 1). Both receipt forms live in different places, and one of
 * them is a SHARED, ever-growing directory that must never be walked:
 *
 *   - `direct` — read ONLY by the direct `<obligationId>.json` path; NEVER
 *     listed. The agent's own receipts root belongs here: it accumulates a file
 *     per non-local delivery and nothing but the retention sweep ever removes
 *     one, so a listing would read and parse every retained receipt on every
 *     scan.
 *   - `posted` — LISTED for a posted record carrying the obligation marker.
 *     The marker names no path, so these dirs must be walked: the recipient
 *     maildir's `new`/`cur`, the bridge sandbox, the outbox the branch drains.
 */
export interface ReceiptScanDirs {
  direct: string[];
  posted: string[];
}

/**
 * The filesystem operations a receipt scan performs — injectable so a test can
 * PROVE which dirs a scan touches (cli#389 round 4, item 1): the shared receipts
 * dir must appear in NO `readdirSync` call. Default: the real fs.
 */
export interface ReceiptScanFs {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: "utf-8"): string;
}

const realFs: ReceiptScanFs = {
  existsSync: (path) => existsSync(path),
  readdirSync: (path) => readdirSync(path),
  readFileSync: (path, encoding) => readFileSync(path, encoding),
};

/** The sender an envelope body CLAIMS (its `.from`), or null when the body does
 *  not parse. A CLAIM, never a verified identity: nothing in this module checks
 *  a signature. */
export function envelopeFrom(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.from === "string" ? parsed.from : null;
  } catch {
    return null;
  }
}

/**
 * TWO receipt forms, ONE rule: a receipt must name THIS obligation, the inbound
 * it answers, and — when the obligation record knows it — the reply itself.
 *
 *   (1) METADATA (cli#389 round 3) — `<mailDir>/<agent>/.obligations/receipts/
 *       <obligationId>.json` (per-agent since round 5): the small record
 *       `writeReceipt` persists when a NON-LOCAL delivery commits (outbox,
 *       remote-branch, bridge). Read by its DIRECT path — never by parsing the
 *       directory (cli#389 round 4, item 1: it is the `direct` input, and a
 *       `direct` dir is never listed) — and accepted when `obligationId`
 *       matches, `replyToId` is the inbound this obligation is keyed on, and
 *       (g) holds.
 *   (2) POSTED FILE — the delivered reply record itself, which carries the
 *       marker this inbound minted. Scan the reply's destination directories
 *       (the `posted` input — the only dirs that are ever listed) for a record
 *       that carries ALL of:
 *   (a) `headers["X-TPS-Obligation"] === obligationId` — the marker this inbound
 *       minted;
 *   (b) `accountId === accountId` — the SAME account that owns the obligation;
 *   (c) `record.from === agent` — the recipient agent wrote it; and
 *   (d) `envelopeFrom(record.body) === agent` — the sender the wrapped envelope
 *       CLAIMS also names that agent (so a re-wrapped body cannot attribute the
 *       reply to someone else). That is a CLAIM about a string, never a
 *       verified signature — see "what this is not" below; and
 *   (e) `record.replyToId === replyToId` — the record ANSWERS this inbound, so a
 *       reused obligation id can never be satisfied by a reply to another one.
 *   OR (f) — the BRIDGE SANDBOX RECORD (cli#389 round 5, item 2): the reduced
 *       record `deliverToSandbox` writes, which carries the obligation ids when
 *       the caller supplies them (`record.obligationId === obligationId`,
 *       `record.replyToId === replyToId` and `record.replyId`), with the
 *       replying agent as `from` and, as the body, an envelope that CLAIMS that
 *       same agent. That record is what keeps a bridge delivery locally readable
 *       evidence when the metadata receipt above could not be written (a full
 *       disk, a permission error). It carries no headers and no `accountId` — so
 *       of the pins above it carries (c), (d), (e) and (g), and those are the
 *       ones checked.
 *
 *   (g) THE REPLY BINDING (cli#389 round 6, item 1): when the obligation record
 *       KNOWS the reply it was discharged by (`replyId`, recorded at the posted
 *       transition), a receipt must carry the same `replyId`. A body copied from
 *       an OLDER reply, re-labelled with the current obligation id and inbound
 *       id, then needs the current reply's id too. Only the forms that carry a
 *       reply id take part: the metadata receipt (1) and the bridge record (f).
 *       A posted marker record (2) is the delivered mail itself and names no
 *       separate reply id, so there is nothing to pin there.
 *
 * WHAT THIS IS NOT: the receipt is NOT signature-verified here, and this scan
 * does not claim it is. Verifying the body's envelope signature would not close
 * the gap on its own, for two reasons:
 *   1. the `X-TPS-Obligation` marker rides on the mail RECORD's headers, OUTSIDE
 *      the envelope a signature covers (index.ts sets it when it writes the
 *      reply; the signature covers `body` alone) — so verifying that signature
 *      would authenticate the TEXT but would not bind the receipt to THIS
 *      inbound;
 *   2. where agents share one OS user, another agent can read BOTH the
 *      obligation record and the signing keys, so no in-band check separates
 *      them — only an OS-level boundary does (tracked separately). The
 *      obligation id is not a secret in that model: a same-user reader simply
 *      reads it, so "unguessable" is not the defence.
 * So the scan pins IDENTITY (which agent, which account), the RELATIONSHIP
 * (which obligation, which inbound, which reply) and REACHABILITY (the record's
 * destination); the marker is a routing key, not an authority.
 *
 * A `.malformed-*` quarantine (drainOutbox's quarantine for an unparseable
 * record) is FAILED, never posted — its marker cannot be read, so a malformed
 * file in the receipt dirs is reported as `malformed` only when no valid receipt
 * was found. cli#389 round 8 makes it ATTRIBUTABLE: the drain renames the record
 * to `.malformed-<its original name>`, and a record this plugin wrote is named
 * `<tsSlug>-<replyId>.json` — so when the quarantined name ends with the reply id
 * the record knows (pin g), the quarantined file IS this reply's own and the
 * scan says so (`ownRecord`). That is a DEFINITIVE non-delivery verdict: the
 * reply was quarantined, never delivered. Any other quarantined file is
 * unattributable and stays a deadline matter.
 * `expectedReplyId` is pin (g): the reply the obligation record KNOWS it was
 * discharged by, when it knows one. An obligation record written before the
 * `replyId` field existed (or one that never reached `posted`) carries none, and
 * then there is nothing to pin — the scan does not invent a value.
 */
export function scanForReceipt(
  dirs: ReceiptScanDirs,
  obligationId: string,
  replyToId: string,
  agent: string,
  accountId: string,
  expectedReplyId?: string,
  fs: ReceiptScanFs = realFs,
): ReceiptScan {
  let malformed: { path: string; ownRecord: boolean } | null = null;
  // (1) METADATA: the direct path, one file. A `direct` dir is NEVER listed —
  //     the agent's receipts root holds a receipt per non-local delivery, so
  //     walking it would parse every retained receipt on every scan (round 4).
  for (const dir of dirs.direct) {
    const direct = resolve(dir, `${obligationId}.json`);
    if (!fs.existsSync(direct)) continue;
    try {
      const rec: any = JSON.parse(fs.readFileSync(direct, "utf-8"));
      if (
        rec !== null &&
        typeof rec === "object" &&
        typeof rec.replyId === "string" &&
        (expectedReplyId === undefined || rec.replyId === expectedReplyId) &&
        rec.obligationId === obligationId &&
        rec.replyToId === replyToId
      ) {
        return { status: "found", path: direct };
      }
    } catch {
      // Unparseable at the direct path: nothing else in a receipts dir is read.
    }
  }
  // (2) POSTED FILE: the marker names no path, so THESE dirs — and only these —
  //     are listed.
  for (const dir of dirs.posted) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".malformed-")) {
        // This reply's OWN quarantined record: the name still carries the reply
        // id the obligation recorded (pin g), so the quarantine can be ATTRIBUTED
        // to this reply — a definitive non-delivery. An attributed quarantine is
        // preferred over an unattributable one, so a stale unrelated marker in the
        // same dirs can never mask the verdict.
        const own =
          typeof expectedReplyId === "string" &&
          expectedReplyId.length > 0 &&
          name.endsWith(`-${expectedReplyId}.json`);
        if (!malformed || (own && !malformed.ownRecord)) {
          malformed = { path: resolve(dir, name), ownRecord: own };
        }
        continue;
      }
      if (name.startsWith(".")) continue; // staging temp
      if (!name.endsWith(".json")) continue;
      const path = resolve(dir, name);
      let record: any;
      try {
        record = JSON.parse(fs.readFileSync(path, "utf-8"));
      } catch {
        continue; // unparseable but not quarantined yet; not a receipt
      }
      if (record?.headers?.["X-TPS-Obligation"] === obligationId) {
        if (record?.accountId !== accountId) continue;
        if (record?.from !== agent) continue;
        if (record?.replyToId !== replyToId) continue;
        if (envelopeFrom(record?.body ?? "") !== agent) continue;
        return { status: "found", path };
      }
      // (2b) the BRIDGE SANDBOX RECORD (cli#389 round 5, item 2): the reduced
      //      record `deliverToSandbox` writes, carrying the obligation ids the
      //      caller supplied. It has no headers and no accountId, so the pins it
      //      CAN carry are the ones checked — the obligation it names, the
      //      inbound it answers, the reply id (g, when the record knows one), the
      //      replying agent as `from`, and a body whose envelope claims that same
      //      agent.
      if (
        record?.obligationId === obligationId &&
        record?.replyToId === replyToId &&
        typeof record?.replyId === "string" &&
        record.replyId.length > 0 &&
        (expectedReplyId === undefined || record.replyId === expectedReplyId) &&
        record?.from === agent &&
        envelopeFrom(record?.body ?? "") === agent
      ) {
        return { status: "found", path };
      }
    }
  }
  if (malformed) return { status: "malformed", path: malformed.path, ownRecord: malformed.ownRecord };
  return { status: "absent" };
}

/**
 * The newest session-transcript mtime under `~/.openclaw/agents/<agent>/sessions`
 * — named in the yield failure so the sender can hand-recover a composed DONE.
 * Best-effort: null when the tree is absent or unreadable.
 */
export function newestSessionTranscript(home: string, agent: string): { path: string; mtime: string } | null {
  const root = resolve(home, ".openclaw", "agents", agent, "sessions");
  let newest: { path: string; mtimeMs: number } | null = null;
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.isFile()) {
        try {
          const m = statSync(p).mtimeMs;
          if (!newest || m > newest.mtimeMs) newest = { path: p, mtimeMs: m };
        } catch {
          // skip
        }
      }
    }
  };
  walk(root, 0);
  if (!newest) return null;
  const found = newest as { path: string; mtimeMs: number };
  return { path: found.path, mtime: new Date(found.mtimeMs).toISOString() };
}
