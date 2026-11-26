/**
 * openclaw-tps-mail — OpenClaw Channel Plugin for TPS Mail
 *
 * Registers `tps-mail` as a first-class openclaw channel (alongside
 * discord/telegram/etc.) so inter-agent mail goes through the gateway's
 * native message routing instead of an external shell-hook wrapper
 * around `openclaw agent`.
 *
 * Inbound flow:
 *   fs.watch(~/.tps/mail/<agent>/new/) →
 *   parse TPS mail envelope →
 *   promote() (verify + new/→cur/, cli#377) →
 *   build MsgContext →
 *   dispatchReplyWithBufferedBlockDispatcher via channelRuntime →
 *   agent turn runs with standard gateway budgets/tooling →
 *   deliver callback writes the final reply with X-TPS-Obligation →
 *   a RECEIPT SCAN of the reply's destination finds that marker →
 *   stamp ackedAt on the cur/ record (S2)
 *
 * INVARIANT (I1). A success ack requires a committed final-reply receipt for
 * THIS inbound; yield is pending; failure is durably named with an explicit
 * disposition; exactly one obligation-discharging post per inbound (an agent's
 * own explicit mails may coincide — they never discharge). The ack is never
 * taken from the fact that a dispatch settled: it is taken from the receipt.
 *
 * THE COMMIT IS A PERSISTED STATE (cli#389 round 8). The obligation record
 * carries what the delivery has done — `delivering` written BEFORE the delivery
 * call, `posted` when it RETURNS — so a restart, the deadline path and the
 * dispatch's outer catch all read the same truth. Every path that ends an
 * obligation goes through one verb (settleObligation), which decides from that
 * record: evidence → `acked`; committed with no evidence at the deadline →
 * `unconfirmed` (never failed, never nacked); a definitive non-delivery verdict
 * → `failed` and nacked, even after commit.
 *
 * Outbound flow:
 *   outbound.sendText(ctx) →
 *   write TPS mail envelope to ~/.tps/mail/<ctx.to>/new/<id>.json
 *
 * Config in openclaw.json:
 *   channels.tps-mail.accounts.default.mailDir: ~/.tps/mail
 *   bindings: [{ agentId: "kern", match: { channel: "tps-mail", accountId: "default" } }]
 *   plugins.allow: [..., "openclaw-tps-mail"]
 *
 * Why this replaces the openclaw-deliver.sh hook:
 *   - External shell hook wraps `openclaw agent` CLI, which has a 60s
 *     per-request Gemini timeout that's too short for deep review tasks.
 *   - Native channel path uses the gateway's internal message loop, same
 *     as Discord/Telegram, which has the budget pacing K&S actually need.
 *   - Fixes the argv-leak by deletion — message body never goes through argv.
 *   - Eliminates the session accumulation pollution seen with the hook
 *     (hook always landed in `main` session, accumulating noise).
 */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Envelope, ChainEntry } from "@tpsdev-ai/agent";
import { signEnvelope, verifyEnvelope, verifiedMailTier, mailLockPath, isMailboxMessageFile } from "@tpsdev-ai/agent";
import { readAgentPrivateKey } from "@tpsdev-ai/cli/utils/agent-keys";
import { signForDelivery } from "@tpsdev-ai/cli/utils/mail-producer";
import { curPlacementRefusal, isValidEnvelopeId, mailRootForRecordPath, updateExistingRecord, promote, recoverPromoted, verifyRecordForMailbox, sweepStrandedPromoteScratch } from "@tpsdev-ai/cli/utils/mail";
import { createMailVerifyClient } from "@tpsdev-ai/cli/utils/mail-verify";
import { resolveMailRoute, type MailRoute } from "@tpsdev-ai/cli/utils/mail-routing";
import {
  MAX_TIMER_DELAY_MS,
  MailAckTimeoutConfigError,
  deliverToRemoteBranch,
  deliverToSandbox,
  remoteDeliveryWorstCaseMs,
  resolveAgentMailRoot,
  resolveMailAckTimeoutMs,
} from "@tpsdev-ai/cli/utils/relay";
import {
  TERMINAL_STATES,
  createObligation,
  listObligations,
  markNackSent,
  nackOwed,
  newestSessionTranscript,
  readObligation,
  readObligationResult,
  receiptThread,
  receiptsDir,
  scanForReceipt,
  sweepTerminalObligations,
  type ReceiptSignatureCheck,
  transitionObligation,
  writeReceipt,
  type ObligationRecord,
  type ObligationState,
  type ReceiptRecord,
  type ReceiptScanDirs,
} from "./obligations.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { formatStampDiagnostic, type ObligationPresence } from "./diagnostics.js";
import { detectHostOpenClawVersion, evaluateHostSilentReplyGuard } from "./host-version.js";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type {
  ChannelGatewayContext,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "openclaw/plugin-sdk/channel-contract";

// The pinned openclaw (2026.8.1) exports no `plugin-sdk/channels` subpath, and
// ChannelGatewayAdapter / ChannelConfigAdapter have no public NAMED export at
// all. Derive both from the public ChannelPlugin contract — its `gateway` and
// `config` members — so the SDK type stays the source of truth rather than a
// hand-written structural copy.
type ChannelGatewayAdapter<TResolvedAccount> = NonNullable<ChannelPlugin<TResolvedAccount>["gateway"]>;
type ChannelConfigAdapter<TResolvedAccount> = ChannelPlugin<TResolvedAccount>["config"];

// ─── Config ──────────────────────────────────────────────────────────────────

interface TpsMailAccount {
  accountId: string;
  mailDir: string;    // resolved absolute path, e.g., /Users/.../.tps/mail
  enabled: boolean;
}

interface TpsMailBody {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
  read?: boolean;
  /** The account that owns this mail — carried so a receipt scan can reject a
   *  cross-account match (two accounts resolving to one mailDir is refused at
   *  startAccount). */
  accountId?: string;
  headers?: Record<string, string>;
  /** The thread this mail claims. On a mail this plugin WRITES it is the
   *  inbound's SIGNED envelope messageId, equal to the `replyToId` signed inside
   *  the envelope (cli#429); a recipient's promote() re-stamps it from the
   *  verified envelope. The inbound's local record id rides only in the
   *  `X-TPS-InReplyTo` header, as bookkeeping. */
  replyToId?: string;
  /** Set by promote() on an INBOUND: its verified envelope's messageId — the
   *  thread id a reply to it signs (cli#429). */
  envelopeId?: string;
  envelope?: Envelope;
  trustTier?: "user" | "internal" | "external";
  ackedAt?: string;
  nackedAt?: string;
  nackReason?: string;
  deliveryAttempts?: number;
}

const DEFAULT_MAIL_DIR = resolve(homedir(), ".tps", "mail");
const CHANNEL_ID = "tps-mail";

/** Plugin-level config, captured at register() (the cli#401 retention key). */
let pluginConfig: Record<string, unknown> = {};

/** The obligation-retention window in days (cli#401). Config key
 *  `obligationRetentionDays`, read from the PLUGIN config
 *  (openclaw.plugin.json configSchema) with the channel config
 *  (`channels["tps-mail"]`) accepted as an alternative. Default 7 when unset or
 *  invalid; an explicit value <= 0 disables the sweep. */
export const OBLIGATION_RETENTION_KEY = "obligationRetentionDays";
export const DEFAULT_OBLIGATION_RETENTION_DAYS = 7;
export function resolveObligationRetentionDays(pluginCfg: any, channelCfg: any): number {
  for (const src of [pluginCfg, channelCfg]) {
    const v = src?.[OBLIGATION_RETENTION_KEY];
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_OBLIGATION_RETENTION_DAYS;
}

/** How many `retentionDays` an owed nack is held before it is abandoned
 *  (cli#389 round 12, item 2). The hold keeps a still-owed record from being
 *  swept, but must not keep it forever: a sender with no route would otherwise
 *  pin one record per affected inbound indefinitely. */
export const OBLIGATION_NACK_HOLD_MULTIPLE_KEY = "obligationNackHoldMultiple";
export const DEFAULT_OBLIGATION_NACK_HOLD_MULTIPLE = 4;
export function resolveObligationNackHoldMultiple(pluginCfg: any, channelCfg: any, log?: any): number {
  for (const src of [pluginCfg, channelCfg]) {
    const v = src?.[OBLIGATION_NACK_HOLD_MULTIPLE_KEY];
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
    if (!Number.isFinite(n)) continue;
    if (n >= 1) return n;
    // cli#389 round 13, item 2: a multiple BELOW 1 makes the hold SHORTER than
    // the retention window, so an owed record is abandoned and then KEPT by
    // retention — abandoned (and logged) again on every sweep, while the
    // startup retry keeps firing for a debt nobody is going to pay. Reject it
    // BY NAME and fall back to the default.
    log?.warn?.(
      `tps-mail: obligation-nack-hold-multiple-invalid: ${OBLIGATION_NACK_HOLD_MULTIPLE_KEY}=${n} is below 1 ` +
        `(a hold shorter than the retention window would abandon an owed nack on every sweep); using the default ${DEFAULT_OBLIGATION_NACK_HOLD_MULTIPLE}`,
    );
    return DEFAULT_OBLIGATION_NACK_HOLD_MULTIPLE;
  }
  return DEFAULT_OBLIGATION_NACK_HOLD_MULTIPLE;
}

/** The age bound (in days) for the owed-nack hold: `retentionDays` times the
 *  configured multiple. `retentionDays <= 0` (the sweep is disabled) disables
 *  the bound too — the sweep never runs. */
export function resolveObligationNackHoldDays(
  retentionDays: number,
  pluginCfg: any,
  channelCfg: any,
  log?: any,
): number {
  return retentionDays * resolveObligationNackHoldMultiple(pluginCfg, channelCfg, log);
}

/** The CONNECTION bound (ms) for one owed-nack retry (cli#389 round 12, item 1).
 *  The relay bounds the send and the ACK wait on top of it; the background
 *  retry's backstop sits above that whole bound (see
 *  `remoteDeliveryWorstCaseMs`). The env override exists so a test can drive a
 *  hung connect to its timeout quickly; production uses the default. */
export const DEFAULT_NACK_RETRY_TIMEOUT_MS = 20_000;
/** How far ABOVE the relay's whole delivery bound the background retry's
 *  backstop sits (cli#389 round 12, item 1). The relay closes the transport when
 *  its connection or send timer expires and rejects with its timeout error; an
 *  expired ACK window rejects as delivery unconfirmed. The backstop only
 *  guarantees the retry promise cannot hang the process if the delivery does
 *  not settle for another reason. */
const NACK_RETRY_BACKSTOP_MS = 2_000;
function resolveNackRetryTimeoutMs(): number {
  const v = process.env.TPS_NACK_RETRY_TIMEOUT_MS;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_NACK_RETRY_TIMEOUT_MS;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : p;
}

function resolveMailDir(cfg: any, accountId: string): string {
  const accounts = cfg?.channels?.[CHANNEL_ID]?.accounts ?? {};
  const account = accounts[accountId] ?? accounts.default ?? {};
  return expandHome(account.mailDir ?? DEFAULT_MAIL_DIR);
}

/**
 * STARTUP GUARD: two accounts resolving to the same mailDir would let one
 * account's receipt scan satisfy another's obligation (and one account's
 * watcher ack another's mail). Refuse by name. Returns the refusal line, or
 * null when there is no conflict.
 */
function mailDirConflict(cfg: any, accountId: string): string | null {
  const accounts = cfg?.channels?.[CHANNEL_ID]?.accounts ?? {};
  const mine = resolveMailDir(cfg, accountId);
  for (const id of Object.keys(accounts)) {
    if (id === accountId) continue;
    if (resolveMailDir(cfg, id) === mine) {
      return `accounts "${id}" and "${accountId}" resolve to the same mail directory (${mine})`;
    }
  }
  return null;
}

// ─── Agent binding discovery ─────────────────────────────────────────────────
// Reads `cfg.bindings` to find all agents that should receive TPS mail for the
// given account. Each binding is `{ agentId, match: { channel, accountId } }`.

function findBoundAgents(cfg: any, accountId: string): string[] {
  const bindings = Array.isArray(cfg?.bindings) ? cfg.bindings : [];
  const agents: string[] = [];
  for (const binding of bindings) {
    const match = binding?.match ?? {};
    if (match.channel !== CHANNEL_ID) continue;
    // Allow missing accountId to mean "default"
    const boundAcct = match.accountId ?? "default";
    if (boundAcct !== accountId) continue;
    if (typeof binding.agentId === "string") agents.push(binding.agentId);
  }
  return agents;
}

// ─── TPS mail envelope helpers ───────────────────────────────────────────────

function readMailFile(filePath: string, onReadError?: (path: string, code?: string) => void): TpsMailBody | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const record: unknown = JSON.parse(raw);
    if (onReadError && (!record || typeof record !== "object" || Array.isArray(record) || typeof (record as TpsMailBody).id !== "string")) {
      onReadError?.(filePath);
      return null;
    }
    return record as TpsMailBody;
  } catch (err: any) {
    onReadError?.(filePath, err?.code);
    return null;
  }
}

function writeMailFile(mailDir: string, recipient: string, message: TpsMailBody): string {
  const newDir = resolve(mailDir, recipient, "new");
  if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
  const tsSlug = message.timestamp.replace(/[:.]/g, "-");
  const filename = `${tsSlug}-${message.id}.json`;
  const target = resolve(newDir, filename);
  writeFileSync(target, JSON.stringify(message, null, 2), "utf-8");
  return target;
}

/**
 * Write to ~/.tps/outbox/new/ for cross-host delivery via the TPS branch
 * service. The branch service drains this directory on each heartbeat and
 * relays messages over the wire to the host, which dispatches to the
 * recipient's actual host. Format matches packages/cli/src/utils/outbox.ts
 * `OutboxMessage`.
 */
function writeOutboxFile(message: TpsMailBody): string {
  const outboxNew = resolve(process.env.HOME ?? homedir(), ".tps", "outbox", "new");
  mkdirSync(outboxNew, { recursive: true });
  const tsSlug = message.timestamp.replace(/[:.]/g, "-");
  const filename = `${tsSlug}-${message.id}.json`;
  const target = resolve(outboxNew, filename);
  const content = JSON.stringify(
    {
      id: message.id,
      to: message.to,
      from: message.from,
      body: message.body,
      timestamp: message.timestamp,
      // The account id and the reply reference / marker headers MUST ride with
      // the envelope: for a remote recipient the outbox copy is the only record
      // a later receipt scan (S2) can key on.
      ...(message.accountId ? { accountId: message.accountId } : {}),
      ...(message.replyToId ? { replyToId: message.replyToId } : {}),
      ...(message.headers ? { headers: message.headers } : {}),
    },
    null,
    2,
  );
  // Atomic write: stage to a DOT-PREFIXED temp in the SAME directory, then
  // rename into place. This is the canonical pattern from the CLI's own outbox
  // writer (packages/cli/src/utils/outbox.ts `queueOutboxMessage`): the branch
  // relay watches outbox/new and runs a send pass when the watcher fires while
  // a host channel is alive, including the create event that precedes the bytes — a
  // record written straight to its final name can be read mid-write and fail
  // JSON.parse. The drain leaves a file in place while it is younger than its
  // partial-write grace and its mtime is less than 1 s in the future, and reads
  // it again on a later pass; a record at least the grace old, or dated 1 s or
  // more in the future, is quarantined. drainOutbox filters dot-prefixed names by design, so a
  // concurrent reader never sees a half-written record, and rename(2) within one
  // filesystem is atomic. (This is replicated here rather than calling queueOutboxMessage
  // because @tpsdev-ai/cli/utils/outbox is not in the CLI package's exports map.)
  const tmp = resolve(outboxNew, `.${filename}.tmp`);
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, target);
  return target;
}

/**
 * cli#389: a NON-LOCAL delivery can leave no locally readable mail file, so the
 * obligation scan could never find a receipt for it and a delivered reply was
 * later marked failed and nacked — the wire case (round 1, item 1) and the
 * bridge case (round 3, item 1) are the same defect. Persist the metadata
 * receipt those routes owe, into the REPLYING agent's own obligation store at
 * `<mailDir>/<agent>/.obligations/receipts/<obligationId>.json` (per-agent since
 * cli#389 round 5): the ids, the route, the branch, the timestamp and — since
 * cli#429 — the signed reply envelope the delivery carried, which the scan
 * verifies before it accepts the receipt (a signature cannot be checked over
 * bytes the receipt does not hold).
 *
 * SCOPE: every route whose delivered record this agent cannot keep. The wire
 * and the bridge leave none (or one the sandbox agent consumes). A LOCAL reply
 * does leave one — in the RECIPIENT's maildir, which the recipient consumes:
 * its promote() rewrites and moves it, its ack DELETES it, its gc purges it —
 * so once the recipient has acked, a later scan (the deadline's, or restart
 * recovery's) found no evidence and a committed reply ended `unconfirmed`
 * (cli#429 round 7). The local route therefore gets the same receipt; its
 * posted record is still scanned too. The OUTBOX route does NOT: its record
 * stays in this host's outbox (new/ → sent/, never consumed here), and the
 * drain QUARANTINING that record is a definitive non-delivery verdict the scan
 * must see (cli#398 T4) — an always-readable receipt beside it would mask it.
 *
 * A message with no `X-TPS-Obligation` marker owes no obligation (a nack, or an
 * ordinary outbound send), so nothing is written for it: a receipt is evidence
 * of a discharged obligation, never a mail copy.
 */
function persistReceipt(mailDir: string, agent: string, message: TpsMailBody, route: ReceiptRoute, branchId?: string): void {
  const obligationId = message.headers?.["X-TPS-Obligation"];
  if (typeof obligationId !== "string" || obligationId.length === 0) return;
  // The receipt must answer a specific inbound: without a replyToId it could
  // never satisfy the obligation scan, and writing it would only grow the dir.
  if (typeof message.replyToId !== "string" || message.replyToId.length === 0) return;
  const record: ReceiptRecord = {
    replyId: message.id,
    obligationId,
    replyToId: message.replyToId,
    route,
    ...(branchId ? { branchId } : {}),
    ts: typeof message.timestamp === "string" && message.timestamp.length > 0 ? message.timestamp : new Date().toISOString(),
    signedReply: message.body,
  };
  writeReceipt(mailDir, agent, record);
}

/**
 * cli#389 round 5, item 2: a receipt write is EVIDENCE UPKEEP, never part of the
 * send. Once a delivery call has RETURNED it has committed, so a receipt that
 * cannot be written (a full disk, a permission error) must not set a failure —
 * that reported a delivered reply as failed and nacked its inbound. The error is
 * logged by name and swallowed, on every route.
 *
 * Nothing is lost: the bridge's sandbox record carries the same ids (see
 * obligationMetadata) and a local reply is its own posted record, so the scan
 * still finds those deliveries while the record is unconsumed; for the wire the
 * receipt is the only local evidence, so that obligation resolves at its
 * deadline instead of immediately (stated in the README).
 */
/** The routes that persist a metadata receipt (see persistReceipt's SCOPE). */
type ReceiptRoute = "local" | "remote-branch" | "bridge";

function persistReceiptAfterCommit(
  mailDir: string,
  agent: string,
  message: TpsMailBody,
  route: ReceiptRoute,
  branchId: string | undefined,
  log?: any,
): void {
  try {
    persistReceipt(mailDir, agent, message, route, branchId);
  } catch (err: any) {
    log?.warn?.(
      `tps-mail: receipt-write-failed: the ${route} delivery committed, but its receipt was not written ` +
        `(${err?.message ?? err}); the obligation resolves at its deadline`,
    );
  }
}

/**
 * Run ONE piece of post-commit evidence upkeep (cli#389 round 6, item 2). Once
 * a delivery call has RETURNED it has committed, so a failure here is logged by
 * NAME and swallowed — it never sets a post failure, so a delivered reply is
 * never reported as failed and its inbound is never nacked. The logger itself is
 * guarded too: a throwing logger cannot fail a committed send either.
 */
function postCommit(log: any, name: string, context: string, step: () => void): void {
  try {
    step();
  } catch (err: any) {
    try {
      log?.warn?.(
        `tps-mail: ${name}: ${context} (${err?.message ?? err}); the delivery committed, so this is not a send failure`,
      );
    } catch {
      /* a logger must never fail a committed send */
    }
  }
}

/**
 * The obligation ids the bridge's `deliverToSandbox` record carries when the
 * caller has them (cli#389 round 5, item 2): the obligation, the thread the
 * reply answers (its signed `replyToId` — the inbound's envelope id, cli#429),
 * and the reply itself. EMPTY for a message that owes no
 * obligation (an ordinary outbound send, a nack), so that record stays
 * byte-identical to the one the CLI's own local send writes.
 */
function obligationMetadata(message: TpsMailBody): { obligationId?: string; replyToId?: string; replyId?: string } {
  const obligationId = message.headers?.["X-TPS-Obligation"];
  if (typeof obligationId !== "string" || obligationId.length === 0) return {};
  if (typeof message.replyToId !== "string" || message.replyToId.length === 0) return {};
  return { obligationId, replyToId: message.replyToId, replyId: message.id };
}

/**
 * Deliver to a remote branch — the COMMIT of the wire route. The local receipt
 * is written by the caller AFTER this returns and under its own guard
 * (persistReceiptAfterCommit): a receipt that cannot be written must never
 * report a delivered reply as failed (cli#389 round 5, item 2).
 */
async function deliverRemote(
  reply: TpsMailBody,
  branchId: string,
  opts: { timeoutMs?: number; ackTimeoutMs?: number } = {},
): Promise<void> {
  // Preserve the outbound identity (id + timestamp) so the wire payload — and
  // the branch's ACK correlation — match the record this plugin reports as the
  // reply id, not a UUID the relay invents. `opts.timeoutMs` bounds the
  // CONNECTION; the relay bounds the send above it and waits `ackTimeoutMs` for
  // the ACK, closing the transport when any of its own timers expires
  // (cli#389 round 12, item 1).
  await deliverToRemoteBranch(
    branchId,
    {
      id: reply.id,
      to: reply.to,
      from: reply.from,
      body: reply.body,
      timestamp: reply.timestamp,
    },
    { timeoutMs: opts.timeoutMs, ackTimeoutMs: opts.ackTimeoutMs },
  );
}

/**
 * Decide where to write outbound mail.
 * - Local recipient (bound to this gateway via `bindings`): write to the
 *   recipient's local inbox so the watcher picks it up directly.
 * - Remote recipient (no binding): write to ~/.tps/outbox/new/ so the
 *   branch service relays it over the wire to the appropriate host.
 *
 * Without this split, replies addressed to off-host agents (the cross-host
 * case) silently land in this host's local mail/<recipient>/new/ and
 * never reach the actual recipient.
 */
function deliverOutboundMail(
  cfg: any,
  accountId: string,
  mailDir: string,
  message: TpsMailBody,
): Promise<{ path: string; route: MailRoute["kind"] }> {
  const route = routeFor(mailDir, cfg, accountId, message.to);
  switch (route.kind) {
    case "local":
      return Promise.resolve({ path: writeMailFile(mailDir, message.to, message), route: "local" });
    case "outbox":
      // The outbox record IS the receipt for this route: the branch drain keeps
      // its marker (new/ → sent/), so the obligation scan reads it there. Only a
      // route that leaves NO locally readable mail file owes a metadata receipt
      // (the wire, the sandbox bridge) — see persistReceipt.
      return Promise.resolve({ path: writeOutboxFile(message), route: "outbox" });
    case "remote-branch":
      // The wire path, exactly as `tps mail send` sends it, PLUS the local
      // receipt item 1 requires so a later obligation scan can find it. The
      // receipt is written after the send RETURNS and cannot fail it (round 5).
      return deliverRemote(message, route.branchId).then(() => {
        persistReceiptAfterCommit(mailDir, message.from, message, "remote-branch", route.branchId);
        return { path: `remote-branch:${route.branchId}`, route: "remote-branch" as const };
      });
    case "bridge": {
      // A local branch-office sandbox — the CLI's own bridge, imported. Its
      // sandbox record is REDUCED (no marker, no accountId), so the obligation
      // scan reads it through the obligation ids `deliverToSandbox` writes into
      // it when given (round 5, item 2) and/or the metadata receipt the bridge
      // owes exactly like the wire (round 3, item 1).
      deliverToSandbox(route.branchId, {
        to: message.to,
        from: message.from,
        body: message.body,
        ...obligationMetadata(message),
      });
      persistReceiptAfterCommit(mailDir, message.from, message, "bridge", route.branchId);
      return Promise.resolve({ path: `bridge:${route.branchId}`, route: "bridge" });
    }
    case "failed":
      // A GAL entry naming a branch with no remote registration.
      throw new Error(`refusing to deliver to "${message.to}": ${route.reason} (branch ${route.branchId})`);
    case "unknown":
      // (cli#389 rule 3) Never a silent write into a directory nothing reads.
      throw new Error(
        `no delivery route for recipient "${message.to}" on this host ` +
          `(not bound to this gateway, no local maildir, no registered remote branch)`,
      );
  }
}

/** The outcome of signing a reply or nack (cli#429): the signed envelope JSON,
 *  or a NAMED reason it could not be signed — never a raw body to fall back on. */
type SignedReply = { ok: true; body: string } | { ok: false; reason: string; detail: string };

/**
 * Sign a dispatcher reply (or a nack) as a v1 signed envelope, like `tps mail
 * send` (packages/cli/src/utils/mail-sign.ts). The key is resolved by the CLI's
 * agent-keys search path (~/.flair/keys/<id>.key and ~/.tps/identity/<id>.key;
 * two files holding different keys are refused, never one silently chosen).
 *
 * cli#429: `replyToId` is the inbound's SIGNED envelope messageId — the durable
 * thread id — and it is carried INSIDE the envelope, so the signature covers it:
 * a recipient's promote() rejects a reply whose thread was changed or stripped.
 * It must satisfy the CLI's one id rule (isValidEnvelopeId). The wrapper id of
 * the inbound is local bookkeeping and never goes in here.
 *
 * NEVER throws and never yields an unsigned body: a missing, unreadable or
 * malformed key (or an invalid thread id) is a named `{ ok: false }`, and every
 * caller refuses to send in that case.
 */
function signReplyEnvelope(from: string, to: string, body: string, replyToId: string | undefined): SignedReply {
  if (replyToId !== undefined && !isValidEnvelopeId(replyToId)) {
    return { ok: false, reason: "invalid-thread-id", detail: "the inbound's envelope id does not satisfy the id rule" };
  }
  let privkey: Buffer | null;
  try {
    privkey = readAgentPrivateKey(from);
  } catch (err: any) {
    // AgentKeyError / AgentKeyConflictError: names the path(s) and the defect,
    // never key material. Two DIFFERENT key files for one agent are refused
    // rather than one silently chosen (cli#429).
    const reason = err?.name === "AgentKeyConflictError" ? "conflicting-signing-keys" : "unusable-signing-key";
    return { ok: false, reason: `${reason}:${from}`, detail: String(err?.message ?? err) };
  }
  if (!privkey) {
    return { ok: false, reason: `missing-signing-key:${from}`, detail: `no Ed25519 private key for ${from}` };
  }

  const now = new Date().toISOString();
  const chain: ChainEntry[] = [
    {
      agent: "system",
      kind: "human",
      timestamp: now,
      rationale: "tps-mail dispatcher reply (no inbound chain)",
      signature: null,
    },
    {
      agent: from,
      kind: "agent",
      timestamp: now,
      rationale: `agent ${from} dispatcher reply`,
      signature: null,
    },
  ];

  const envelope: Envelope = {
    v: 1,
    from,
    to,
    subject: `mail to ${to}`,
    body,
    messageId: randomUUID(),
    timestamp: now,
    delegationChain: chain,
  };
  if (replyToId !== undefined) envelope.replyToId = replyToId;

  try {
    return { ok: true, body: JSON.stringify(signEnvelope(envelope, { [from]: privkey })) };
  } catch (err: any) {
    return { ok: false, reason: `signing-failed:${from}`, detail: String(err?.message ?? err) };
  }
}

/**
 * ONE locality decision for outbound mail (cli#389), shared with `tps mail
 * send` via `@tpsdev-ai/cli/utils/mail-routing` — the plugin no longer keeps a
 * second rule. A recipient with a maildir used to be treated as local on ANY
 * host, so a maildir created for archiving/inspection (or by accident) for a
 * REMOTE peer silently swallowed the reply. Directory existence now decides
 * only on the OFFICE; on a BRANCH only a bound recipient is local.
 */
function routeFor(mailDir: string, cfg: any, accountId: string, to: string): MailRoute {
  return resolveMailRoute({ to, mailDir, localAgents: findBoundAgents(cfg, accountId) });
}

type CurRecordUpdate =
  | { ok: true }
  | { ok: false; reason: "record-missing" | "write-failed"; path: string; code?: string };

export function patchMailFile(path: string, patch: Partial<TpsMailBody>, stampKey: "ackedAt" | "nackedAt" | undefined, inboundId: string, mailboxRoot: string): CurRecordUpdate {
  try {
    let alreadyStamped = false;
    const r = updateExistingRecord<TpsMailBody>(path, (current) => {
      if (current.id !== inboundId) {
        throw Object.assign(new Error("cur identity changed"), { code: "ID_MISMATCH" });
      }
      if (stampKey && current[stampKey]) {
        alreadyStamped = true;
        return null;
      }
      return Object.assign(current, patch);
    }, { mailboxRoot, withholdPlacement: true });
    if (r.status === "changed" && alreadyStamped) return { ok: true };
    if (r.status === "withheld") return { ok: false, reason: "write-failed", path, code: "PLACEMENT_WITHHELD" };
    if (r.status === "updated") return { ok: true };
    if (r.status === "gone") return { ok: false, reason: "record-missing", path, code: "ENOENT" };
    return { ok: false, reason: "write-failed", path, code: undefined };
  } catch (err: any) {
    return { ok: false, reason: "write-failed", path: typeof err?.path === "string" && (err.path === mailLockPath(mailboxRoot) || err.path.startsWith(`${mailLockPath(mailboxRoot)}.`))
      ? mailLockPath(mailboxRoot) : path, code: typeof err?.code === "string" ? err.code : undefined };
  }
}

function stampObligationPresence(mailDir: string, agent: string, inboundId: string): ObligationPresence {
  const result = readObligationResult(mailDir, agent, inboundId);
  return result.status === "found" ? "retained" : result.status === "missing" ? "none" : "unknown";
}

export function reconcileTerminalCurStamps(mailDir: string, agent: string, log: any, records?: ObligationRecord[], unknownInbounds = new Set<string>()): Set<string> {
  const reportReadError = (obligation: ObligationPresence, id: string) => (path: string, code?: string) => {
    if (unknownInbounds.has(id)) return;
    unknownInbounds.add(id);
    log?.warn?.(
      formatStampDiagnostic({ kind: "stamp-reconcile-read-failed", actor: agent, id, path, code, obligation }),
    );
  };
  const onObligationReadError = (_path: string, _code: string | undefined, ids: string[]) => {
    for (const id of ids) unknownInbounds.add(id);
  };
  for (const rec of records ?? listObligations(mailDir, agent, onObligationReadError)) {
    if (unknownInbounds.has("*") || unknownInbounds.has(rec.inboundId)) continue;
    if (rec.state !== "acked" && rec.state !== "failed") continue;
    let unreadable = false;
    const onReadError = (path: string, code?: string) => {
      if (code === "ENOENT") return;
      unreadable = true;
      reportReadError(stampObligationPresence(mailDir, agent, rec.inboundId), rec.inboundId)(path, code);
    };
    const kind = rec.state === "acked" ? "ack" : "nack";
    const key = kind === "ack" ? "ackedAt" : "nackedAt";
    const curPath = findCurPath(mailDir, agent, rec.inboundId, onReadError);
    if (unreadable || !curPath) continue;
    const cur = readMailFile(curPath, onReadError);
    if (!cur) continue;
    if (cur[key]) continue;
    const patch = kind === "ack"
      ? { ackedAt: new Date().toISOString(), read: true }
      : { nackedAt: new Date().toISOString(), nackReason: rec.failure ?? "failed" };
    const r = patchMailFile(curPath, patch, key, rec.inboundId, join(mailDir, agent));
    if (r.ok) log?.info?.(`tps-mail: reconciled the ${kind} stamp for ${rec.inboundId} at ${curPath}`);
    else {
      unknownInbounds.add(rec.inboundId);
      log?.warn?.(
        formatStampDiagnostic({ kind: `${kind}-stamp-reconcile-failed`, actor: agent, id: rec.inboundId, path: r.path, code: r.code, obligation: stampObligationPresence(mailDir, agent, rec.inboundId) }),
      );
    }
  }
  return unknownInbounds;
}

/**
 * Resolve the sending agent id from the outbound context. Returns null if
 * the identity can't be determined — callers must fail-closed rather than
 * using a fallback like "unknown" that creates a shared session sink.
 */
function resolveOutboundSender(ctx: ChannelOutboundContext): string | null {
  const id =
    (ctx.identity as any)?.agentId ??
    (ctx.identity as any)?.from ??
    null;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function buildEnvelope(msg: TpsMailBody): string {
  return [
    "[TPS Mail]",
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `ID: ${msg.id}`,
    `Timestamp: ${msg.timestamp}`,
    "",
    msg.body,
    "",
    "---",
    `Reply via: tps mail send ${msg.from} "<your response>"`,
  ].join("\n");
}

// ─── final-reply selection (cli#400) ────────────────────────────────────────

/** The text of a final reply payload: `text`, else the concatenated text blocks. */
function extractFinalText(payload: any): string {
  if (typeof payload?.text === "string" && payload.text.length > 0) return payload.text;
  if (Array.isArray(payload?.content)) {
    return payload.content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c?.text ?? "")
      .join("\n");
  }
  return "";
}

/**
 * The control tokens OpenClaw treats as "silent". This guard matches the raw
 * TOKENS only — it cannot catch a REWRITTEN silent reply.
 *
 * 2026.5.22 suppresses an exact `NO_REPLY` BEFORE `deliver` (normalizeReplyPayload
 * → onSkip, enforced in the reply dispatcher's enqueue), so the guard is
 * belt-and-braces there. Older hosts rewrite instead: a tps-mail session key
 * (`agent:<id>:tps-mail:direct:<sender>`) classifies "direct", whose defaults are
 * policy "disallow" WITH rewrite ON, so an exact `NO_REPLY` becomes a canned
 * phrase (e.g. "Nothing to add right now.") BEFORE `deliver` — which this guard
 * cannot tell from a real reply. Such a host needs
 * `surfaces["tps-mail"].silentReplyRewrite.direct = false`.
 */
const SUPPRESSED_FINAL_TOKENS = new Set(["NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP"]);

/** True when a final's text may be posted: non-empty and not a silent token. */
function isPostableFinalText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !SUPPRESSED_FINAL_TOKENS.has(trimmed.toUpperCase());
}

// ─── Reply-obligation plumbing (S2) ─────────────────────────────────────────

const OBLIGATION_DEFAULT_DEADLINE_MS = 60 * 60 * 1000;

/** cli#1006: the named reason carried on an obligation record when restart
 *  recovery or an in-process deadline settled or re-armed it from the record
 *  because the inbound's cur/ entry was gone. A reason, never a verdict. */
const MISSING_CUR_REASON = "cur-record-missing";

/** The yield→deadline window. Test-only override via env; production is 60 min. */
function obligationDeadlineMs(): number {
  const v = Number(process.env.TPS_OBLIGATION_DEADLINE_MS);
  return Number.isFinite(v) && v > 0 ? v : OBLIGATION_DEFAULT_DEADLINE_MS;
}

interface YieldContext {
  mailDir: string;
  agent: string;
  sender: string;
  accountId: string;
  incarnation: symbol;
  curPath: string;
  inboundId: string;
  /** cli#429: the inbound's SIGNED envelope messageId, from the obligation
   *  record — the thread a nack signs. Undefined for a pre-cli#429 record. */
  inboundEnvelopeId?: string;
  cfg: any;
  log: any;
  /**
   * cli#389 round 8 — the evidence step currently running, so a throw that lands
   * in the dispatch's outer catch can be logged BY NAME. It is diagnostic ONLY:
   * whether the delivery committed is read from the OBLIGATION RECORD's persisted
   * state, never from anything in this context (round 7 kept a `committed` flag
   * here, and the deadline path, a restart and the catch each saw a different
   * truth).
   */
  step?: string;
}

/** obligationId → the context needed to ack/nack it after the dispatch is gone. */
const yieldContexts = new Map<string, YieldContext>();

interface ArmedDeadline {
  accountId: string;
  timer: ReturnType<typeof setTimeout>;
}
const armedDeadlines = new Map<string, ArmedDeadline>();

/**
 * cli#1059 round 4: ONE state machine owns each obligation's bounded retry.
 *
 *   absent     — no entry: a fired deadline claims `running`, and a retryable
 *                arm/read/settle failure with no armed deadline starts a budget.
 *   scheduled  — one timer owns the next attempt (attempt, dueAt,
 *                lastVerifiedState). A repeated event or arm failure does not
 *                move dueAt or consume an attempt.
 *   running    — one check owns the decision; there is no timer. An event only
 *                records recheckWanted; an arm or read/settlement failure also
 *                records its error; the running check makes the next
 *                scheduling decision when it completes, from the entry's
 *                CURRENT state (never from what it saw when it started).
 *   exhausted  — the cap was reached (lastVerifiedState, or undefined when no
 *                read was ever verified). Nothing is armed or written, and a
 *                settlement from a retry path is refused. A VERIFIED live record
 *                state different from lastVerifiedState — never an unknown
 *                baseline — reopens a fresh budget; a check that finds the
 *                record gone or terminal deletes the entry.
 *
 * Transitions go through scheduleObligationRetry (absent/scheduled →
 * scheduled), the timer's begin transition (scheduled → running), onDeadline's
 * claim of a running entry (absent → running), complete/finishObligationRetry
 * (running → scheduled, exhausted or absent),
 * clearObligationRetry (any → absent), the direct deletes in
 * retryObligationRead and exhaustObligationRetry (a later or cap read that finds
 * the record gone or terminal), and releaseObligationState/releaseAccountState.
 */
type ObligationRetryEntry =
  | {
      kind: "scheduled";
      accountId: string;
      incarnation: symbol;
      /** Retries already consumed (1..delays.length). */
      attempt: number;
      /** Epoch ms this attempt is due. A repeated event never moves it. */
      dueAt: number;
      /** Epoch ms this attempt was scheduled (`dueAt` minus its delay). */
      scheduledAt: number;
      lastVerifiedState?: ObligationState;
      /** The failure that scheduled this attempt; an exhaustion reached from a
       *  completion names it instead of a generic re-check reason. */
      lastError?: string;
      timer: ReturnType<typeof setTimeout>;
    }
  | {
      kind: "running";
      accountId: string;
      incarnation: symbol;
      attempt: number;
      lastVerifiedState?: ObligationState;
      /** The failure that led to this attempt (or the one it threw); a failure
       *  reported while it runs replaces it. */
      lastError?: string;
      /** An event, arm failure or failed read/settlement asked for a re-check
       *  while this check ran. */
      recheckWanted: boolean;
    }
  | {
      kind: "exhausted";
      accountId: string;
      incarnation: symbol;
      attempt: number;
      lastVerifiedState?: ObligationState;
    };
const obligationRetries = new Map<string, ObligationRetryEntry>();

interface AccountLifetime {
  incarnation: symbol;
  timers: Set<ReturnType<typeof setTimeout>>;
  intervals: Set<ReturnType<typeof setInterval>>;
  watchers: Set<FSWatcher>;
  resolveShutdown: () => void;
}
const accountLifetimes = new Map<string, AccountLifetime>();
const gatewayIncarnations = new WeakMap<object, symbol>();
const signalIncarnations = new WeakMap<AbortSignal, symbol>();

function isLiveContext(ctx: Pick<YieldContext, "accountId" | "incarnation">): boolean {
  return accountLifetimes.get(ctx.accountId)?.incarnation === ctx.incarnation;
}

function accountTimer(ctx: Pick<YieldContext, "accountId" | "incarnation">, fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const lifetime = accountLifetimes.get(ctx.accountId)!;
  const timer = setTimeout(() => {
    lifetime.timers.delete(timer);
    if (isLiveContext(ctx)) fn();
  }, ms);
  lifetime.timers.add(timer);
  return timer;
}

function clearAccountTimer(accountId: string, timer: ReturnType<typeof setTimeout>): void {
  clearTimeout(timer);
  accountLifetimes.get(accountId)?.timers.delete(timer);
}

function releaseObligationState(obligationId: string): void {
  yieldContexts.delete(obligationId);
  clearObligationRetry(obligationId);
  const armed = armedDeadlines.get(obligationId);
  if (armed) {
    clearAccountTimer(armed.accountId, armed.timer);
    armedDeadlines.delete(obligationId);
  }
}

function clearObligationRetry(obligationId: string): void {
  const retry = obligationRetries.get(obligationId);
  if (!retry) return;
  if (retry.kind === "scheduled") clearAccountTimer(retry.accountId, retry.timer);
  obligationRetries.delete(obligationId);
}

function releaseAccountState(accountId: string): void {
  for (const [obligationId, ctx] of yieldContexts) {
    if (ctx.accountId === accountId) yieldContexts.delete(obligationId);
  }
  for (const [obligationId, armed] of armedDeadlines) {
    if (armed.accountId === accountId) {
      clearAccountTimer(armed.accountId, armed.timer);
      armedDeadlines.delete(obligationId);
    }
  }
  for (const [obligationId, retry] of obligationRetries) {
    if (retry.accountId === accountId) {
      if (retry.kind === "scheduled") clearAccountTimer(retry.accountId, retry.timer);
      obligationRetries.delete(obligationId);
    }
  }
}

function endAccountLifetime(accountId: string, incarnation?: symbol): void {
  const lifetime = accountLifetimes.get(accountId);
  if (incarnation !== undefined && lifetime?.incarnation !== incarnation) return;
  accountLifetimes.delete(accountId);
  startupSweepDone.delete(accountId);
  startupCurRecoveries.delete(accountId);
  if (lifetime) {
    lifetime.resolveShutdown();
    for (const timer of lifetime.timers) clearTimeout(timer);
    for (const interval of lifetime.intervals) clearInterval(interval);
    for (const watcher of lifetime.watchers) {
      try { watcher.close(); } catch { /* ignore */ }
    }
  }
  releaseAccountState(accountId);
}

/**
 * Track startup cur/ sweeps and recoveries per account so tests await completion
 * instead of guessing a delay; recoveries stay fire-and-forget in production.
 */
const startupSweepDone = new Map<string, Promise<void>>();
const startupCurRecoveries = new Map<string, Map<string, Promise<void>[]>>();

/**
 * Test-only: wait for the account's bound-agent startup cur/ sweeps and their
 * recoveries for `inboundId`. Returns false on timeout so unfinished work fails
 * the caller's completion assertion.
 */
export async function awaitStartupCurSweepForTests(
  accountId: string,
  inboundId: string,
  ms = 10000,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!startupSweepDone.has(accountId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([
      startupSweepDone.get(accountId)!.then(async () => {
        await Promise.all(startupCurRecoveries.get(accountId)?.get(inboundId) ?? []);
        return true as const;
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test-only snapshot of obligation contexts, deadlines and bounded retries. */
export function obligationStateForTests(): {
  contexts: { obligationId: string; accountId: string }[];
  deadlines: { obligationId: string; accountId: string }[];
  retries: { obligationId: string; accountId: string; attempt: number; dueAt: number; scheduledAt?: number; exhausted: boolean; state?: ObligationState; lastError?: string }[];
} {
  return {
    contexts: [...yieldContexts].map(([obligationId, ctx]) => ({ obligationId, accountId: ctx.accountId })),
    deadlines: [...armedDeadlines].map(([obligationId, armed]) => ({ obligationId, accountId: armed.accountId })),
    retries: [...obligationRetries].map(([obligationId, retry]) => ({
      obligationId,
      accountId: retry.accountId,
      attempt: retry.attempt,
      dueAt: retry.kind === "scheduled" ? retry.dueAt : Number.POSITIVE_INFINITY,
      scheduledAt: retry.kind === "scheduled" ? retry.scheduledAt : undefined,
      exhausted: retry.kind === "exhausted",
      state: retry.lastVerifiedState,
      lastError: retry.kind === "exhausted" ? undefined : retry.lastError,
    })),
  };
}

let yieldDetection: "subscription" | "settlement-inference" = "settlement-inference";

function receiptDirs(ctx: YieldContext): ReceiptScanDirs {
  // TWO receipt forms (cli#389 round 3): the metadata receipt the wire, the
  // bridge and (cli#429 round 7) a local reply persist — found by its DIRECT
  // path — and, for a route that also writes a mail file, the posted record
  // itself.
  //
  // The receipt lives in the REPLYING agent's OWN obligation store (round 5),
  // so the agent that owes the obligation is the one whose sweep owns it.
  //
  // SPLIT BY HOW A SCAN MAY READ EACH DIR (cli#389 round 4, item 1): the agent's
  // receipts root is the `direct` input — probed once at `<obligationId>.json`
  // and NEVER listed (it accumulates a receipt per receipted delivery, so a
  // listing would parse every retained receipt on every scan). The route's own
  // posted-record dirs are the `posted` input — the only dirs a scan lists: a
  // local reply lives in the recipient's maildir, a bridge delivery in the
  // branch sandbox `deliverToSandbox` wrote to (its reduced record carries the
  // obligation ids when the bridge was given them — round 5, item 2 — and the
  // metadata receipt is the other way it closes the obligation), and every other
  // relayed route in the outbox the branch drains.
  const home = process.env.HOME ?? homedir();
  const direct = [receiptsDir(ctx.mailDir, ctx.agent)];
  const route = routeFor(ctx.mailDir, ctx.cfg, ctx.accountId, ctx.sender);
  if (route.kind === "local") {
    return { direct, posted: [resolve(ctx.mailDir, ctx.sender, "new"), resolve(ctx.mailDir, ctx.sender, "cur")] };
  }
  if (route.kind === "remote-branch") {
    return { direct, posted: [] }; // the metadata receipt is the only local evidence of the wire send
  }
  if (route.kind === "bridge") {
    const mailRoot = resolveAgentMailRoot(route.branchId);
    return { direct, posted: [resolve(mailRoot, "new"), resolve(mailRoot, "cur")] };
  }
  const outbox = resolve(home, ".tps", "outbox");
  // The branch drain moves the record new/ → sent/ keeping replyToId+headers,
  // so a REMOTE receipt is either file; a `.malformed-*` in sent/ carrying THIS
  // reply's id is a FAILURE (the drain quarantines a record once it is at least
  // the partial-write grace old, or straight away when its mtime is 1 s or more
  // in the future); an unrelated one is not.
  return { direct, posted: [resolve(outbox, "new"), resolve(outbox, "sent")] };
}

/** Delays before each in-process recheck of an obligation whose deadline could
 *  not be settled or re-armed (cli#1059). Exported so a test can pin the
 *  defaults. */
export const OBLIGATION_RETRY_DELAYS_MS = [1000, 4000, 16000];
let obligationRetryDelaysMs = [...OBLIGATION_RETRY_DELAYS_MS];

/** Test-only: shorten the obligation retry delays. Returns the previous delays. */
export function setObligationRetryDelaysForTests(delays: number[]): number[] {
  const prev = obligationRetryDelaysMs;
  obligationRetryDelaysMs = [...delays];
  return prev;
}

/** Test-only fault at the cur/ lookup seam: return a code to report as a
 *  lookup error for that inbound. */
let obligationCurLookupFaultForTests: ((inboundId: string) => string | undefined) | undefined;
export function setObligationCurLookupFaultForTests(hook: typeof obligationCurLookupFaultForTests): void {
  obligationCurLookupFaultForTests = hook;
}

/** Test-only fault at the deadline-arm seam: true refuses the arm for that
 *  inbound. */
let armDeadlineFaultForTests: ((inboundId: string) => boolean) | undefined;
export function setArmDeadlineFaultForTests(hook: typeof armDeadlineFaultForTests): void {
  armDeadlineFaultForTests = hook;
}

/** Test-only fault at the start of a bounded retry: a message makes that
 *  attempt throw so the retry callback's own catch can be exercised. */
let obligationRetryFaultForTests: ((inboundId: string, attempt: number) => string | undefined) | undefined;
export function setObligationRetryFaultForTests(hook: typeof obligationRetryFaultForTests): void {
  obligationRetryFaultForTests = hook;
}

/** Test-only hook immediately before an arm's first record read: a test can
 *  land a same-state deadline extension first and observe which deadline the
 *  arm writes. */
let beforeArmReadForTests: ((inboundId: string) => void) | undefined;
export function setBeforeArmReadForTests(hook: typeof beforeArmReadForTests): void {
  beforeArmReadForTests = hook;
}

/** Test-only hook between a settlement's internal-inbound await and its record
 *  re-read: a test can land a state or same-state update in that gap and
 *  observe whether the caller's snapshot binding refuses the stale verdict. */
let beforeSettleReadForTests: ((inboundId: string) => void) | undefined;
export function setBeforeSettleReadForTests(hook: typeof beforeSettleReadForTests): void {
  beforeSettleReadForTests = hook;
}

/** Test-only hook immediately before the retry cap reads the obligation record:
 *  a test can delete it or settle it terminally in that gap. */
let beforeRetryCapReadForTests: ((inboundId: string) => void) | undefined;
export function setBeforeRetryCapReadForTests(hook: typeof beforeRetryCapReadForTests): void {
  beforeRetryCapReadForTests = hook;
}

/** Test-only hook at the entry of settleObligation, before its internal-inbound
 *  gate: a test can remove the cur/ entry in that gap. */
let beforeSettleEntryForTests: ((inboundId: string) => void) | undefined;
export function setBeforeSettleEntryForTests(hook: typeof beforeSettleEntryForTests): void {
  beforeSettleEntryForTests = hook;
}

/** Test-only: shorten the delay cap on an armed deadline timer, so a test can
 *  fire a capped timer without a multi-day wait. Undefined uses
 *  MAX_TIMER_DELAY_MS. */
let obligationTimerCapMsForTests: number | undefined;
export function setObligationTimerCapForTests(ms: number | undefined): number | undefined {
  const prev = obligationTimerCapMsForTests;
  obligationTimerCapMsForTests = ms;
  return prev;
}

/** Test-only clock for the deadline decisions: a test can hold time still while
 *  an arm settles, then advance past the deadline. Undefined uses Date.now. */
let obligationNowForTests: (() => number) | undefined;
export function setObligationNowForTests(now: (() => number) | undefined): void {
  obligationNowForTests = now;
}
function obligationNow(): number {
  return obligationNowForTests?.() ?? Date.now();
}

/** cli#1063: shorten the deadline sweep in a test. Undefined uses the
 *  production interval. */
let obligationDeadlineSweepMsForTests: number | undefined;
export function setObligationDeadlineSweepForTests(ms: number | undefined): number | undefined {
  const prev = obligationDeadlineSweepMsForTests;
  obligationDeadlineSweepMsForTests = ms;
  return prev;
}
function obligationDeadlineSweepMs(): number {
  return obligationDeadlineSweepMsForTests ?? OBLIGATION_DEADLINE_SWEEP_MS;
}

let beforeReceiptScanForTests: ((inboundId: string) => void) | undefined;
export function setBeforeReceiptScanForTests(hook: typeof beforeReceiptScanForTests): void {
  beforeReceiptScanForTests = hook;
}

/** Test-only observer of settleScannedQuarantine's own outcome. */
let quarantineOutcomeForTests: ((obligationId: string, outcome: string) => void) | undefined;
export function setQuarantineOutcomeForTests(hook: typeof quarantineOutcomeForTests): void {
  quarantineOutcomeForTests = hook;
}

/** Test-only: drop an obligation's bounded-retry entry, modelling an ownership
 *  change while a check awaits its scan. Returns whether an entry existed. */
export function releaseObligationRetryForTests(obligationId: string): boolean {
  const had = obligationRetries.has(obligationId);
  clearObligationRetry(obligationId);
  return had;
}

/**
 * cli#1059 round 4: the ONE owner of an obligation's bounded retry state. A
 * pending attempt keeps its due time: a repeated deadline fire, a yield event
 * or a refused re-arm does not restart the wait or the budget. While an attempt
 * is RUNNING, every other caller records a re-check request and returns; the
 * running check owns the next scheduling decision and re-reads the entry when
 * it completes. Each attempt re-reads the durable record. When its deadline is
 * in the future it only re-arms from that record; a parseable deadline at or
 * before now runs the deadline's own decision, which re-scans the receipt
 * evidence and the cur/ lookup before any settlement; a null or unparseable
 * deadline arms a fresh window without the receipt scan. At the cap a verified
 * live record is left open
 * and unchanged (an unverified one is reported as unresolved), no nack is
 * sent, and ONE named warning says restart recovery will pick it up. The
 * exhausted state lives until shutdown, the obligation is released (its record
 * is gone or terminal), or a VERIFIED live record state different from the last
 * verified baseline reopens a fresh budget. An unknown baseline never reopens.
 */
function retryObligationRead(
  ctx: YieldContext,
  obligationId: string,
  error = "obligation check failed",
  lastVerifiedState?: ObligationState,
): void {
  if (!isLiveContext(ctx) || armedDeadlines.has(obligationId)) return;
  const entry = obligationRetries.get(obligationId);
  if (entry) {
    if (entry.kind === "scheduled") return; // one timer: its due time stands
    if (entry.kind === "running") {
      // The running check owns the next decision: record the request and leave
      // the state (and the budget) untouched, keeping a verified arm read as
      // its baseline.
      if (lastVerifiedState !== undefined) entry.lastVerifiedState = lastVerifiedState;
      entry.recheckWanted = true;
      return;
    }
    const result = readObligationResult(ctx.mailDir, ctx.agent, ctx.inboundId);
    const gone = result.status === "missing" ||
      (result.status === "found" && TERMINAL_STATES.has(result.record.state));
    if (gone) {
      obligationRetries.delete(obligationId);
      return;
    }
    // Only a KNOWN prior state can move. With no prior verified state the
    // baseline stays unknown, and a later readable copy is not evidence of a move.
    const moved = entry.lastVerifiedState !== undefined &&
      result.status === "found" &&
      !TERMINAL_STATES.has(result.record.state) &&
      result.record.state !== entry.lastVerifiedState;
    if (!moved) return;
    obligationRetries.delete(obligationId);
    scheduleObligationRetry(ctx, obligationId, 0, error, result.record.state);
    return;
  }
  scheduleObligationRetry(ctx, obligationId, 0, error, lastVerifiedState);
}

/** A deferral re-check (an event, or an arm deferred to the retry state) only
 *  sets recheckWanted; a reported failure also records the error on a running
 *  check, so an exhaustion reached from its completion names that error. */
function reportObligationFailure(
  ctx: YieldContext,
  obligationId: string,
  error = "obligation check failed",
  lastVerifiedState?: ObligationState,
): void {
  if (!isLiveContext(ctx) || armedDeadlines.has(obligationId)) return;
  const entry = obligationRetries.get(obligationId);
  if (entry && entry.kind === "running") {
    entry.lastError = error;
    if (lastVerifiedState !== undefined) entry.lastVerifiedState = lastVerifiedState;
  }
  retryObligationRead(ctx, obligationId, error, lastVerifiedState);
}

/** Remember the state a VERIFIED read saw, so the cap and the reopen rule keep
 *  a real baseline. The deadline decision records its own verified read here;
 *  the retry check records its read directly. */
function recordVerifiedRetryState(obligationId: string, state: ObligationState): void {
  const entry = obligationRetries.get(obligationId);
  if (entry && entry.kind === "running") entry.lastVerifiedState = state;
}

function scheduleObligationRetry(
  ctx: YieldContext,
  obligationId: string,
  attempt: number,
  error: string,
  lastVerifiedState?: ObligationState,
): void {
  if (!isLiveContext(ctx) || armedDeadlines.has(obligationId)) return;
  const prev = obligationRetries.get(obligationId);
  if (prev) {
    if (prev.kind === "exhausted") return;
    if (prev.kind === "scheduled") return; // a pending attempt keeps its due time
    prev.recheckWanted = true;
    return;
  }
  if (attempt >= obligationRetryDelaysMs.length) {
    exhaustObligationRetry(ctx, obligationId, attempt, error, lastVerifiedState);
    return;
  }
  const delay = obligationRetryDelaysMs[attempt]!;
  const scheduledAt = Date.now();
  const dueAt = scheduledAt + delay;
  const timer = accountTimer(ctx, () => {
    // The timer hands ownership to a single running check. Every event or arm
    // failure in this interval only records a re-check (and, for a failure, its
    // error); it never starts a second attempt.
    const current = obligationRetries.get(obligationId);
    if (!current || current.kind !== "scheduled" || current.timer !== timer) return;
    const running: ObligationRetryEntry = {
      kind: "running",
      accountId: current.accountId,
      incarnation: current.incarnation,
      attempt: current.attempt,
      lastVerifiedState: current.lastVerifiedState,
      lastError: current.lastError,
      recheckWanted: false,
    };
    obligationRetries.set(obligationId, running);
    // This check owns the entry only while the map still holds its own
    // `running` object: a completion or reschedule after an await must not
    // touch a replacement.
    const owns = () => obligationRetries.get(obligationId) === running;
    void runObligationRetry(ctx, obligationId, attempt + 1)
      .then(() => {
        if (isLiveContext(ctx) && owns()) completeObligationRetry(ctx, obligationId);
      })
      .catch((err: any) => {
        if (!isLiveContext(ctx) || !owns()) return;
        ctx.log?.warn?.(
          `tps-mail: obligation-retry-failed: obligation ${obligationId} for inbound ${ctx.inboundId}: ${err?.message ?? err}`,
        );
        finishObligationRetry(ctx, obligationId, attempt + 1, `retry threw: ${err?.message ?? err}`);
      });
  }, delay);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  obligationRetries.set(obligationId, {
    kind: "scheduled",
    accountId: ctx.accountId,
    incarnation: ctx.incarnation,
    attempt: attempt + 1,
    dueAt,
    scheduledAt,
    // Carry the last verified state and the failure that scheduled this attempt
    // across the next attempt.
    lastVerifiedState,
    lastError: error,
    timer,
  });
}

/** The cap. A read that proves the record gone or terminal cancels the retry;
 *  only a live record (or one whose read could not be verified) is held. */
function exhaustObligationRetry(
  ctx: YieldContext,
  obligationId: string,
  attempt: number,
  error: string,
  lastVerifiedState?: ObligationState,
): void {
  beforeRetryCapReadForTests?.(ctx.inboundId);
  const prev = obligationRetries.get(obligationId);
  const priorState = lastVerifiedState ?? prev?.lastVerifiedState;
  const rec = readObligationResult(ctx.mailDir, ctx.agent, ctx.inboundId);
  if (rec.status === "missing" || (rec.status === "found" && TERMINAL_STATES.has(rec.record.state))) {
    obligationRetries.delete(obligationId);
    return;
  }
  // A verified cap read is the newest baseline. An unverified one keeps the
  // last state a VERIFIED read saw, so a later readable copy with that same
  // state is not mistaken for a move that reopens the budget.
  const state = rec.status === "found" ? rec.record.state : priorState;
  obligationRetries.set(obligationId, {
    kind: "exhausted",
    accountId: ctx.accountId,
    incarnation: ctx.incarnation,
    attempt,
    lastVerifiedState: state,
  });
  const where = rec.status === "found" ? "the record is left open" : "the record is unresolved";
  ctx.log?.warn?.(
    `tps-mail: obligation-retry-exhausted: obligation ${obligationId} for inbound ${ctx.inboundId}: ${error}; ` +
      `${where} and unchanged for restart recovery`,
  );
}

/** A running check keeps its ownership decision: if it neither scheduled a next
 *  attempt nor cleared/released the entry, a re-check request from its window
 *  schedules exactly one continuation. */
function completeObligationRetry(ctx: YieldContext, obligationId: string): void {
  const entry = obligationRetries.get(obligationId);
  if (!entry || entry.kind !== "running") return;
  const attempt = entry.attempt;
  const recheck = entry.recheckWanted;
  const state = entry.lastVerifiedState;
  const error = entry.lastError ?? "re-check requested while the attempt ran";
  obligationRetries.delete(obligationId);
  if (recheck) scheduleObligationRetry(ctx, obligationId, attempt, error, state);
}

/** End a running check's ownership and hand the budget to its next attempt. */
function finishObligationRetry(ctx: YieldContext, obligationId: string, attempt: number, error: string): void {
  const entry = obligationRetries.get(obligationId);
  if (!entry || entry.kind !== "running") return;
  const state = entry.lastVerifiedState;
  obligationRetries.delete(obligationId);
  scheduleObligationRetry(ctx, obligationId, attempt, error, state);
}

async function runObligationRetry(ctx: YieldContext, obligationId: string, attempt: number): Promise<void> {
  if (!isLiveContext(ctx)) return clearObligationRetry(obligationId);
  const entry = obligationRetries.get(obligationId);
  // A settlement from a retry path is refused once the entry is exhausted, and
  // only a running entry may settle.
  if (!entry || entry.kind !== "running") return;
  const fault = obligationRetryFaultForTests?.(ctx.inboundId, attempt);
  if (fault !== undefined) throw new Error(fault);
  const result = readObligationResult(ctx.mailDir, ctx.agent, ctx.inboundId);
  if (result.status === "unverified") {
    // The same routing readObligationForCleanup applies: an unverified record
    // is not a verdict, so this running entry records a re-check and leaves the
    // next decision to it.
    reportObligationFailure(ctx, obligationId, `obligation record unreadable (${result.code})`);
    ctx.log?.warn?.(`tps-mail: obligation-read-unverified: ${ctx.inboundId} path=${result.path} code=${result.code}`);
    return;
  }
  // cli#1059 round 6: a record that is GONE or TERMINAL cancels the budget at
  // THIS attempt — this check must not wait for the cap to clean it up.
  if (result.status === "missing" || TERMINAL_STATES.has(result.record.state)) {
    releaseObligationState(obligationId);
    return;
  }
  const rec = result.record;
  // A check that completes decides from the entry's CURRENT state, never from
  // what it saw when it started. Remember the last state a verified read saw:
  // the cap read may be unverified and must not erase it.
  const current = obligationRetries.get(obligationId);
  if (!current || current.kind !== "running") return;
  current.lastVerifiedState = rec.state;
  const parsedDeadline = rec.deadlineAt === null ? NaN : Date.parse(rec.deadlineAt);
  if (!Number.isFinite(parsedDeadline) || parsedDeadline > obligationNow()) {
    // A record whose deadline is null or unparseable must ARM, never settle:
    // its first arm may have failed before it could write a deadline (e.g. a
    // busy mailbox lock), so settling here would nack a fresh yield about a
    // second into a full deadline window.
    const at = Number.isFinite(parsedDeadline)
      ? rec.deadlineAt!
      : new Date(obligationNow() + obligationDeadlineMs()).toISOString();
    const armed = armDeadlineNow(ctx, obligationId, at);
    if (armed.outcome === "armed") return clearObligationRetry(obligationId);
    if (armed.outcome === "refused" && armed.reason === "scheduled") return;
    if (armed.outcome === "refused" && (armed.reason === "gone" || armed.reason === "terminal" || armed.reason === "inactive")) {
      return clearObligationRetry(obligationId);
    }
    finishObligationRetry(ctx, obligationId, attempt, armed.outcome === "error" ? armed.error : `deadline re-arm refused (${armed.reason})`);
    return;
  }
  const outcome = await settleObligationAtDeadline(ctx, obligationId, {
    owner: true,
    owns: () => obligationRetries.get(obligationId) === current,
  });
  // The check owns the entry until it completes; if the entry is no longer this
  // running entry (released, exhausted or replaced during an await), it decides
  // nothing more.
  const after = obligationRetries.get(obligationId);
  if (!after || after !== current) return;
  if (outcome.status === "error") {
    finishObligationRetry(ctx, obligationId, attempt, outcome.error);
    return;
  }
  if (outcome.status === "none") {
    // Nothing was settled (e.g. the inbound gate refused). A re-check asked for
    // while the decision ran is still a request: hand the entry to the
    // completion rule instead of dropping it with the entry.
    completeObligationRetry(ctx, obligationId);
    return;
  }
  // `retry-scheduled` leaves the running entry for `.then`'s completion step.
  // `write-failed` (one attempt, resolves on restart) and every settled,
  // re-armed or gone/terminal outcome end this budget.
  if (outcome.status !== "retry-scheduled") clearObligationRetry(obligationId);
}

function readObligationForCleanup(ctx: YieldContext, obligationId: string) {
  const result = readObligationResult(ctx.mailDir, ctx.agent, ctx.inboundId);
  if (result.status === "unverified") {
    reportObligationFailure(ctx, obligationId, `obligation record unreadable (${result.code})`);
    ctx.log?.warn?.(`tps-mail: obligation-read-unverified: ${ctx.inboundId} path=${result.path} code=${result.code}`);
  } else if (result.status === "missing" || TERMINAL_STATES.has(result.record.state)) {
    releaseObligationState(obligationId);
  }
  return result;
}

/** Delays before each in-process retry of a failed terminal stamp (cli#492). */
let stampRetryDelaysMs = [1000, 4000, 16000];

/** Test-only: shorten the stamp retry delays. Returns the previous delays. */
export function setStampRetryDelaysForTests(delays: number[]): number[] {
  const prev = stampRetryDelaysMs;
  stampRetryDelaysMs = delays;
  return prev;
}

function stampTerminalCur(
  ctx: YieldContext,
  kind: "ack" | "nack",
  patch: Partial<TpsMailBody>,
  attempt = 0,
): void {
  const key = kind === "ack" ? "ackedAt" : "nackedAt";
  const stamped = patchMailFile(ctx.curPath, patch, key, ctx.inboundId, join(ctx.mailDir, ctx.agent));
  if (stamped.ok) {
    if (attempt > 0) ctx.log?.info?.(`tps-mail: ${kind}-stamp-retry-ok: ${ctx.inboundId} at ${ctx.curPath} (retry ${attempt})`);
    return;
  }
  const delay = stamped.reason === "record-missing" ? undefined : stampRetryDelaysMs[attempt];
  ctx.log?.warn?.(
    formatStampDiagnostic({ kind: `${kind}-stamp-failed`, actor: ctx.agent, id: ctx.inboundId,
      path: stamped.path, code: stamped.code, obligation: stampObligationPresence(ctx.mailDir, ctx.agent, ctx.inboundId),
      retriesExhausted: stamped.reason !== "record-missing" && delay === undefined }),
  );
  if (delay === undefined || !isLiveContext(ctx)) return;
  const timer = accountTimer(ctx, () => stampTerminalCur(ctx, kind, patch, attempt + 1), delay);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
}


/**
 * Land the ack transition on the record the receipt evidence was scanned from
 * (cli#1059 round 2). `expect.from`/`expect.revision` name that snapshot and
 * `expect.replyId` the reply the evidence was found for, so a write that landed
 * after the scan, or a `replyId` replaced at the same revision, refuses this
 * ack. Returns `stale` when the write was refused (the caller rescans
 * the fresh record) or `retry-scheduled` when the fresh record is unverified
 * (the read helper routed it through the retry state unless a deadline timer
 * is already armed).
 */
function ackObligation(
  ctx: YieldContext,
  obligationId: string,
  why: string,
  patch: Partial<ObligationRecord> = {},
  stampCur = true,
  expect?: { from: ObligationState; revision: number; replyId?: string },
): "acked" | "stale" | "retry-scheduled" {
  if (!isLiveContext(ctx)) return "stale";
  // Only stamp the inbound when the ACK TRANSITION actually landed. A terminal
  // record (e.g. a deadline that already FAILED the obligation) refuses the
  // transition (obligations.ts: TERMINAL_STATES is final, never resurrected)
  // and must not get an ackedAt — otherwise a late final acks the inbound
  // while the obligation stays failed (cli#400).
  const updated = transitionObligation(ctx.mailDir, ctx.agent, ctx.inboundId, "acked", patch, ctx.log, expect);
  if (!updated || updated.state !== "acked") {
    const result = readObligationForCleanup(ctx, obligationId);
    if (result.status === "unverified") return "retry-scheduled";
    const cur = result.status === "found" ? result.record : null;
    ctx.log?.warn?.(
      `tps-mail: refusing to ack ${ctx.inboundId} — obligation is ${cur?.state ?? "gone"}; the inbound keeps no ackedAt`,
    );
    return "stale";
  }
  // A missing cur/ entry has no record to stamp (cli#1006).
  if (stampCur) stampTerminalCur(ctx, "ack", { ackedAt: new Date().toISOString(), read: true });
  ctx.log?.info?.(`tps-mail: acked ${ctx.inboundId} — ${why}`);
  releaseObligationState(obligationId);
  return "acked";
}

/**
 * THE VERB THAT ENDS AN OBLIGATION (cli#389 round 8) — the ONLY writer of
 * `failed` or `nackedAt` — and, since round 9, the ONLY sender of the nack mail
 * (item 2). It decides from the PERSISTED RECORD, never an in-memory flag:
 *
 *   evidence found                     → acked;
 *   delivering/posted, no evidence,
 *   no verdict                         → the terminal `unconfirmed`: NOT failed,
 *                                        NO nack mail, NO nack stamp, logged by
 *                                        name (we cannot prove non-delivery, so
 *                                        the sender is never told it failed);
 *   a definitive non-delivery verdict   → failed and nacked, even after commit.
 *
 * A definitive non-delivery verdict is a REFUSAL DECIDED BEFORE THE DELIVERY
 * CALL (no route, a named route failure such as `gal-without-remote`), or the
 * outbox drain quarantining THIS reply's own record (attributed by its reply
 * id, once it has stayed malformed for at least the partial-write grace, or was
 * dated 1 s or more in the future). A THROW FROM THE DELIVERY CALL IS NOT A VERDICT (cli#389
 * round 9, item 1): once `delivering` is persisted the bytes may already have
 * left, so a throw
 * — and any evidence step that threw — resolves by evidence or deadline, never
 * to `failed`. An unrelated `.malformed-*` marker is not a verdict either.
 *
 * EVERY transition to `failed` announces the sender from here (cli#389 round 9,
 * item 2): the same verdict gives the same sender-visible outcome whichever path
 * found it, and no caller mails on its own. Since round 10 (item 1) that
 * announcement is DURABLE and AT-LEAST-ONCE: the same write that settles the
 * failure records `nackPending`, the send is AWAITED, and a successful hand-off
 * records `nackSentAt` and clears the flag — so a crash between settling and
 * sending, or a send that could not be delivered, retries delivery on a later
 * start (once the store can be written) rather than leaving the sender never
 * told. A crash after the hand-off but before the record is written retries
 * delivery, so the sender may see the nack twice; the record keeps the debt
 * until a hand-off is recorded. `alreadyStamped` marks a failure whose cur/
 * record ALREADY
 * carries the nack (restart recovery of a record settled before the crash): the
 * record is settled and the stamp is not rewritten, but the MAIL is still owed
 * and is sent by the same rule as every other failure.
 *
 * Returns the state it applied; "stale" when the record the decision examined
 * moved; "retry-scheduled" when the retry state (or an already-armed deadline
 * timer) owns the next decision;
 * "none" when the record was gone or already terminal, the context is no
 * longer live, or the internal-inbound gate refused; and "write-failed" when
 * the failure or unconfirmed write itself threw (one attempt, no retry;
 * resolves on restart).
 */
async function internalInbound(ctx: YieldContext): Promise<boolean> {
  if (!isLiveContext(ctx)) return false;
  try {
    const record = readMailFile(ctx.curPath);
    if (!record) return false;
    if (!record.envelope && curPlacementRefusal(ctx.curPath, undefined) !== null) return false;
    const recovered = record.envelope
      ? await recoverPromoted(ctx.agent, ctx.curPath, {}, { waitForLock: true, mailboxRoot: join(ctx.mailDir, ctx.agent) })
      : await verifyRecordForMailbox(ctx.agent, record as any, mailRootForRecordPath(ctx.curPath));
    if (!record.envelope && curPlacementRefusal(ctx.curPath, undefined) !== null) return false;
    if (!isLiveContext(ctx) || !recovered.ok || recovered.message.trustTier === "external") return false;
    return recovered.message.from === ctx.sender && recovered.message.id === ctx.inboundId
      && (ctx.inboundEnvelopeId === undefined || recovered.message.envelopeId === ctx.inboundEnvelopeId);
  } catch { return false; }
}

async function settleObligation(
  ctx: YieldContext,
  obligationId: string,
  s: {
    /** The receipt evidence the caller found for this obligation. */
    receipt: "found" | "none";
    /** A definitive non-delivery verdict, when there is one. Never a step that
     *  merely threw. */
    verdict?: string;
    /** What to record when there is no verdict. */
    reason: string;
    /** The inbound ALREADY carries its nack stamp (restart recovery of a cur/
     *  record stamped before the crash): settle the RECORD and do not rewrite
     *  the stamp. The nack MAIL is a separate question and is still owed unless
     *  the record itself says it was sent. */
    alreadyStamped?: boolean;
    /** cli#1006: restart recovery or an in-process deadline is settling from
     *  the obligation RECORD because the inbound's cur/ entry is GONE. The record is the durable truth and this
     *  path dispatches no agent reply, so the internal-inbound gate (which
     *  binds the dispatch path) does not apply. The only mail settlement may
     *  send is a nack to the recorded sender; delivery retries follow the
     *  existing at-least-once contract. The allowance re-checks cur/ at the
     *  decision point: a restored entry takes the normal gate, and a failed
     *  lookup settles nothing. */
    missingCur?: boolean;
    /** The caller's ownership predicate for a deadline or retry decision: when
     *  the entry was released while the inbound verified, nothing is written. */
    owns?: () => boolean;
    /** cli#1059 round 2: the record the evidence for this decision was gathered
     *  from. When a write lands in between (including a same-state deadline
     *  extension or reply replacement), the decision is stale: nothing is
     *  written and the caller re-evaluates the fresh record or leaves it to its
     *  deadline.
     *  Every non-ack verdict also carries the reply identity it was gathered
     *  for (round 3; the missing-cur receipt-none verdict in round 7), and a
     *  pre-commit verdict the state it expects. */
    decision?: { revision: number; deadlineAt: string | null; replyId?: string; state?: ObligationState };
  },
): Promise<"acked" | "unconfirmed" | "failed" | "none" | "stale" | "retry-scheduled" | "write-failed"> {
  if (!isLiveContext(ctx)) return "none";
  beforeSettleEntryForTests?.(ctx.inboundId);
  // Recheck placement at settlement; a context can outlive a refused attempt.
  const cur = lookupObligationCur(ctx, obligationId);
  if (cur.status === "error") {
    reportObligationFailure(ctx, obligationId, `cur/ lookup failed (${cur.code})`);
    return "retry-scheduled";
  }
  const missingCur = s.missingCur === true && cur.status === "missing";
  if (!missingCur && !(await internalInbound(ctx))) return "none";
  if (!isLiveContext(ctx)) return "none";
  beforeSettleReadForTests?.(ctx.inboundId);
  // A check that lost its owning entry while the inbound verified writes
  // nothing; the entry's new owner decides.
  if (s.owns !== undefined && !s.owns()) return "none";
  const result = readObligationForCleanup(ctx, obligationId);
  if (result.status === "unverified") return "retry-scheduled";
  if (result.status !== "found") return "none";
  const rec = result.record;
  if (TERMINAL_STATES.has(rec.state)) {
    ctx.log?.info?.(
      `tps-mail: obligation ${rec.obligationId} is ${rec.state}; ignoring the ${s.verdict ?? s.reason} determination`,
    );
    return "none";
  }
  if (s.decision !== undefined &&
      ((rec.revision ?? 0) !== s.decision.revision ||
       (rec.deadlineAt ?? null) !== (s.decision.deadlineAt ?? null) ||
       (s.decision.replyId !== undefined && (rec.replyId ?? undefined) !== s.decision.replyId) ||
       (s.decision.state !== undefined && rec.state !== s.decision.state))) {
    // The record this decision examined moved: neither the deadline extension
    // nor the reply replacement may be overwritten with the old conclusion.
    ctx.log?.info?.(
      `tps-mail: obligation ${rec.obligationId} moved from revision ${s.decision.revision} (deadline ${s.decision.deadlineAt ?? "none"}) ` +
        `to revision ${rec.revision ?? 0} (deadline ${rec.deadlineAt ?? "none"}); redoing the decision on the fresh record`,
    );
    return "stale";
  }
  if (s.receipt === "found" && !s.verdict) {
    return ackObligation(
      ctx,
      obligationId,
      s.reason,
      missingCur ? { missingCurReason: MISSING_CUR_REASON } : {},
      !missingCur,
      { from: rec.state, revision: rec.revision ?? 0, replyId: rec.replyId },
    );
  }
  const committed = rec.state === "delivering" || rec.state === "posted";
  if (!s.verdict && committed) {
    // ONE ATTEMPT at the store too (cli#389 round 10, item 2): a store that
    // cannot be written leaves the record where it is — logged by name, never
    // retried in a loop — and the obligation resolves on the next start.
    try {
      const appliedUnconfirmed = transitionObligation(
        ctx.mailDir,
        ctx.agent,
        ctx.inboundId,
        "unconfirmed",
        {
          failure: s.reason,
          ...(missingCur ? { missingCurReason: MISSING_CUR_REASON } : {}),
        },
        ctx.log,
        { from: rec.state, revision: rec.revision ?? 0 },
      );
      if (appliedUnconfirmed === null) {
        const result = readObligationForCleanup(ctx, obligationId);
        if (result.status === "unverified") return "retry-scheduled";
        // cli#1006 r10: readObligationForCleanup released a terminal or gone
        // record. A STILL-LIVE one (another writer moved it, e.g. to `posted`)
        // needs its deadline re-armed — the fired one is already disarmed, and
        // a past-deadline startup settlement never had one — so schedule the
        // retry that re-reads and re-arms it. When that re-arm lands, the
        // deadline rescans the evidence instead of reusing this decision; a
        // failed arm schedules the next bounded retry (cli#1059).
        const cur = result.status === "found" ? result.record : null;
        const live = cur !== null && !TERMINAL_STATES.has(cur.state);
        ctx.log?.warn?.(
          `tps-mail: refusing to record the unconfirmed outcome for ${ctx.inboundId} — obligation is ${cur?.state ?? "gone"}; ` +
            (live ? "it keeps its state and is left to its deadline" : "it stays as it is"),
        );
        if (live) {
          reportObligationFailure(ctx, obligationId);
          return "retry-scheduled";
        }
        return "none";
      }
    } catch (err: any) {
      ctx.log?.warn?.(
        `tps-mail: obligation-write-failed: could not record the unconfirmed outcome for ${ctx.inboundId} ` +
          `(${err?.message ?? err}); one attempt, no retry — the obligation resolves on restart`,
      );
      return "write-failed";
    }
    releaseObligationState(obligationId);
    ctx.log?.warn?.(
      `tps-mail: obligation for ${ctx.inboundId} UNCONFIRMED: ${s.reason} — the reply was committed (${rec.state}) ` +
        `and no receipt evidence was found by its deadline; NOT failed, no nack sent`,
    );
    return "unconfirmed";
  }
  const failedOn = s.verdict ?? s.reason;
  // cli#389 round 10, item 1: the SAME write that sets `failed` records that a
  // nack mail is OWED (`nackPending`), so a crash before or during the send is
  // visible to restart recovery instead of leaving the sender never told.
  //
  // cli#389 round 10, item 2: ONE ATTEMPT. If the store cannot be written the
  // failure cannot be recorded — there is nothing to retry against in this
  // process, and a loop would only spin on a broken store — so it is logged by
  // name and the obligation is left to resolve at the next start, exactly like
  // the write-ahead whose own write failed. `transitionObligation` returns null
  // (not a throw) for a record that is GONE or already terminal; that is a
  // different case — nothing to settle, and the null is not an error.
  let appliedFailed: ObligationRecord | null;
  try {
    appliedFailed = transitionObligation(
      ctx.mailDir,
      ctx.agent,
      ctx.inboundId,
      "failed",
      {
        failure: failedOn,
        nackPending: true,
        ...(missingCur ? { missingCurReason: MISSING_CUR_REASON } : {}),
      },
      ctx.log,
      { from: rec.state, revision: rec.revision ?? 0 },
    );
  } catch (err: any) {
    ctx.log?.warn?.(
      `tps-mail: obligation-write-failed: could not record the failure for ${ctx.inboundId} ` +
        `(${err?.message ?? err}); one attempt, no retry — the obligation resolves on restart`,
    );
    return "write-failed";
  }
  if (appliedFailed === null) {
    const result = readObligationForCleanup(ctx, obligationId);
    if (result.status === "unverified") return "retry-scheduled";
    // cli#1006 r10: readObligationForCleanup released a terminal or gone
    // record. A STILL-LIVE one (another writer moved it, e.g. to `posted`)
    // keeps no timer here — the fired deadline is already disarmed, and a
    // past-deadline startup settlement never had one — so schedule the retry
    // that re-reads and re-arms it. When that re-arm lands, the deadline
    // rescans the evidence instead of reusing this decision; a failed arm
    // schedules the next bounded retry (cli#1059).
    const cur = result.status === "found" ? result.record : null;
    const live = cur !== null && !TERMINAL_STATES.has(cur.state);
    ctx.log?.warn?.(
      `tps-mail: refusing to record the failure for ${ctx.inboundId} — obligation is ${cur?.state ?? "gone"}; ` +
        (live ? "it keeps its state and is left to its deadline" : "the inbound keeps no nack stamp and no nack mail is sent"),
    );
    if (live) {
      reportObligationFailure(ctx, obligationId);
      return "retry-scheduled";
    }
    return "none";
  }
  // The failure is terminal: drop the context and its timer before the nack is
  // handed off (cli#403).
  releaseObligationState(obligationId);
  // A missing cur/ entry has no record to stamp; the obligation record carries
  // the outcome (cli#1006).
  if (!s.alreadyStamped && !missingCur) {
    stampTerminalCur(ctx, "nack", { nackedAt: new Date().toISOString(), nackReason: failedOn });
  }
  // cli#389 round 10, item 1: AWAIT the one send, and record its outcome on the
  // record. The mail is owed until `nackSentAt` says otherwise (at-least-once).
  const nackHandedOff = await deliverNack(ctx, failedOn, { allowMissingInbound: missingCur });
  if (!isLiveContext(ctx)) return "none";
  ctx.log?.warn?.(
    `tps-mail: obligation for ${ctx.inboundId} FAILED: ${failedOn} — nacked` +
      (s.alreadyStamped ? ", the inbound already carried its nack" : "") +
      (nackHandedOff ? ", sender notified" : ", the nack mail is still OWED (nackPending) — the next start retries delivery") +
      ", never acked",
  );
  return "failed";
}

/**
 * Hand a settled failure's nack mail to its route and record the outcome on the
 * obligation record (cli#389 round 10, item 1). The caller is the verb that
 * settled the failure, and it AWAITS this — the mail is no longer a fire-and-
 * forget promise a crash can swallow.
 *
 *   handed to a route → `markNackSent`: `nackSentAt` recorded, `nackPending`
 *                       cleared, in one write on the record;
 *   no route, or a route that threw → the record KEEPS `nackPending` and the
 *                       attempt is logged by name, so a later start retries
 *                       delivery
 *                       (at-least-once: a crash between the two writes
 *                       duplicates a mail; it never loses one);
 *   handed, but the record write FAILED → the mail has left and the record
 *                       still owes it: logged by name (round 11, item 2) and a
 *                       later start may hand it over again.
 *
 * Never throws into the caller. Returns true when the mail reached a route, so
 * the caller can say what actually happened to the sender.
 */
async function deliverNack(
  ctx: YieldContext,
  reason: string,
  opts: { timeoutMs?: number; ackTimeoutMs?: number; allowMissingInbound?: boolean } = {},
): Promise<boolean> {
  if (!isLiveContext(ctx)) return false;
  let handedOff = false;
  try {
    handedOff = await sendNackMail(ctx, reason, opts);
  } catch (err: any) {
    if (!isLiveContext(ctx)) return false;
    ctx.log?.warn?.(`tps-mail: could not deliver the nack for ${ctx.inboundId}: ${err?.message ?? err}`);
    handedOff = false;
  }
  if (!isLiveContext(ctx)) return false;
  if (handedOff) {
    // cli#389 round 11, item 2: the hand-off LANDED, but the record that says so
    // may not have. A failed write is logged BY NAME inside markNackSent, never
    // ignored — and the record still owes the mail, so a later start may hand it
    // over again. The line here says which of the two happened.
    const recorded = markNackSent(ctx.mailDir, ctx.agent, ctx.inboundId, ctx.log);
    ctx.log?.warn?.(
      `tps-mail: nack delivered to ${ctx.sender} for ${ctx.inboundId}` +
        (recorded ? "" : " — the record could not be updated: it still owes the nack and a later start may send it again"),
    );
    return true;
  }
  ctx.log?.warn?.(
    `tps-mail: nack-pending: the sender was NOT told about the failure of ${ctx.inboundId} (${reason}); ` +
      `the obligation record keeps nackPending and the next start retries delivery`,
  );
  return false;
}

/**
 * cli#389 round 12, item 1 (CodeRabbit, Major): retry ONE owed nack OFF the
 * startup path. Awaited, an unreachable branch — whose connect has no
 * application-level timeout — stalled recovery for this agent and every later
 * one. The retry's connection is bounded; the relay bounds the send above that
 * and then waits the ACK window, closing the transport when one of its timers
 * expires. The background backstop sits above the relay's WHOLE bound. Of the
 * relay's timer expiries, an expired connection or send bound takes the
 * `nack-retry-timeout` branch in sendNackMail; an expired ACK window rejects as
 * delivery unconfirmed and is logged as `could not deliver the nack`, keeping
 * nackPending.
 *
 * Never throws into the caller: it is fire-and-forget, so a rejection would
 * otherwise be unhandled.
 */
function retryOwedNackInBackground(
  mailDir: string,
  agentId: string,
  sender: string,
  inboundId: string,
  reason: string,
  accountId: string,
  cfg: any,
  log: any,
  incarnation: symbol,
  inboundEnvelopeId?: string,
  allowMissingInbound = false,
): void {
  if (!isLiveContext({ accountId, incarnation })) return;
  const timeoutMs = resolveNackRetryTimeoutMs();
  let ackTimeoutMs: number | undefined;
  let backstopMs = timeoutMs + NACK_RETRY_BACKSTOP_MS;
  // Resolve the sender's route with the same resolver sendNackMail uses, inside
  // the try: only the remote-branch route waits on the ACK window, and a
  // resolver that throws must not escape this fire-and-forget retry into its
  // caller.
  try {
    const route = routeFor(mailDir, cfg, accountId, sender);
    if (route.kind === "remote-branch") {
      ackTimeoutMs = resolveMailAckTimeoutMs();
      // The bound and the backstop above it come from the relay
      // (`remoteDeliveryWorstCaseMs`), never from arithmetic copied here. Both
      // checks sit in this try: a window the relay refuses, and a backstop a
      // timer cannot hold (it would clamp to 1 ms and log a false timeout at
      // once), are the same refusal, and neither may fail the startup loop.
      const deliveryBoundMs = remoteDeliveryWorstCaseMs({ timeoutMs, ackTimeoutMs });
      backstopMs = deliveryBoundMs + NACK_RETRY_BACKSTOP_MS;
      if (backstopMs > MAX_TIMER_DELAY_MS) {
        throw new MailAckTimeoutConfigError(
          `the relay's ${deliveryBoundMs}ms worst-case delivery bound plus the ${NACK_RETRY_BACKSTOP_MS}ms retry backstop ` +
            `exceeds the ${MAX_TIMER_DELAY_MS}ms timer limit`,
        );
      }
    }
  } catch (err: any) {
    if (err instanceof MailAckTimeoutConfigError) {
      // A malformed TPS_MAIL_ACK_TIMEOUT_MS — or one whose timers cannot fit —
      // must not fail the startup loop. The retry cannot compute its backstop
      // without a window it can hold, so it is not attempted and the record
      // keeps owing the nack.
      log?.warn?.(
        `tps-mail: nack-retry-config: the owed nack for ${inboundId} to ${sender} was not attempted (${err?.message ?? err}); ` +
          `the record keeps nackPending`,
      );
    } else {
      // A resolver that throws is the same refusal: nothing was handed to a
      // route, so the record keeps owing the nack, and the caller is untouched.
      log?.warn?.(
        `tps-mail: nack-retry-route: could not resolve the route for the owed nack for ${inboundId} to ${sender} ` +
          `(${err?.message ?? err}); the retry was not attempted and the record keeps nackPending`,
      );
    }
    return;
  }
    // BACKSTOP: a remote-branch retry sits above the relay's whole bound, so it
  // only needs a later net to guarantee the fire-and-forget promise never hangs
  // the process here. Every other route gets `timeoutMs` plus the same backstop:
  // a local nack reads a transcript and signs before it writes, so a 2 s net
  // logged a false timeout while the delivery was still running.
  const recCurPath = findCurPath(mailDir, agentId, inboundId);
  const ctx = makeYieldCtx(
    mailDir,
    agentId,
    sender,
    accountId,
    recCurPath ?? resolve(mailDir, agentId, "cur", `${inboundId}.json`),
    inboundId,
    cfg,
    log,
    incarnation,
    inboundEnvelopeId,
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<"expired">((res) => {
    timer = accountTimer(ctx, () => res("expired"), backstopMs);
    if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
  void Promise.race([
    deliverNack(ctx, reason, { timeoutMs, ackTimeoutMs, allowMissingInbound }).then(
      () => "done" as const,
      () => "done" as const,
    ),
    expired,
  ])
    .then((outcome) => {
      if (!isLiveContext(ctx)) return;
      if (outcome === "expired") {
        log?.warn?.(
          `tps-mail: nack-retry-timeout: the owed nack for ${inboundId} to ${sender} did not settle within ${backstopMs}ms; ` +
            `the retry stopped waiting for it, and a record that ` +
            `still owes the nack keeps nackPending`,
        );
      }
    })
    .catch((err: any) => {
      if (!isLiveContext(ctx)) return;
      log?.warn?.(`tps-mail: nack-retry-failed: the owed nack for ${inboundId} to ${sender} threw: ${err?.message ?? err}`);
    })
    .finally(() => {
      if (timer) clearAccountTimer(accountId, timer);
    });
}

/**
 * WRITE-AHEAD (cli#389 round 8, item 1): persist `delivering` BEFORE the delivery
 * call, so a crash mid-delivery is distinguishable from a crash before it and a
 * restart reads what the call was about to do.
 *
 * Returns true only when the write LANDED (`delivering` is on the record).
 *
 * cli#389 round 9, item 4: a TERMINAL record REFUSES the late final. The
 * transition returns null for a refusal (obligations.ts), so this logs
 * `late-final-refused` BY NAME and returns false — a final arriving after the
 * obligation CLOSED must NOT be delivered, whatever told the sender what. The
 * obligation may have closed as `unconfirmed`, which tells the sender nothing at
 * all (cli#389 round 10, item 3: the reason is closure, not "the sender was told
 * it failed"). False also when the record is GONE or the write itself threw: nothing has been sent, so the caller fails and nacks
 * exactly as before.
 */
function markDelivering(mailDir: string, agent: string, inboundId: string, log: any): boolean {
  try {
    if (transitionObligation(mailDir, agent, inboundId, "delivering", {}, log) !== null) return true;
    // Refused or gone — distinguish the two so the log names the real case.
    const current = readObligation(mailDir, agent, inboundId);
    if (current && TERMINAL_STATES.has(current.state)) {
      log?.warn?.(
        `tps-mail: late-final-refused: obligation ${current.obligationId} for ${inboundId} is ${current.state}; ` +
          `the late final is NOT delivered`,
      );
    }
    return false;
  } catch (err: any) {
    log?.warn?.(
      `tps-mail: obligation-write-failed: could not mark ${inboundId} delivering (${err?.message ?? err}); ` +
        `nothing was sent`,
    );
    return false;
  }
}

type ArmDeadlineOutcome =
  | { outcome: "armed" }
  | { outcome: "refused"; reason: "inactive" | "gone" | "terminal" | "moved" | "injected" | "scheduled" }
  | { outcome: "error"; error: string; verifiedState?: ObligationState };

/** Arm (or re-arm) the yield deadline from the record's deadlineAt, reporting
 *  whether a timer was armed. cli#1059: a caller must be able to tell a failed
 *  arm from a silent refusal, so it can schedule another attempt instead of
 *  leaving a live record without a timer. A store lock or write that throws is
 *  reported as `error`, never allowed to escape into the caller's dispatch
 *  catch (where it would settle a live obligation as "dispatch failed").
 *
 *  This is the running owner's entry point — a fired deadline or a retry check
 *  — and `armDeadline` calls it when no entry exists. Every other caller goes
 *  through `armDeadline`, which consults the retry state machine first. */
function armDeadlineNow(
  ctx: YieldContext,
  obligationId: string,
  deadlineAt?: string | null,
  patch: Partial<ObligationRecord> = {},
): ArmDeadlineOutcome {
  try {
    return armDeadlineOnce(ctx, obligationId, deadlineAt, patch);
  } catch (err: any) {
    return { outcome: "error", error: err?.message ?? String(err) };
  }
}

/** The ONE entry point every NON-OWNING caller uses. A scheduled, running or
 *  exhausted retry entry owns the next decision, so this neither arms a timer
 *  nor writes the record; only an absent entry arms here. The running owner
 *  (armDeadlineNow) arms directly. An exhausted entry reopens only through the
 *  state machine's verified live-state move. */
function armDeadline(
  ctx: YieldContext,
  obligationId: string,
  deadlineAt?: string | null,
  patch: Partial<ObligationRecord> = {},
): ArmDeadlineOutcome {
  if (!isLiveContext(ctx)) return { outcome: "refused", reason: "inactive" };
  if (obligationRetries.has(obligationId)) {
    retryObligationRead(ctx, obligationId, "deadline arm deferred to the retry state");
    return { outcome: "refused", reason: "scheduled" };
  }
  return armDeadlineNow(ctx, obligationId, deadlineAt, patch);
}

function armDeadlineOnce(
  ctx: YieldContext,
  obligationId: string,
  deadlineAt?: string | null,
  patch: Partial<ObligationRecord> = {},
): ArmDeadlineOutcome {
  if (!isLiveContext(ctx)) return { outcome: "refused", reason: "inactive" };
  if (armDeadlineFaultForTests?.(ctx.inboundId)) return { outcome: "refused", reason: "injected" };
  beforeArmReadForTests?.(ctx.inboundId);
  let updated: ObligationRecord | null = null;
  // Arming must preserve committed delivery state: the deadline distinguishes
  // `unconfirmed` from `failed`. Re-read once if the record moves before writing.
  for (let attempt = 0; attempt < 2 && !updated; attempt++) {
    const result = readObligationForCleanup(ctx, obligationId);
    if (result.status === "unverified") {
      // The read helper routed this record through the retry state (unless a
      // deadline timer is already armed).
      return { outcome: "refused", reason: "scheduled" };
    }
    if (result.status === "missing") return { outcome: "refused", reason: "gone" };
    if (TERMINAL_STATES.has(result.record.state)) return { outcome: "refused", reason: "terminal" };
    const rec = result.record;
    // cli#1059 round 2: the CURRENT record owns the deadline. A stored argument
    // may predate a same-state extension that landed before this read, and
    // arming with it would overwrite the extension.
    const currentDeadline = usableDeadline(rec.deadlineAt);
    const at = currentDeadline ?? usableDeadline(deadlineAt) ?? new Date(obligationNow() + obligationDeadlineMs()).toISOString();
    const next: ObligationState = rec.state === "pending" || rec.state === "yielded" ? "yielded" : rec.state;
    recordVerifiedRetryState(obligationId, rec.state);
    try {
      updated = transitionObligation(ctx.mailDir, ctx.agent, ctx.inboundId, next, { ...patch, deadlineAt: at }, ctx.log, {
        from: rec.state,
        revision: rec.revision ?? 0,
      });
    } catch (err: any) {
      // The read verified this state even though the write did not land: carry
      // it so an exhausted budget still has a baseline to compare against.
      return { outcome: "error", error: err?.message ?? String(err), verifiedState: rec.state };
    }
  }
  if (!updated) return { outcome: "refused", reason: "moved" };
  const at = updated.deadlineAt!;
  const remaining = Math.max(0, Date.parse(at) - obligationNow());
  const prev = armedDeadlines.get(obligationId);
  if (prev) clearAccountTimer(prev.accountId, prev.timer);
  // A deadline beyond the runtime's timer limit still arms: the callback reads
  // the record again and waits out the remainder, so the delay is capped while
  // the durable deadline keeps its original time.
  const timer = accountTimer(ctx, () => {
    armedDeadlines.delete(obligationId);
    void onDeadline(ctx, obligationId);
  }, Math.min(remaining, obligationTimerCapMsForTests ?? MAX_TIMER_DELAY_MS));
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  armedDeadlines.set(obligationId, { accountId: ctx.accountId, timer });
  return { outcome: "armed" };
}

/** A deadline string `Date.parse` can read — ISO 8601, or any other form the
 *  runtime accepts (e.g. "Nov 21 2026") — this code can schedule from.
 *  Anything else is ignored so a fallback is used instead. */
function usableDeadline(value: string | null | undefined): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Schedule the next bounded attempt after an arm that did not land. Only a
 *  RETRYABLE refusal schedules a re-check: a gone or terminal record has nothing
 *  to arm, an inactive incarnation is shutting down, and `scheduled` means the
 *  retry state already owns the next decision — none of them may start one. */
function retryAfterArmFailure(ctx: YieldContext, obligationId: string, arm: ArmDeadlineOutcome): void {
  if (arm.outcome === "armed") return;
  if (arm.outcome === "refused" && (arm.reason === "gone" || arm.reason === "terminal" || arm.reason === "inactive" || arm.reason === "scheduled")) return;
  reportObligationFailure(
    ctx,
    obligationId,
    arm.outcome === "error" ? arm.error : `deadline re-arm refused (${arm.reason})`,
    arm.outcome === "error" ? arm.verifiedState : undefined,
  );
}

/** A yield event asks for an arm. `armDeadline` consults the retry state
 *  machine: while an attempt is pending or running its ownership stands, and an
 *  exhausted budget stays exhausted until shutdown, a later check that finds the
 *  record gone or terminal, or a verified live state move. Neither case arms or
 *  writes from the event. */
function armObligationFromEvent(ctx: YieldContext, obligationId: string): void {
  if (!isLiveContext(ctx)) return;
  retryAfterArmFailure(ctx, obligationId, armDeadline(ctx, obligationId));
}

async function onDeadline(ctx: YieldContext, obligationId: string): Promise<void> {
  if (!isLiveContext(ctx)) return;
  // cli#1059 round 6: the fired deadline claims the same per-obligation entry as
  // every other retry decision. It takes ownership before its first await, so an
  // event, arm failure or replay in its window records a re-check instead of
  // deciding; the deadline cannot decide alongside a retry check.
  if (obligationRetries.has(obligationId)) {
    retryObligationRead(ctx, obligationId);
    return;
  }
  const entry: ObligationRetryEntry = {
    kind: "running",
    accountId: ctx.accountId,
    incarnation: ctx.incarnation,
    attempt: 0,
    recheckWanted: false,
  };
  obligationRetries.set(obligationId, entry);
  const owns = () => obligationRetries.get(obligationId) === entry;
  try {
    const outcome = await settleObligationAtDeadline(ctx, obligationId, { owner: true, owns });
    // A check that no longer owns its entry (released, exhausted or replaced
    // during an await) writes nothing further.
    if (!owns()) return;
    if (outcome.status === "error") {
      finishObligationRetry(ctx, obligationId, 0, outcome.error);
      return;
    }
    if (outcome.status === "none" || outcome.status === "retry-scheduled") {
      completeObligationRetry(ctx, obligationId);
      return;
    }
    // `write-failed` is one attempt with no retry, and a settled,
    // re-armed or gone/terminal record has no next decision: none of them may
    // schedule a continuation.
    clearObligationRetry(obligationId);
  } catch (err: any) {
    if (!isLiveContext(ctx) || !owns()) return;
    ctx.log?.warn?.(
      `tps-mail: obligation-retry-failed: obligation ${obligationId} for inbound ${ctx.inboundId}: ${err?.message ?? err}`,
    );
    finishObligationRetry(ctx, obligationId, 0, `deadline check threw: ${err?.message ?? err}`);
  }
}

/** What the deadline check decided. The caller must distinguish these: only a
 *  retryable failure (`error`) lets the caller schedule another bounded
 *  attempt; `retry-scheduled` means the retry state owns the next decision,
 *  and `none` decides nothing, so both complete through the retry state, which
 *  schedules one continuation when a re-check was requested while the check
 *  ran; `write-failed` is the one-attempt store write that threw and resolves
 *  on restart; `settled`, `re-armed`, `gone-or-terminal` and `write-failed` end
 *  the budget.
 *
 * When the record has a parseable deadline at or before now, the deadline's own
 * decision — re-read the record, re-scan the receipts, redo the cur/ lookup — is
 * shared by the fired deadline and every bounded retry. A null or unparseable
 * deadline arms a fresh window without the receipt scan. The decision runs
 * against a named record snapshot (`decision`); if that record moved, the
 * evidence and the deadline decision are redone on the fresh record. */
type DeadlineOutcome =
  | { status: "settled" }
  | { status: "gone-or-terminal" }
  | { status: "re-armed" }
  | { status: "retry-scheduled" }
  | { status: "write-failed" }
  | { status: "none" }
  | { status: "error"; error: string };

async function settleObligationAtDeadline(
  ctx: YieldContext,
  obligationId: string,
  opts: { owner?: boolean; owns?: () => boolean } = {},
): Promise<DeadlineOutcome> {
  const owned = () => opts.owns === undefined || opts.owns();

  // At most two passes: a record that moves between the evidence and the
  // settlement gets both redone once; further churn is left to a bounded
  // retry rather than a loop.
  for (let pass = 0; pass < 2; pass++) {
    const result = readObligationForCleanup(ctx, obligationId);
    if (result.status === "unverified") {
      // The read helper routed an unverified record through the retry state
      // (a next attempt, or an already-exhausted budget); this is not a verdict
      // and not a second attempt.
      return { status: "retry-scheduled" };
    }
    if (result.status !== "found" || TERMINAL_STATES.has(result.record.state)) return { status: "gone-or-terminal" };
    const rec = result.record;
    // The deadline path's verified read is a baseline too (cli#1059 round 6):
    // the reopen rule must see what this decision saw.
    recordVerifiedRetryState(obligationId, rec.state);
    const parsedDeadline = rec.deadlineAt === null ? NaN : Date.parse(rec.deadlineAt);
    if (!Number.isFinite(parsedDeadline) || parsedDeadline > obligationNow()) {
      // The deadline moved forward after this check began (cli#1059 round 2):
      // re-arm from the fresh record rather than settling at the old deadline.
      // A null or unparseable deadline has no due time to settle, so it arms a
      // fresh window instead of failing a live record.
      const at = Number.isFinite(parsedDeadline)
        ? rec.deadlineAt!
        : new Date(obligationNow() + obligationDeadlineMs()).toISOString();
      const armed = opts.owner
        ? armDeadlineNow(ctx, obligationId, at)
        : armDeadline(ctx, obligationId, at);
      if (armed.outcome === "armed") return { status: "re-armed" };
      if (armed.outcome === "refused" && armed.reason === "scheduled") return { status: "retry-scheduled" };
      if (armed.outcome === "refused" &&
          (armed.reason === "gone" || armed.reason === "terminal" || armed.reason === "inactive")) {
        return { status: "gone-or-terminal" };
      }
      retryAfterArmFailure(ctx, obligationId, armed);
      return { status: "retry-scheduled" };
    }
    const decision = { revision: rec.revision ?? 0, deadlineAt: rec.deadlineAt, replyId: rec.replyId };
    const receipt = await scanObligationReceipt(ctx, obligationId, rec, rec.replyId);
    if (!isLiveContext(ctx) || !owned()) return { status: "none" };
    const cur = lookupObligationCur(ctx, obligationId);
    if (cur.status === "error") return { status: "error", error: `cur/ lookup failed (${cur.code})` };
    // The ownership decision was made before the scan; re-check it before the
    // settlement is allowed to write.
    if (!owned()) return { status: "none" };
    // cli#389 round 8: the deadline's own evidence check runs through the ONE verb.
    // The scan's ATTRIBUTED quarantine (the drain quarantined THIS reply's own
    // record once it had stayed malformed for at least the partial-write grace, or was
    // dated 1 s or more in the future) is a definitive non-delivery: the obligation fails and
    // nacks even though its delivery committed. With no evidence and no verdict, a
    // committed record becomes `unconfirmed` (no nack mail, no nack stamp) and only
    // a record that never committed fails and is announced to the sender.
    const reason = "yielded-without-resumption";
    const verdict = receipt.status === "malformed" && receipt.ownRecord ? "receipt-malformed" : undefined;
    // cli#389 round 9, item 2: the VERB announces a failure — this caller does not
    // mail on its own, so the deadline and the turn's own scan give the sender the
    // same outcome. cli#389 round 10, item 1: AWAIT that send here too, so the
    // deadline's own nack has landed (and its outcome is on the record) before
    // this path finishes; the mail is at-least-once, and a start retries
    // delivery of anything still owed.
    let applied: Awaited<ReturnType<typeof settleObligation>>;
    try {
      applied = await settleObligation(ctx, obligationId, {
        receipt: receipt.status === "found" ? "found" : "none",
        verdict,
        reason,
        // A restored inbound must pass the normal gate; the marker is historical.
        missingCur: cur.status === "missing",
        ...(opts.owns ? { owns: opts.owns } : {}),
        decision,
      });
    } catch (err: any) {
      // cli#1059 round 9: a receipt-found settlement's ack transition throws
      // rather than returning `write-failed`; the deadline and retry checks
      // treat it as `write-failed` (one attempt).
      if (receipt.status !== "found") throw err;
      ctx.log?.warn?.(
        `tps-mail: obligation-write-failed: could not record the ack for ${ctx.inboundId} ` +
          `(${err?.message ?? err}); one attempt, no retry — the obligation resolves on restart`,
      );
      return { status: "write-failed" };
    }
    if (!owned()) return { status: "none" };
    if (applied === "stale") continue; // redo the evidence and the deadline decision
    if (applied === "acked" || applied === "unconfirmed" || applied === "failed") return { status: "settled" };
    if (applied === "retry-scheduled") return { status: "retry-scheduled" };
    if (applied === "write-failed") return { status: "write-failed" };
    return { status: "none" };
  }
  reportObligationFailure(ctx, obligationId, "the obligation record changed while the deadline check ran");
  return { status: "retry-scheduled" };
}

/**
 * Settle a receipt-found decision against the record it was scanned from, and
 * rescan the FRESH record once, under the scanner's receipt rules, if a
 * same-state write landed under the ack (cli#1059 round 2). Returns `stale`
 * when the fresh record is gone, terminal or unverified, its rescan finds no
 * receipt, or the second ack is refused too. An unverified fresh read returns
 * `stale` without a rescan, and the retry path can route that outcome into the
 * bounded retry.
 */
async function settleScannedReceipt(
  ctx: YieldContext,
  obligationId: string,
  scanned: { revision?: number; deadlineAt: string | null; replyId?: string },
  expectedReplyId: string | undefined,
  opts: { missingCur?: boolean } = {},
): Promise<"acked" | "stale" | "retry-scheduled" | "none"> {
  let decision = scanned;
  for (let pass = 0; pass < 2; pass++) {
    const applied = await settleObligation(ctx, obligationId, {
      receipt: "found",
      reason: "receipt found",
      ...(opts.missingCur ? { missingCur: true } : {}),
      decision: {
        revision: decision.revision ?? 0,
        deadlineAt: decision.deadlineAt,
        replyId: decision.replyId,
      },
    });
    if (applied === "acked") return "acked";
    if (applied === "retry-scheduled") return "retry-scheduled";
    if (applied !== "stale") return "none";
    if (pass === 1) break;
    const fresh = readObligationResult(ctx.mailDir, ctx.agent, ctx.inboundId);
    if (fresh.status !== "found" || TERMINAL_STATES.has(fresh.record.state)) return "stale";
    const receipt = await scanObligationReceipt(ctx, obligationId, fresh.record, fresh.record.replyId ?? expectedReplyId);
    if (receipt.status !== "found") return "stale";
    decision = fresh.record;
  }
  return "stale";
}

/**
 * Apply a receipt-quarantined verdict against the record the quarantined
 * marker was scanned from (cli#1059 round 3). The scanned revision and reply
 * identity travel with the verdict: if a same-state writer replaced `replyId`
 * (or otherwise moved the record), a fresh read that is found and live is
 * scanned again for the reply it now names before deciding, so one reply's
 * quarantine is not applied to the reply a replacement now names. A gone,
 * terminal or unverified fresh read returns `stale` without a rescan.
 */
async function settleScannedQuarantine(
  ctx: YieldContext,
  obligationId: string,
  scanned: { revision?: number; deadlineAt: string | null; replyId?: string },
  opts: { missingCur?: boolean } = {},
): Promise<"settled" | "stale" | "retry-scheduled" | "write-failed" | "none"> {
  const done = <T extends "settled" | "stale" | "retry-scheduled" | "write-failed" | "none">(outcome: T): T => {
    quarantineOutcomeForTests?.(obligationId, outcome);
    return outcome;
  };
  let decision = scanned;
  for (let pass = 0; pass < 2; pass++) {
    const applied = await settleObligation(ctx, obligationId, {
      receipt: "none",
      verdict: "receipt-malformed",
      reason: "receipt-malformed",
      ...(opts.missingCur ? { missingCur: true } : {}),
      decision: {
        revision: decision.revision ?? 0,
        deadlineAt: decision.deadlineAt,
        replyId: decision.replyId,
      },
    });
    if (applied === "failed") return done("settled");
    if (applied === "retry-scheduled") return done("retry-scheduled");
    // A thrown store write resolves on restart (one attempt, no retry); a
    // missing/gone/terminal record has nothing to do. Neither is `stale`, which
    // would rescan and re-arm.
    if (applied === "write-failed") return done("write-failed");
    if (applied === "none") return done("none");
    if (applied !== "stale") return done("none");
    if (pass === 1) break;
    const fresh = readObligationResult(ctx.mailDir, ctx.agent, ctx.inboundId);
    if (fresh.status !== "found" || TERMINAL_STATES.has(fresh.record.state)) return done("stale");
    // Re-scan for the reply the FRESH record names before reusing a verdict.
    const receipt = await scanObligationReceipt(ctx, obligationId, fresh.record, fresh.record.replyId);
    if (!(receipt.status === "malformed" && receipt.ownRecord)) return done("stale");
    decision = fresh.record;
  }
  return done("stale");
}

/** A pre-commit non-delivery verdict is only valid while the record has not
 *  committed. Settle it against a fresh snapshot; when the record is now
 *  delivering/posted, or moved under the settlement, leave it to its deadline
 *  instead of failing and nacking a committed record (cli#1059 round 3). */
async function settlePreCommitVerdict(
  ctx: YieldContext,
  obligationId: string,
  verdict: string,
  reason: string,
): Promise<void> {
  // Use the shared reader so an unverified record is logged like every other
  // settle path; it schedules a retry only when no deadline is armed.
  const snapshot = readObligationForCleanup(ctx, obligationId);
  if (snapshot.status === "unverified") return;
  if (snapshot.status !== "found" || TERMINAL_STATES.has(snapshot.record.state)) return;
  const rec = snapshot.record;
  if (rec.state !== "pending" && rec.state !== "yielded") {
    // A delivery is in flight or returned: the pre-commit verdict no longer
    // applies, so the record keeps its state and is left to its deadline.
    retryAfterArmFailure(ctx, obligationId, armDeadline(ctx, obligationId));
    return;
  }
  const applied = await settleObligation(ctx, obligationId, {
    receipt: "none",
    verdict,
    reason,
    decision: {
      revision: rec.revision ?? 0,
      deadlineAt: rec.deadlineAt,
      replyId: rec.replyId,
      state: rec.state,
    },
  });
  if (applied === "stale") retryAfterArmFailure(ctx, obligationId, armDeadline(ctx, obligationId));
}

function makeYieldCtx(
  mailDir: string,
  agent: string,
  sender: string,
  accountId: string,
  curPath: string,
  inboundId: string,
  cfg: any,
  log: any,
  incarnation: symbol,
  inboundEnvelopeId?: string,
): YieldContext {
  return { mailDir, agent, sender, accountId, incarnation, curPath, inboundId, inboundEnvelopeId, cfg, log };
}

/**
 * cli#429: the signature check a receipt must pass — the SAME verification
 * promote() runs (verifyEnvelope through the always-constructed Flair client,
 * authenticated as the mailbox's own agent), so a receipt is accepted only when
 * the reply it carries is signed by the key Flair holds for its sender. The
 * scan itself requires that sender to be the obligated agent. A Flair outage
 * is logged by name and the candidate is NOT evidence: the obligation resolves
 * on a later scan or at its deadline (a committed one as `unconfirmed`, never
 * failed).
 */
function receiptSignatureCheck(ctx: YieldContext): ReceiptSignatureCheck {
  let client: ReturnType<typeof createMailVerifyClient> | null = null;
  return async (envelope) => {
    if (!isLiveContext(ctx)) return false;
    try {
      client ??= createMailVerifyClient(ctx.agent);
      const verifier = await client;
      if (!isLiveContext(ctx)) return false;
      const verdict = await verifyEnvelope(envelope, verifier);
      if (!isLiveContext(ctx)) return false;
      return verdict.ok && verifiedMailTier(envelope, ctx.mailDir) !== "external";
    } catch (err: any) {
      if (!isLiveContext(ctx)) return false;
      ctx.log?.warn?.(
        `tps-mail: receipt-verify-unavailable: the reply carried by a receipt for ${ctx.inboundId} could not be verified ` +
          `(${err?.message ?? err}); it is not evidence until a later scan verifies it`,
      );
      return false;
    }
  };
}

/**
 * The receipt scan for one obligation, with the thread its receipt must carry
 * taken from the obligation RECORD (cli#429, receiptThread): the inbound's
 * signed envelope id for a current record, its record id for a pre-cli#429
 * one. Every scan (the turn's own, the deadline's, recovery's) goes through
 * this, so all three check the same thread AND verify the same signature.
 */
function scanObligationReceipt(
  ctx: YieldContext,
  obligationId: string,
  rec: { inboundId: string; inboundEnvelopeId?: string },
  expectedReplyId: string | undefined,
): ReturnType<typeof scanForReceipt> {
  const thread = receiptThread(rec);
  return scanForReceipt(
    receiptDirs(ctx),
    obligationId,
    thread.threadId,
    ctx.agent,
    ctx.accountId,
    // The reply is owed to the inbound's VERIFIED sender: the receipt's signed
    // envelope must be addressed to it (cli#429).
    ctx.sender,
    receiptSignatureCheck(ctx),
    { expectedReplyId, threadMode: thread.mode },
  );
}

const warnedObligationCurLookups = new Set<string>();

/**
 * Report a failed cur/ lookup for an obligation at most once per process for
 * the same maildir, agent, inbound id AND error code: a later lookup that fails
 * with a DIFFERENT code is still reported. The startup pass and the in-process
 * deadline both go through this.
 */
function reportObligationCurLookupFailure(
  mailDir: string,
  agent: string,
  inboundId: string,
  obligationId: string,
  code: string,
  log: any,
): void {
  const key = `${resolve(mailDir, agent)}|${inboundId}|${code}`;
  if (warnedObligationCurLookups.has(key)) return;
  warnedObligationCurLookups.add(key);
  log?.warn?.(
    `tps-mail: obligation-cur-lookup-failed: obligation ${obligationId} for inbound ${inboundId}: the cur/ lookup failed (${code}); leaving the obligation untouched`,
  );
}

/** The missing-file allowance requires a clean lookup at the decision point. */
function lookupObligationCur(
  ctx: YieldContext,
  obligationId: string,
): { status: "missing" | "present" } | { status: "error"; code: string } {
  const faultCode = obligationCurLookupFaultForTests?.(ctx.inboundId);
  if (faultCode !== undefined) {
    reportObligationCurLookupFailure(ctx.mailDir, ctx.agent, ctx.inboundId, obligationId, faultCode, ctx.log);
    return { status: "error", code: faultCode };
  }
  const curDir = resolve(ctx.mailDir, ctx.agent, "cur");
  let error: string | undefined;
  // Past the scan limit, a match proves presence; a miss cannot prove absence.
  const found = findCurPath(
    ctx.mailDir,
    ctx.agent,
    ctx.inboundId,
    (path, code) => {
      if (code === "ENOENT" && path === curDir) return;
      error ??= code ?? "INVALID_JSON";
    },
    { presenceBeyondLimit: true },
  );
  if (error !== undefined) {
    reportObligationCurLookupFailure(ctx.mailDir, ctx.agent, ctx.inboundId, obligationId, error, ctx.log);
    return { status: "error", code: error };
  }
  if (found !== null) {
    ctx.curPath = found;
    return { status: "present" };
  }
  ctx.curPath = "";
  return { status: "missing" };
}

/**
 * cli#1006 — recovery for an open obligation whose inbound cur/ entry is GONE.
 *
 * The obligation record is the durable truth; cur/ only corroborates it. With no
 * record to verify there is nothing to dispatch, so this path settles from the
 * record: a verified receipt if one exists, otherwise the deadline verdict (re-arm while
 * the deadline is ahead; at/after it, the deadline's own terminal outcome).
 * The only mail settlement may send is a nack to the recorded sender; delivery
 * retries follow the existing at-least-once contract. The internal-inbound gate
 * does not apply because no agent reply is dispatched. The missing cur/ entry
 * is carried as the named `missingCurReason` field, not as a verdict.
 */
async function reconcileMissingCurObligation(ctx: YieldContext, obligationId: string): Promise<void> {
  if (!isLiveContext(ctx)) return;
  const result = readObligationForCleanup(ctx, obligationId);
  if (result.status !== "found" || TERMINAL_STATES.has(result.record.state)) return;
  const current = result.record;
  ctx.log?.warn?.(
    `tps-mail: obligation-missing-cur: obligation ${current.obligationId} for inbound ${current.inboundId}: ` +
      `the cur/ record is missing (${MISSING_CUR_REASON}); recovering from the obligation record`,
  );

  const receipt = await scanObligationReceipt(ctx, current.obligationId, current, current.replyId);
  if (!isLiveContext(ctx)) return;
  const cur = lookupObligationCur(ctx, obligationId);
  if (cur.status === "error") {
    // Nothing settles on an inconclusive lookup; the failure goes to the
    // bounded retry state, as the rescan's lookup error below does.
    reportObligationFailure(ctx, current.obligationId, `cur/ lookup failed (${cur.code})`);
    return;
  }
  if (cur.status === "present") {
    await reconcileObligation(ctx, current);
    return;
  }
  if (receipt.status === "found") {
    const applied = await settleScannedReceipt(ctx, current.obligationId, current, current.replyId, { missingCur: true });
    if (applied !== "stale") return;
    // The record moved under the ack, so `settleScannedReceipt` returned stale:
    // the fresh read was gone, terminal or unverified, its rescan found no
    // receipt, or the second ack was refused. Fall through to the record-based
    // deadline decision.
  }

  // Decide from the post-scan state. The store guard refuses a stale STATE or
  // REVISION after the re-read, so a same-state update is detected too (cli#1059).
  const fresh = readObligationForCleanup(ctx, current.obligationId);
  if (fresh.status !== "found" || TERMINAL_STATES.has(fresh.record.state)) return;
  const parsedDeadline = fresh.record.deadlineAt === null ? NaN : Date.parse(fresh.record.deadlineAt);
  if (!Number.isFinite(parsedDeadline) || parsedDeadline > Date.now()) {
    const at = Number.isFinite(parsedDeadline)
      ? fresh.record.deadlineAt!
      : new Date(Date.now() + obligationDeadlineMs()).toISOString();
    retryAfterArmFailure(
      ctx,
      current.obligationId,
      armDeadline(ctx, current.obligationId, at, { missingCurReason: MISSING_CUR_REASON }),
    );
    return;
  }

  // The deadline has passed: apply the deadline's own terminal outcome. Each
  // verdict travels with the snapshot its scan used. On the quarantine branch a
  // `stale` result re-arms the deadline and returns. On the receipt-`none`
  // branch a record that moved is re-read: a gone, terminal or unverified read
  // returns, and a future deadline re-arms, both without a rescan; a live record
  // past its deadline is rescanned before it is settled again.
  const reason = "yielded-without-resumption";
  const rearm = () =>
    retryAfterArmFailure(
      ctx,
      current.obligationId,
      armDeadline(ctx, current.obligationId, undefined, { missingCurReason: MISSING_CUR_REASON }),
    );
  if (receipt.status === "malformed" && receipt.ownRecord) {
    const applied = await settleScannedQuarantine(ctx, current.obligationId, current, { missingCur: true });
    if (applied === "stale") rearm();
    return;
  }
  // The receipt-`none` verdict was gathered for the reply `current` names. Pass
  // that snapshot: a replacement reply carrying its own receipt is judged on
  // its own evidence, never failed and nacked with the old reply's.
  let decision: { revision?: number; deadlineAt: string | null; replyId?: string } = current;
  for (let pass = 0; pass < 2; pass++) {
    const applied = await settleObligation(ctx, current.obligationId, {
      receipt: "none",
      reason,
      missingCur: true,
      decision: {
        revision: decision.revision ?? 0,
        deadlineAt: decision.deadlineAt,
        replyId: decision.replyId,
      },
    });
    if (applied !== "stale") return;
    if (pass === 1) break;
    // The record moved under the verdict: re-read it and redo the deadline
    // decision. When that read is found, live and past its deadline, the reply
    // it now names is rescanned before settling again; a gone, terminal or
    // unverified read returns, and a future deadline re-arms, both without a
    // rescan.
    const moved = readObligationForCleanup(ctx, current.obligationId);
    if (moved.status !== "found" || TERMINAL_STATES.has(moved.record.state)) return;
    const movedDeadline = moved.record.deadlineAt === null ? NaN : Date.parse(moved.record.deadlineAt);
    if (!Number.isFinite(movedDeadline) || movedDeadline > Date.now()) {
      const at = Number.isFinite(movedDeadline)
        ? moved.record.deadlineAt!
        : new Date(Date.now() + obligationDeadlineMs()).toISOString();
      retryAfterArmFailure(
        ctx,
        current.obligationId,
        armDeadline(ctx, current.obligationId, at, { missingCurReason: MISSING_CUR_REASON }),
      );
      return;
    }
    const rescanned = await scanObligationReceipt(ctx, current.obligationId, moved.record, moved.record.replyId);
    if (!isLiveContext(ctx)) return;
    // The inbound can return while the rescan runs. Re-check cur/ so a restored
    // record takes the gated recovery path (verification and stamp) instead of
    // settling with the missing-cur allowance.
    const curNow = lookupObligationCur(ctx, current.obligationId);
    if (curNow.status === "error") {
      // Nothing settles on an inconclusive lookup, but the record must not wait
      // for another event: a bounded retry re-reads it and the inbound.
      reportObligationFailure(ctx, current.obligationId, `cur/ lookup failed (${curNow.code})`);
      return;
    }
    if (curNow.status === "present") {
      await reconcileObligation(ctx, moved.record);
      return;
    }
    if (rescanned.status === "found") {
      const acked = await settleScannedReceipt(ctx, current.obligationId, moved.record, moved.record.replyId, { missingCur: true });
      if (acked === "stale") rearm();
      return;
    }
    if (rescanned.status === "malformed" && rescanned.ownRecord) {
      const quarantined = await settleScannedQuarantine(ctx, current.obligationId, moved.record, { missingCur: true });
      if (quarantined === "stale") rearm();
      return;
    }
    decision = moved.record;
  }
  rearm();
}

/**
 * Derive an obligation's truth from the maildir/outbox: a nacked cur/ record is
 * a failure; a posted marker is an ack; otherwise the work is outstanding and
 * the deadline is (re-)armed. Used by restart recovery and by a re-dispatch of
 * an inbound that already has an obligation — neither may post a second final.
 *
 * ASYNC since cli#389 round 10: settling a failure AWAITS the nack mail, so
 * recovery can hand a still-owed nack to the sender before it returns.
 */
async function reconcileObligation(
  ctx: YieldContext,
  rec: { obligationId: string; deadlineAt: string | null; inboundId: string; inboundEnvelopeId?: string; replyId?: string },
): Promise<void> {
  if (!isLiveContext(ctx)) return;
  // cli#1006: the record is the durable truth of the lifecycle; cur/
  // corroborates it. When the cur/ entry is gone there is no inbound to
  // re-verify and nothing to dispatch, so recovery settles or re-arms from the
  // obligation record itself. The dispatch path keeps its gate below.
  if (!ctx.curPath || !existsSync(ctx.curPath)) {
    await reconcileMissingCurObligation(ctx, rec.obligationId);
    return;
  }
  if (!(await internalInbound(ctx)) || !isLiveContext(ctx)) return;
  const curRec = ctx.curPath ? readMailFile(ctx.curPath) : null;
  if (curRec?.nackedAt) {
    // cli#389 round 9, item 3: an OLD stamp is NOT a verdict. A stamp left by
    // earlier behaviour must not fail a record whose own persisted state says the
    // delivery COMMITTED (`delivering`/`posted`): for those, recovery decides by
    // evidence and deadline like every other path, and the stamp is KEPT on the
    // cur/ record. For a record that never committed (pending/yielded) the stamp
    // says a failure was determined before the crash: settle the RECORD through
    // the ONE verb with `alreadyStamped`, so the stamp is not rewritten. The
    // nack MAIL is a separate, durable question (cli#389 round 10, item 1): the
    // verb sends it unless the record itself records that it was sent, so a
    // stamp alone never proves the sender was told.
    const current = readObligation(ctx.mailDir, ctx.agent, ctx.inboundId);
    if (current && !TERMINAL_STATES.has(current.state) && current.state !== "delivering" && current.state !== "posted") {
      const reason = curRec.nackReason ?? "nacked";
      // Bind the settlement to the snapshot whose state was checked: a move to
      // `posted` during the verb's internal-inbound await must not fail and nack
      // a committed record.
      const applied = await settleObligation(ctx, rec.obligationId, {
        receipt: "none",
        verdict: reason,
        reason,
        alreadyStamped: true,
        decision: {
          revision: current.revision ?? 0,
          deadlineAt: current.deadlineAt,
          replyId: current.replyId,
          state: current.state,
        },
      });
      if (applied === "stale") retryAfterArmFailure(ctx, rec.obligationId, armDeadline(ctx, rec.obligationId));
      return;
    }
    if (current && TERMINAL_STATES.has(current.state)) return;
  }
  const receipt = await scanObligationReceipt(ctx, rec.obligationId, rec, rec.replyId);
  if (!isLiveContext(ctx)) return;
  if (receipt.status === "found") {
    const applied = await settleScannedReceipt(ctx, rec.obligationId, rec, rec.replyId);
    if (applied === "stale") retryAfterArmFailure(ctx, rec.obligationId, armDeadline(ctx, rec.obligationId));
    return;
  }
  retryAfterArmFailure(ctx, rec.obligationId, armDeadline(ctx, rec.obligationId, rec.deadlineAt));
}

/**
 * Hand a nack mail to the sender through the SAME locality decision as the
 * reply (cli#389) and report whether it reached a route (cli#389 round 10, item
 * 1 — the verb records that outcome on the obligation record and retries the
 * delivery when it is missing). `false` means the mail was NOT handed over:
 * either no route exists at all, or the route threw. Never throws.
 *
 * `opts.timeoutMs` (cli#389 round 12, item 1) is the bound for a wire nack's
 * CONNECTION; the relay bounds the send above it and waits `opts.ackTimeoutMs`
 * for the ACK. The relay CLOSES the transport when one of its timers expires.
 * An expired connection or send bound is logged BY NAME (`nack-retry-timeout`)
 * rather than as an ordinary delivery error, so an operator can distinguish a
 * timeout from an explicit refusal; an expired ACK window is logged as `could
 * not deliver the nack` and the record keeps nackPending.
 */
async function sendNackMail(
  ctx: YieldContext,
  reason: string,
  opts: { timeoutMs?: number; ackTimeoutMs?: number; allowMissingInbound?: boolean } = {},
): Promise<boolean> {
  if (!isLiveContext(ctx)) return false;
  // cli#1006: the only mail settlement may send is a nack to the recorded
  // sender; delivery retries follow the existing at-least-once contract. It
  // dispatches no agent reply, so the internal-inbound gate (which binds the
  // dispatch path) is bypassed only for two callers: the missing-cur settle,
  // and the owed-nack retry for a record carrying MISSING_CUR_REASON, after a
  // clean lookup still finds cur/ absent. Every other caller keeps it.
  if (!opts.allowMissingInbound && !(await internalInbound(ctx))) return false;
  if (!isLiveContext(ctx)) return false;
  const transcript = newestSessionTranscript(process.env.HOME ?? homedir(), ctx.agent);
  const detail = transcript
    ? `${reason}; the newest session transcript is ${transcript.path} (mtime ${transcript.mtime})`
    : `${reason}; no session transcript was found under the agent's sessions dir`;
  // cli#429: the nack threads on the inbound's SIGNED envelope id (from the
  // obligation record), signed inside the envelope like a reply. A record from
  // before cli#429 has none: that nack is signed but unthreaded.
  const thread = isValidEnvelopeId(ctx.inboundEnvelopeId) ? ctx.inboundEnvelopeId : undefined;
  const signed = signReplyEnvelope(ctx.agent, ctx.sender, detail, thread);
  if (!signed.ok) {
    // cli#429: NEVER an unsigned nack. A body a promote()-reading recipient
    // dead-letters tells the sender nothing — so nothing is sent, the failure
    // is logged BY NAME, and the record keeps nackPending: the next start
    // retries, and a provisioned key lets that retry go out.
    ctx.log?.warn?.(
      `tps-mail: nack-unsigned-refused: the nack for ${ctx.inboundId} to ${ctx.sender} was NOT sent — ` +
        `it could not be signed (${signed.reason}: ${signed.detail}); an unsigned nack is never sent`,
    );
    return false;
  }
  const message: TpsMailBody = {
    id: randomUUID(),
    from: ctx.agent,
    to: ctx.sender,
    body: signed.body,
    timestamp: new Date().toISOString(),
    ...(thread ? { replyToId: thread } : {}),
    accountId: ctx.accountId,
    headers: {
      "X-TPS-Trust": "agent",
      "X-TPS-Surface": CHANNEL_ID,
      // Bookkeeping: the inbound's LOCAL record id (never the thread).
      "X-TPS-InReplyTo": ctx.inboundId,
      "X-TPS-Nack": reason,
    },
    deliveryAttempts: 0,
  };
  try {
    // Route the nack through the SAME locality decision as the reply (cli#389).
    const route = routeFor(ctx.mailDir, ctx.cfg, ctx.accountId, ctx.sender);
    if (route.kind === "local") {
      writeMailFile(ctx.mailDir, ctx.sender, message);
    } else if (route.kind === "outbox") {
      writeOutboxFile(message);
    } else if (route.kind === "remote-branch") {
      await deliverRemote(message, route.branchId, { timeoutMs: opts.timeoutMs, ackTimeoutMs: opts.ackTimeoutMs });
      if (!isLiveContext(ctx)) return false;
    } else if (route.kind === "bridge") {
      deliverToSandbox(route.branchId, { to: ctx.sender, from: ctx.agent, body: message.body });
    } else {
      ctx.log?.warn?.(
        `tps-mail: no delivery route for the nack to ${ctx.sender} ` +
          `(${route.kind === "failed" ? route.reason : "no binding, no maildir, no remote branch, no bridge"}); the obligation record carries the failure`,
      );
      return false;
    }
    return true;
  } catch (err: any) {
    if (!isLiveContext(ctx)) return false;
    if (isRemoteDeliveryTimeout(err)) {
      // cli#389 round 12, item 1: one of the relay's own timers expired — the
      // connection bound, or the send bound above it — and it CLOSED the
      // transport. Logged BY NAME so the branch that could not be reached is
      // identifiable.
      ctx.log?.warn?.(
        `tps-mail: nack-retry-timeout: the owed nack for ${ctx.inboundId} to ${ctx.sender} exceeded the relay's ` +
          `${opts.timeoutMs ?? DEFAULT_NACK_RETRY_TIMEOUT_MS}ms connection bound or the send bound above it; ` +
          `the transport was closed, and the record keeps nackPending`,
      );
    } else {
      ctx.log?.warn?.(`tps-mail: could not deliver the nack for ${ctx.inboundId}: ${err?.message ?? err}`);
    }
    return false;
  }
}

/** True for the relay's bounded-timeout error (cli#389 round 12, item 1).
 *  Matched BY NAME so a module mock that does not re-export the class still
 *  classifies correctly. */
function isRemoteDeliveryTimeout(err: any): boolean {
  return err?.name === "RemoteDeliveryTimeoutError";
}

/**
 * YIELD DETECTION (primary): the run's lifecycle end event carries
 * `yielded: true` (verified on the pinned SDK's agent-event payload shape: a
 * `lifecycle`-stream event with `data` as an open record). The first turn's
 * events are keyed by `replyOptions.runId = obligationId`, so a yielded end
 * maps straight back to the obligation. If the subscription API is missing or
 * throws, the plugin falls back to SETTLEMENT-INFERENCE (see deliverPromoted).
 */
function installYieldSubscription(api: any): boolean {
  if (typeof api?.registerAgentEventSubscription !== "function") return false;
  api.registerAgentEventSubscription({
    id: "openclaw-tps-mail:yield-obligations",
    description: "Mark a tps-mail reply obligation yielded when its run ends without a posted final",
    streams: ["lifecycle"],
    handle: (event: any) => {
      const data = event?.data ?? {};
      const yielded = data.yielded === true || event?.yielded === true;
      if (!yielded) return;
      const runId = event?.runId;
      if (typeof runId !== "string") return;
      const ctx = yieldContexts.get(runId);
      if (!ctx) return;
      // The classified cleanup read releases a gone or terminal record; an
      // unverified read is not treated as missing, and it schedules a retry only
      // when no deadline is armed (reportObligationFailure returns otherwise).
      const result = readObligationForCleanup(ctx, runId);
      if (result.status !== "found") return;
      armObligationFromEvent(ctx, result.record.obligationId);
    },
  });
  return true;
}

function findCurPath(
  mailDir: string,
  agent: string,
  inboundId: string,
  onReadError?: (path: string, code?: string) => void,
  /** cli#1006 r10: past the scan limit, keep reading for a MATCH only. Presence
   *  can be proven that way; absence cannot, so an unmatched id still reports
   *  SCAN_LIMIT. */
  opts: { presenceBeyondLimit?: boolean } = {},
): string | null {
  const curDir = resolve(mailDir, agent, "cur");
  try {
    const names = readdirSync(curDir);
    const beyondLimit = onReadError !== undefined && names.length > 4096;
    if (beyondLimit && !opts.presenceBeyondLimit) {
      onReadError(curDir, "SCAN_LIMIT");
      return null;
    }
    let match: string | null = null;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const p = resolve(curDir, name);
      // Past the limit a read error on an unrelated entry cannot establish
      // absence, and a single match settles the question (a second reports
      // AMBIGUOUS_ID): scan without reporting unrelated errors.
      const rec = readMailFile(p, beyondLimit ? undefined : onReadError);
      if (rec?.id !== inboundId) continue;
      if (!onReadError) return p;
      if (match) {
        onReadError(curDir, "AMBIGUOUS_ID");
        return null;
      }
      match = p;
    }
    if (!match) {
      if (beyondLimit) onReadError?.(curDir, "SCAN_LIMIT");
      else onReadError?.(curDir, "ENOENT");
    }
    return match;
  } catch (err: any) {
    // cli#1006: readdir's ENOENT is a clean "nothing to scan" only when the
    // cur/ directory itself is absent. A dangling cur/ symlink also reads
    // ENOENT but exists, so it is a lookup ERROR, not an absence.
    if (err?.code === "ENOENT" && !curDirAbsent(curDir)) {
      onReadError?.(curDir, "DANGLING_SYMLINK");
    } else {
      onReadError?.(curDir, err?.code);
    }
  }
  return null;
}

/** True when `dir` does not exist; a dangling symlink is not absent. */
function curDirAbsent(dir: string): boolean {
  try {
    return lstatSync(dir, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

// ─── Channel Plugin ──────────────────────────────────────────────────────────

const config: ChannelConfigAdapter<TpsMailAccount> = {
  listAccountIds: (cfg: any) => {
    const accounts = cfg?.channels?.[CHANNEL_ID]?.accounts;
    if (!accounts || typeof accounts !== "object") {
      // If no accounts configured at all, assume a single "default" account
      // pointing at ~/.tps/mail so the plugin is usable out of the box.
      return ["default"];
    }
    return Object.keys(accounts);
  },
  resolveAccount: (cfg: any, accountId?: string | null): TpsMailAccount => {
    const id = accountId ?? "default";
    const mailDir = resolveMailDir(cfg, id);
    const enabled = cfg?.channels?.[CHANNEL_ID]?.enabled !== false;
    return { accountId: id, mailDir, enabled };
  },
  defaultAccountId: () => "default",
  isEnabled: (account) => account.enabled,
  isConfigured: (account) => existsSync(account.mailDir),
  unconfiguredReason: (account) => `TPS mail directory does not exist: ${account.mailDir}`,
};

/**
 * cli#433 (slice B1): sign a channel send through the ONE outbound signing
 * path — the `signForDelivery` helper the CLI's producers use, over the same
 * builder `tps mail send` calls — with the same key resolution and the same
 * named refusal when no key exists. A caller must never fall back to an
 * unsigned body: `promote()` dead-letters it terminal. The reply thread is
 * passed as `replyToId`, which the path validates and puts INSIDE the signed
 * envelope — the record gets no unsigned wrapper field.
 */
function signedOutboundEnvelope(from: string, to: string, body: string, replyToId?: string): string {
  let signed: string | null = null;
  signForDelivery(
    from,
    to,
    body,
    (envelope) => {
      signed = envelope;
    },
    {
      rationale: `agent ${from} openclaw-tps-mail sendText`,
      ...(replyToId !== undefined ? { replyToId } : {}),
    },
  );
  if (signed === null) {
    throw new Error(`cannot sign for agent "${from}": the signing path produced no envelope`);
  }
  return signed;
}

const outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async (ctx: ChannelOutboundContext) => {
    const sender = resolveOutboundSender(ctx);
    if (!sender) {
      return {
        ok: false,
        error: "tps-mail: outbound identity unknown — refusing to send anonymous mail",
      } as any;
    }

    const account = config.resolveAccount(ctx.cfg as any, ctx.accountId ?? "default");
    const now = new Date().toISOString();
    // cli#433 (slice B1): sign BEFORE anything is written, through the same path
    // `tps mail send` uses — an unsigned body is a dead letterbox. The thread
    // rides inside the signed envelope, so the record carries no wrapper
    // `replyToId` a reader could present as a thread that was never signed.
    let signedBody: string;
    try {
      signedBody = signedOutboundEnvelope(sender, ctx.to, ctx.text, ctx.replyToId ?? undefined);
    } catch (err: any) {
      return { ok: false, error: `tps-mail: ${err?.message ?? err}` } as any;
    }
    const message: TpsMailBody = {
      id: randomUUID(),
      from: sender,
      to: ctx.to,
      body: signedBody,
      timestamp: now,
      headers: {
        "X-TPS-Trust": "agent",
        "X-TPS-Surface": CHANNEL_ID,
      },
      deliveryAttempts: 0,
    };
    let delivered: { path: string; route: MailRoute["kind"] };
    try {
      delivered = await deliverOutboundMail(
        ctx.cfg as any,
        ctx.accountId ?? "default",
        account.mailDir,
        message,
      );
    } catch (err: any) {
      // (cli#389 rule 3) No route → a NAMED failure, never a silent write.
      return { ok: false, error: `tps-mail: ${err?.message ?? err}` } as any;
    }
    return {
      ok: true,
      id: message.id,
      externalId: message.id,
      details: { path: delivered.path, route: delivered.route },
    } as any;
  },
};

export const NEW_DIR_RESCAN_MS = 30_000;
/** cli#1063: how often a live account checks open obligations. */
export const OBLIGATION_DEADLINE_SWEEP_MS = 60_000;
export const MAX_NEW_FILE_TRANSIENT_FAILURES = 3;
/** cli#922 item 1: the cap on the rescan-tick backoff between watcher re-arm attempts. */
export const MAX_WATCHER_REARM_BACKOFF_TICKS = 32;

/**
 * cli#922 item 1: the wait before the next re-arm attempt, in rescan ticks.
 * Attempt 1 waits 1 tick and doubles per consecutive failure, capped.
 */
export function rearmBackoffTicks(failures: number): number {
  return Math.min(2 ** (failures - 1), MAX_WATCHER_REARM_BACKOFF_TICKS);
}

/** cli#1063: attempt to arm records without a usable deadline or settle due
 *  records, skipping records a timer or retry owns. */
function sweepObligationDeadlines(
  mailDir: string,
  agent: string,
  accountId: string,
  cfg: any,
  log: any,
  incarnation: symbol,
): void {
  for (const rec of listObligations(mailDir, agent, (path, code) => {
    log?.warn?.(`tps-mail: obligation-deadline-sweep-unreadable: ${path}: ${code ?? "invalid"}`);
  })) {
    if (TERMINAL_STATES.has(rec.state)) continue;
    if (armedDeadlines.has(rec.obligationId) || obligationRetries.has(rec.obligationId)) continue;
    const deadline = usableDeadline(rec.deadlineAt);
    if (deadline !== null && Date.parse(deadline) > obligationNow()) continue;
    let ctx = yieldContexts.get(rec.obligationId);
    if (!ctx) {
      ctx = makeYieldCtx(mailDir, agent, rec.from, accountId, "", rec.inboundId, cfg, log, incarnation, rec.inboundEnvelopeId);
      yieldContexts.set(rec.obligationId, ctx);
    }
    if (deadline === null) {
      retryAfterArmFailure(ctx, rec.obligationId, armDeadline(ctx, rec.obligationId, rec.deadlineAt));
    } else {
      void onDeadline(ctx, rec.obligationId).catch((err: any) => {
        log?.warn?.(`tps-mail: obligation-deadline-sweep-failed: ${rec.obligationId}: ${err?.message ?? err}`);
      });
    }
  }
}

const gateway: ChannelGatewayAdapter<TpsMailAccount> = {
  startAccount: async (ctx: ChannelGatewayContext<TpsMailAccount>) => {
    const { account, cfg, log } = ctx;
    endAccountLifetime(account.accountId);
    const channelRuntime = (ctx as any).channelRuntime;

    if (!channelRuntime) {
      log?.warn?.(
        "tps-mail: channelRuntime not available — plugin requires SDK 2026.2.19+",
      );
      return;
    }

    if (!existsSync(account.mailDir)) {
      log?.warn?.(`tps-mail: mail directory does not exist: ${account.mailDir}`);
      return;
    }

    // STARTUP GUARD (S2): two accounts resolving to the SAME mailDir would let
    // one account's receipt scan satisfy the other's obligation. Refuse by name.
    const conflict = mailDirConflict(cfg as any, account.accountId);
    if (conflict) {
      log?.warn?.(`tps-mail: refusing account ${account.accountId} — ${conflict}; two accounts on one mailDir is a misconfiguration`);
      return;
    }

    const boundAgents = findBoundAgents(cfg as any, account.accountId);
    if (boundAgents.length === 0) {
      log?.info?.(
        `tps-mail: no agents bound to channel ${CHANNEL_ID} account ${account.accountId}; idle`,
      );
      return;
    }

    log?.info?.(
      `tps-mail: watching ${boundAgents.length} agent inbox(es): ${boundAgents.join(", ")}`,
    );

    const incarnation = Symbol(account.accountId);
    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => { resolveShutdown = resolve; });
    const lifetime: AccountLifetime = { incarnation, timers: new Set(), intervals: new Set(), watchers: new Set(), resolveShutdown };
    accountLifetimes.set(account.accountId, lifetime);
    gatewayIncarnations.set(ctx, incarnation);
    if (ctx.abortSignal) signalIncarnations.set(ctx.abortSignal, incarnation);
    const accountContext = { accountId: account.accountId, incarnation };
    const isLive = () => isLiveContext(accountContext);
    const abort = () => {
      endAccountLifetime(account.accountId, incarnation);
      resolveShutdown();
    };
    ctx.abortSignal?.addEventListener("abort", abort, { once: true });
    if (ctx.abortSignal?.aborted) {
      abort();
      return;
    }
    const watchers = lifetime.watchers;
    // Path claims deduplicate in-flight attempts and suppress terminal outcomes.
    // Retained sources retry by dev/ino/size/mtime identity, up to the failure cap.
    //
    // Across restarts: promote() commits a verified cur/ record (or a dlq/ one)
    // BEFORE dispatch; removing the new/ source is best-effort, and a later
    // attempt on a leftover source still passes through the replay check.
    // Startup attempts recovery of eligible cur/ records through
    // re-verification; an existing obligation is reconciled rather than
    // dispatched again (at-least-once delivery is the contract).
    const seenFiles = new Set<string>();
    const transientFailures = new Map<string, { filePath: string; failures: number }>();

    function sourceIdentity(filePath: string): string | undefined {
      try {
        const stat = statSync(filePath, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
      } catch (err) {
        if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) return undefined;
        throw err;
      }
    }

    async function processNewFile(recipient: string, filePath: string, source?: "rescan"): Promise<void> {
      if (!isLive() || seenFiles.has(filePath)) return;
      if (!isMailboxMessageFile(basename(filePath))) return;
      const identity = sourceIdentity(filePath);
      if (identity === undefined) return;
      if ((transientFailures.get(identity)?.failures ?? 0) >= MAX_NEW_FILE_TRANSIENT_FAILURES) return;
      seenFiles.add(filePath);

      // ONE enforcement point, shared with the CLI: parse wrapper → envelope,
      // verify through an always-constructed Flair client, check recipient and
      // replay, and move new/ → cur/ (or dlq/ with a `.reason` sidecar). The
      // plugin carries no verification implementation of its own.
      let terminal = false;
      try {
        let promoted: Awaited<ReturnType<typeof promote>> | undefined;
        try {
          promoted = await promote(recipient, filePath);
        } catch (err: any) {
          log?.warn?.(`tps-mail: processNewFile error: ${err?.message ?? err}`);
        }
        if (!isLive()) return;
        if (!promoted?.ok) {
          if (sourceIdentity(filePath) !== undefined) {
            const failures = (transientFailures.get(identity)?.failures ?? 0) + 1;
            transientFailures.set(identity, { filePath, failures });
            if (failures >= MAX_NEW_FILE_TRANSIENT_FAILURES) {
              log?.warn?.(`tps-mail: promotion retry limit reached for ${filePath}; source suppressed`);
            }
          } else {
            transientFailures.delete(identity);
            terminal = promoted?.class === "replay"
              || sourceIdentity(resolve(dirname(filePath), "..", "dlq", basename(filePath))) === identity;
          }
          if (promoted) {
            log?.warn?.(
              `tps-mail: not promoted (${promoted.class}) for ${recipient}: ${promoted.reason}`,
            );
          }
          return;
        }
        terminal = true;
        transientFailures.delete(identity);
        await deliverPromoted(recipient, promoted.message, promoted.path, source === "rescan" ? filePath : undefined);
      } finally {
        if (!terminal) seenFiles.delete(filePath);
      }
    }

    /**
     * Crash-recovery re-dispatch of a cur/ record, gated on proof-of-promotion
     * and re-verification. cur/ is a DESTINATION directory: presenting from it
     * would bypass the new/ → cur/ enforcement point unless the record proves it
     * came through promote() (envelopeId + stored signed envelope) and still
     * verifies. recoverPromoted() enforces that and quarantines anything that
     * cannot prove provenance; a Flair outage leaves the record in cur/ for the
     * next start.
     */
    async function recoverUnackedCurRecord(recipient: string, curPath: string, record: TpsMailBody): Promise<void> {
      try {
        if (!isLive()) return;
        const recovered = await recoverPromoted(recipient, curPath, {}, { claim: recipient, mailboxRoot: join(account.mailDir, recipient) });
        if (!isLive()) return;
        if (!recovered.ok) {
          log?.warn?.(
            `tps-mail: cur/ recovery refused ${record.id} (${recovered.class}): ${recovered.reason}`,
          );
          return;
        }
        await deliverPromoted(recipient, recovered.message, curPath);
      } catch (err: any) {
        log?.warn?.(`tps-mail: cur/ recovery deferred for ${record.id}: ${err?.message ?? err}`);
      }
    }

    /**
     * Deliver an already-promoted (cur/) record.
     *
     * Shared by the new/ path (after promote()) and the startup recovery sweep
     * (after recoverPromoted() has re-established provenance and re-verified).
     * promote() moves a record to cur/ BEFORE dispatch, and ackedAt is written
     * only AFTER the turn returns; a gateway that exits in that window would
     * otherwise strand an unacked, undelivered record in cur/ forever, breaking
     * at-least-once.
     *
     * This does not re-enter promote(): the id is already consumed and promote()
     * would dead-letter it as a replay. The recovery path calls recoverPromoted()
     * for the re-check instead.
     */
    async function deliverPromoted(recipient: string, msg: TpsMailBody, curPath: string, rescanPath?: string): Promise<void> {
      if (!isLive()) return;
      if (msg.trustTier === "external") {
        log?.warn?.(`tps-mail: external-tier mail ${msg.id} not dispatched`);
        return;
      }
      if (seenFiles.has(curPath)) return;
      seenFiles.add(curPath);

      if (rescanPath) {
        log?.info?.(`tps-mail: promoted by rescan: ${rescanPath}`);
      }
      log?.info?.(`tps-mail: delivering ${msg.id} from ${msg.from} to ${recipient}`);
      // Session key: one conversation per (channel, sender) pair.
      // Using `dmScope: "per-channel-peer"` isolates each tps-mail sender
      // into their own session, so conversations build context over time
      // without polluting the recipient's `main` session used by Discord
      // and cron jobs.
      //
      // IMPORTANT: buildAgentSessionKey takes `peer: { kind, id }` — not
      // `conversationId` / `chatType`. Without the correct params it
      // silently falls back to `agent:<recipient>:main`, which defeats the
      // whole point of having a separate channel and re-pollutes main.
      const sessionKey = channelRuntime.routing?.buildAgentSessionKey?.({
        agentId: recipient,
        channel: CHANNEL_ID,
        accountId: account.accountId,
        peer: { kind: "direct", id: msg.from },
        dmScope: "per-channel-peer",
      }) ?? `agent:${recipient}:${CHANNEL_ID}:${account.accountId}:${msg.from}`;

      const envelope = buildEnvelope(msg);
      const rawMsgCtx: Record<string, any> = {
        BodyForAgent: envelope,
        RawBody: msg.body,
        Body: msg.body,
        CommandBody: msg.body,
        BodyForCommands: msg.body,
        SessionKey: sessionKey,
        From: msg.from,
        To: recipient,
        SenderId: msg.from,
        SenderName: msg.from,
        Surface: CHANNEL_ID,
        Provider: CHANNEL_ID,
        ChatType: "direct",
        MessageSid: msg.id,
        Timestamp: Date.parse(msg.timestamp) || Date.now(),
        AccountId: account.accountId,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: msg.from,
        ConversationLabel: `tps-mail:${msg.from}`,
      };

      // Promote MsgContext → FinalizedMsgContext so dispatch can run.
      // Falls back to the raw context with CommandAuthorized: false if the
      // runtime helper is missing (older SDK).
      const msgCtx = channelRuntime.reply?.finalizeInboundContext
        ? await channelRuntime.reply.finalizeInboundContext(rawMsgCtx)
        : { ...rawMsgCtx, CommandAuthorized: false };
      if (!isLive()) return;

      // ONE obligation-discharging post per inbound (cli#338 + S2). The
      // dispatcher's deliver callback receives blocks in order; we emit only
      // the FINAL message, once. There is deliberately NO suppression by "the
      // agent already sent something": the dispatcher's final is ALWAYS posted
      // and is the only obligation-discharging post.
      //
      // The obligation record is created HERE, keyed on the inbound id — a
      // replayed inbound finds its record and opens NO second obligation.
      const obligationId = randomUUID();
      let created: ReturnType<typeof createObligation>;
      try {
        created = createObligation(
          account.mailDir,
          recipient,
          () => ({
            obligationId,
            inboundId: msg.id,
            // cli#429: the durable thread id — the inbound's SIGNED envelope id
            // (promote()/recoverPromoted() stamp it, and the id rule holds there).
            ...(isValidEnvelopeId(msg.envelopeId) ? { inboundEnvelopeId: msg.envelopeId } : {}),
            inboundTimestamp: msg.timestamp,
            from: msg.from,
            to: recipient,
            accountId: account.accountId,
            state: "pending",
            // cli#1063: persist the deadline at creation so a later sweep can
            // attempt settlement at or after it when no timer is armed.
            deadlineAt: new Date(obligationNow() + obligationDeadlineMs()).toISOString(),
            attempts: 1,
          }),
          log,
        );
      } catch (err: any) {
        // A refused create (an unverified record) must not reject the intake:
        // the promoted inbound stays in cur/ for recovery after the record is
        // repaired.
        log?.warn?.(`tps-mail: obligation-create-failed: ${msg.id}: ${err?.message ?? err}`);
        return;
      }
      const obId = created.record.obligationId;
      const yieldCtx = makeYieldCtx(
        account.mailDir,
        recipient,
        msg.from,
        account.accountId,
        curPath,
        msg.id,
        cfg,
        log,
        incarnation,
        created.record.inboundEnvelopeId,
      );
      yieldContexts.set(obId, yieldCtx);

      // A replayed inbound (or a re-dispatch) must NOT open a SECOND obligation
      // and must NOT post a SECOND final: reconcile the existing record instead
      // (receipt → ack; nacked → failed; otherwise re-arm the deadline).
      if (!created.created) {
        log?.info?.(`tps-mail: inbound ${msg.id} already has obligation ${obId}; reconciling, not re-dispatching`);
        await reconcileObligation(yieldCtx, created.record);
        return;
      }

      // The turn's finals arrive one per OpenClaw `deliver` call, in order
      // (OpenClaw loops the turn's replies and enqueues each non-reasoning one
      // as kind "final"). The turn's LAST real final is the one to post —
      // keeping the FIRST posted the wrong text (cli#400). So: remember the
      // latest final that carries real text, and post exactly ONCE after the
      // dispatch resolves.
      let latestFinalText: string | null = null;
      // A final that was suppressed before delivery (empty, or the runtime's
      // silent token) is tracked so "the turn produced no postable final" is a
      // NAMED failure rather than a silent yield.
      let sawSuppressedFinal = false;
      let posted = false;
      // The reply id of the record this turn actually delivered (cli#389 round
      // 6, item 1): the receipt scan pins a receipt's `replyId` to it, so a body
      // copied from an OLDER reply under the current obligation and inbound ids
      // is not accepted. Null until a delivery commits.
      let postedReplyId: string | null = null;
      let postFailure: string | null = null;
      try {
        const dispatchResult: any = await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: msgCtx,
          cfg,
          // Key THIS turn's agent events by the obligation, so a yielded
          // lifecycle end maps straight back to it.
          replyOptions: { runId: obId },
          dispatcherOptions: {
            // REMEMBER, do not post: posting here would keep the FIRST final.
            // Real text only — and only the RAW silent tokens are caught here;
            // a host that rewrites NO_REPLY to a canned phrase is not filtered
            // (see SUPPRESSED_FINAL_TOKENS).
            deliver: async (payload: any, info: any) => {
              if (!isLiveContext(yieldCtx) || info?.kind !== "final") return;
              const text = extractFinalText(payload);
              if (!isPostableFinalText(text)) {
                // A raw silent token reached `deliver` (a host that rewrites
                // NO_REPLY is not filtered here, and 2026.5.7 with
                // silentReplyRewrite.direct = false delivers it verbatim):
                // remember it so the turn is a NAMED empty-final failure rather
                // than a 60-minute yield (cli#398 T2).
                sawSuppressedFinal = true;
                return;
              }
              latestFinalText = text;
            },
            // The runtime suppresses empty / silent finals BEFORE `deliver`
            // (normalizeReplyPayload → onSkip); observe the skip so a turn
            // whose only finals were silent is a NAMED failure.
            onSkip: (_payload: any, info: any) => {
              if (isLiveContext(yieldCtx) && info?.kind === "final") sawSuppressedFinal = true;
            },
          },
        });

        if (!isLiveContext(yieldCtx)) {
          log?.info?.(`tps-mail: old-incarnation-dispatch-ignored: ${msg.id}`);
          return;
        }

        // POST EXACTLY ONCE, after the dispatch has resolved.
        if (latestFinalText !== null) {
          const replyText = latestFinalText;
          // Requirement 4: sign the reply (Ed25519 + messageId). cli#429: the
          // thread is the inbound's SIGNED envelope id, signed INSIDE the
          // envelope; the inbound's record id is bookkeeping only.
          const thread = msg.envelopeId;
          const signed: SignedReply = isValidEnvelopeId(thread)
            ? signReplyEnvelope(recipient, msg.from, replyText, thread)
            : { ok: false, reason: `unthreadable-inbound:${msg.id}`, detail: "the inbound carries no valid signed envelope id" };
          if (!signed.ok) {
            postFailure = postFailure ?? signed.reason;
            log?.warn?.(
              `tps-mail: cannot sign the dispatcher reply from ${recipient} to ${msg.from} (${signed.reason}: ${signed.detail}); ` +
                `nothing is sent — an unsigned reply is never sent`,
            );
          } else {
            const reply: TpsMailBody = {
              id: randomUUID(),
              from: recipient,
              to: msg.from,
              body: signed.body,
              timestamp: new Date().toISOString(),
              // The SIGNED thread — the same value the envelope carries.
              replyToId: thread,
              accountId: account.accountId,
              headers: {
                "X-TPS-Trust": "agent",
                "X-TPS-Surface": CHANNEL_ID,
                // Bookkeeping: the inbound's LOCAL record id (never the thread).
                "X-TPS-InReplyTo": msg.id,
                // THE RECEIPT: the marker the ack scan keys on.
                "X-TPS-Obligation": obId,
              },
              deliveryAttempts: 0,
            };

            // (cli#389) Route the reply through the SAME locality decision as
            // `tps mail send` and the outbound adapter. The delivery call IS the
            // commit: `posted` is set only after it RETURNS, and a throw (or an
            // unknown recipient on the office) is a NAMED failure. NOTHING else
            // runs inside this try (cli#389 round 6, item 2) — the obligation
            // transition, the receipt write and the log line are evidence
            // UPKEEP, and each runs after the commit under its own guard, so a
            // transient failure there can never fail a delivered reply or nack
            // its inbound.
            let route: MailRoute | null = null;
            let deliveredVia: string | null = null;
            // THE COMMIT IS PERSISTED (cli#389 round 8, item 1). `posted` is written
            // to the RECORD the moment the delivery call RETURNS — never a flag in
            // memory — so a restart, the deadline path and the outer catch all read
            // the same truth. `posted` (the local) still drives this turn's own
            // branches; the transition is EVIDENCE UPKEEP, guarded by postCommit so
            // it can never fail a delivered reply.
            const commit = () => {
              if (!isLiveContext(yieldCtx)) return;
              posted = true;
              postCommit(
                log,
                "obligation-posted-transition-failed",
                `the ${route!.kind} reply ${reply.id} committed to ${msg.from} but the obligation for ${msg.id} was not marked posted`,
                () => transitionObligation(account.mailDir, recipient, msg.id, "posted", { replyId: reply.id }, log),
              );
            };
            try {
              route = routeFor(account.mailDir, cfg as any, ctx.accountId ?? "default", msg.from);
              if (route.kind === "failed" || route.kind === "unknown") {
                // An explicit delivery rejection (or no route at all): nothing is
                // sent, so this is a definitive non-delivery — fail and nack.
                postFailure = postFailure ?? (route.kind === "failed" ? route.reason : `no-route:${msg.from}`);
                log?.warn?.(
                  route.kind === "failed"
                    ? `tps-mail: refusing the reply to ${msg.from}: ${route.reason} (the GAL names branch ${route.branchId} with no remote registration)`
                    : `tps-mail: no delivery route for reply recipient ${msg.from} ` +
                        `(not bound to this gateway, no local maildir, no registered remote branch); refusing to write where nothing reads it`,
                );
              } else if (await internalInbound(yieldCtx) && isLiveContext(yieldCtx) && markDelivering(account.mailDir, recipient, msg.id, log)) {
                // WRITE-AHEAD (item 1): `delivering` is persisted BEFORE the call.
                if (route.kind === "local") {
                  writeMailFile(account.mailDir, msg.from, reply);
                  commit();
                } else if (route.kind === "outbox") {
                  deliveredVia = writeOutboxFile(reply);
                  commit();
                } else if (route.kind === "remote-branch") {
                  await deliverRemote(reply, route.branchId);
                  if (!isLiveContext(yieldCtx)) return;
                  commit();
                } else {
                  // The record carries the obligation ids, so this delivery stays
                  // locally readable even if the receipt write below fails.
                  deliverToSandbox(route.branchId, {
                    to: msg.from,
                    from: recipient,
                    body: reply.body,
                    ...obligationMetadata(reply),
                  });
                  commit();
                }
              } else {
                if (!isLiveContext(yieldCtx)) return;
                // Either the write-ahead write ITSELF failed — nothing has been
                // sent, so this is a pre-commit failure and the obligation fails
                // and nacks as before — or the record is already TERMINAL and
                // REFUSED the late final (cli#389 round 9, item 4): markDelivering
                // logged `late-final-refused`, the verb has already settled this
                // obligation, and a final arriving after the obligation CLOSED
                // is NOT delivered (cli#389 round 10, item 3: closure is the
                // reason, not "the sender was told it failed" — the obligation
                // may have closed as `unconfirmed`, which tells nobody anything).
                const cur = readObligation(account.mailDir, recipient, msg.id);
                if (!(cur && TERMINAL_STATES.has(cur.state))) {
                  postFailure = postFailure ?? "delivering-write-failed";
                }
              }
            } catch (err: any) {
              // cli#389 round 9, item 1: A THROW FROM THE DELIVERY CALL IS
              // UNCERTAIN, NOT A VERDICT. The call can throw AFTER the bytes left
              // (a timeout after send, a failure writing the local record after a
              // remote accept), and `delivering` was persisted BEFORE it — so when
              // the record says the call was in flight (or had returned), the
              // throw resolves by EVIDENCE OR DEADLINE instead of failing the
              // obligation and nacking the sender. Only a throw before the
              // write-ahead landed (nothing sent) fails and nacks as before.
              if (!isLiveContext(yieldCtx)) return;
              const at = readObligation(account.mailDir, recipient, msg.id);
              if (at && (at.state === "delivering" || at.state === "posted")) {
                log?.warn?.(
                  `tps-mail: delivery-uncertain: ${err?.message ?? err} — the obligation for ${msg.id} was already ` +
                    `${at.state} when the delivery call threw, so the reply may have gone out; NOT failed, NOT nacked, ` +
                    `it resolves by evidence or at its deadline`,
                );
              } else {
                postFailure = postFailure ?? `write-failed:${err?.message ?? err}`;
              }
            }

            // ── AFTER THE COMMIT (cli#389 round 6, item 2). Every step below
            // runs OUTSIDE the delivery try and under its own guard: it is
            // logged by name and NEVER sets postFailure, so a delivered reply is
            // never reported as failed and its inbound is never nacked.
            if (!isLiveContext(yieldCtx)) return;
            if (posted && route) {
              const r = route;
              postedReplyId = reply.id;
              const where =
                r.kind === "outbox"
                  ? `${r.kind}: ${deliveredVia}`
                  : r.kind === "remote-branch" || r.kind === "bridge"
                    ? `${r.kind}: ${r.branchId}`
                    : r.kind;
              postCommit(
                log,
                "reply-log-failed",
                `the ${r.kind} reply ${reply.id} committed to ${msg.from} but its log line failed`,
                () =>
                  log?.info?.(
                    `tps-mail: reply ${reply.id} from ${recipient} to ${msg.from} (via dispatcher, route=${where}; delivery committed)`,
                  ),
              );
              if (r.kind === "local" || r.kind === "remote-branch" || r.kind === "bridge") {
                // persistReceiptAfterCommit never throws: it logs
                // receipt-write-failed by name and cannot fail the send. The
                // local route too (cli#429 round 7): its posted record lives in
                // the recipient's maildir, which the recipient consumes.
                postCommit(
                  log,
                  "receipt-write-failed",
                  `the ${r.kind} reply ${reply.id} committed but its receipt was not written`,
                  () =>
                    persistReceiptAfterCommit(
                      account.mailDir,
                      recipient,
                      reply,
                      r.kind,
                      r.kind === "local" ? undefined : r.branchId,
                      log,
                    ),
                );
              }
            }
          }
        }

        // Read the runtime's failedCounts (diagnostic — a non-zero count with
        // no posted final is exactly the shape that used to ack silently).
        const failedCounts = dispatchResult?.failedCounts;
        if (failedCounts !== undefined) {
          yieldCtx.step = "failed-counts-log";
          log?.warn?.(`tps-mail: runtime failedCounts for ${msg.id}: ${JSON.stringify(failedCounts)}`);
        }

        // THE ACK IS GATED ON THE RECEIPT, never on the dispatch settling.
        // The scan and the disposition below both run AFTER a committed delivery,
        // so they are evidence upkeep: `step` names whichever is running, and the
        // ONE verb settles from the RECORD's persisted state (cli#389 round 8 —
        // `delivering`/`posted` are never failed by a mere throw).
        yieldCtx.step = "receipt-scan";
        // Bind the scan and the ack to ONE record snapshot (cli#1059 round 2).
        // The settlement carries the scanned record's revision; the receipt scan
        // uses the expected reply identity.
        beforeReceiptScanForTests?.(yieldCtx.inboundId);
        const scanSnapshot = readObligationResult(yieldCtx.mailDir, yieldCtx.agent, yieldCtx.inboundId);
        const scanRecord = scanSnapshot.status === "found" ? scanSnapshot.record : created.record;
        const expectedReplyId = scanRecord.replyId ?? postedReplyId ?? undefined;
        const receipt = await scanObligationReceipt(yieldCtx, obId, scanRecord, expectedReplyId);
        if (!isLiveContext(yieldCtx)) return;
        if (receipt.status === "found") {
          yieldCtx.step = "ack-transition";
          const applied = await settleScannedReceipt(yieldCtx, obId, scanRecord, expectedReplyId);
          if (applied === "stale") retryAfterArmFailure(yieldCtx, obId, armDeadline(yieldCtx, obId));
        } else if (receipt.status === "malformed" && receipt.ownRecord) {
          // cli#398 T4(e) RESTORED (cli#389 round 8) as ATTRIBUTABLE quarantine.
          // The drain quarantined THIS reply's own record — the quarantined name
          // still carries the reply id this obligation posted — once it had
          // stayed malformed for at least the partial-write grace, or was dated
          // 1 s or more in the future, so its non-delivery is DEFINITIVE: the obligation fails and
          // nacks, even though the delivery call returned. An unrelated
          // `.malformed-*` (a quarantine that cannot be tied to this reply) is
          // NOT a verdict: that falls through and resolves at the deadline.
          yieldCtx.step = "receipt-quarantined";
          const applied = await settleScannedQuarantine(yieldCtx, obId, scanRecord);
          if (applied === "stale") retryAfterArmFailure(yieldCtx, obId, armDeadline(yieldCtx, obId));
        } else if (postFailure) {
          yieldCtx.step = "post-failure";
          // The delivery call itself failed (or there was no route at all):
          // nothing was sent, so this is a definitive non-delivery — fail and
          // nack exactly as before, unless the record committed in between.
          await settlePreCommitVerdict(yieldCtx, obId, postFailure, postFailure);
        } else if (sawSuppressedFinal && latestFinalText === null) {
          // The turn produced finals, but every one was empty or silent — a
          // NAMED failure with a nack, never a silent yield. `latestFinalText`
          // must be null: a turn that POSTED a real final whose receipt is
          // absent is the committed-without-evidence path below, not this one.
          yieldCtx.step = "empty-final-text";
          await settlePreCommitVerdict(yieldCtx, obId, "empty-final-text", "empty-final-text");
        } else {
          // No final posted and no post failure: the run yielded without
          // resumption (subscription event, or settlement-inference). Stay
          // UNACKED in cur/ and arm the deadline; the deadline's scan decides,
          // and a COMMITTED record (posted, evidence not visible yet) resolves
          // there to `acked` or `unconfirmed` — never failed, never nacked.
          retryAfterArmFailure(yieldCtx, obId, armDeadline(yieldCtx, obId));
          // …unless the record is already TERMINAL: a late final the write-ahead
          // refused (cli#389 round 9, item 4) is settled, not "unresolved", and
          // is announced by name as `late-final-refused` instead.
          const live = readObligation(yieldCtx.mailDir, yieldCtx.agent, yieldCtx.inboundId);
          if (live && !TERMINAL_STATES.has(live.state)) {
            log?.warn?.(
              `tps-mail: obligation for ${msg.id} is unresolved (no receipt evidence yet); deadline armed`,
            );
          }
        }
      } catch (err: any) {
        if (!isLiveContext(yieldCtx)) {
          log?.info?.(`tps-mail: old-incarnation-dispatch-ignored: ${msg.id}`);
          return;
        }
        const reason = `dispatch failed: ${err?.message ?? String(err)}`;
        log?.warn?.(`tps-mail: dispatch failed for ${msg.id}: ${err?.message ?? String(err)}`);
        // cli#389 round 8: the PERSISTED RECORD tells a post-commit evidence step
        // from a failure of the dispatch itself — a flag in the turn's memory
        // could not (round 7's guard had to refuse the verb instead). A committed
        // obligation (`delivering`/`posted`) is NOT failed and its inbound is NOT
        // nacked: the step is logged BY NAME and the normal deadline is ARMED, so
        // it still resolves to `acked` (if the evidence appears) or `unconfirmed`
        // — never stranded. A throw from the dispatch itself arrives with the
        // record still pending/yielded and fails and nacks exactly as before.
        const rec = readObligation(yieldCtx.mailDir, yieldCtx.agent, yieldCtx.inboundId);
        if (rec && (rec.state === "delivering" || rec.state === "posted")) {
          log?.warn?.(
            `tps-mail: post-commit-error:${yieldCtx.step ?? "unnamed-step"}: ${reason} — the delivery for ${msg.id} ` +
              `committed (${rec.state}), so it is NOT failed and its inbound is NOT nacked; it resolves at its deadline`,
          );
          retryAfterArmFailure(yieldCtx, obId, armDeadline(yieldCtx, obId));
        } else {
          await settlePreCommitVerdict(yieldCtx, obId, reason, reason);
        }
      }
    }

    let resolveSweepDone!: () => void;
    startupSweepDone.set(account.accountId, new Promise<void>((resolve) => { resolveSweepDone = resolve; }));

    // Launch a watcher per agent inbox.
    for (const agentId of boundAgents) {
      if (!isLive()) break;
      const newDir = resolve(account.mailDir, agentId, "new");
      if (!existsSync(newDir)) {
        mkdirSync(newDir, { recursive: true });
      }
      const pendingWatchFiles = new Set<string>();
      let rescanning = false;
      // cli#922 item 1: a watcher that emits "error" is stopped by the OS. The
      // rescan tick is the only place that re-arms it (never the error handler,
      // which can spin against a path that still fails): one attempt per tick,
      // with an exponential backoff on repeated failures.
      let activeWatcher: FSWatcher | null = null;
      let watcherStopped = false;
      let rearmFailures = 0;
      let rearmDelayTicks = 1;
      let lastRearmTick = Number.NEGATIVE_INFINITY;
      let tickIndex = 0;

      const attachWatcher = (): FSWatcher => {
        const watcher = fsWatch(newDir, { persistent: true }, (_event, filename) => {
          if (!isLive() || !filename) return;
          const filePath = resolve(newDir, String(filename));
          if (!existsSync(filePath)) return;
          pendingWatchFiles.add(filePath);
          // Debounce: fs.watch can fire multiple events per file write.
          accountTimer(accountContext, () => {
            pendingWatchFiles.delete(filePath);
            processNewFile(agentId, filePath).catch((err) => {
              log?.warn?.(`tps-mail: processNewFile error: ${err?.message ?? err}`);
            });
          }, 50);
        });
        // cli#720: an error stops the watcher (Bun on Linux reports one when a
        // file under new/ moves out while the watch is being set up). Log it
        // instead of letting it throw; the rescan tick below re-arms it, and
        // until then the rescan still reads new/.
        watcher.on("error", (err) => {
          if (watcher !== activeWatcher || watcherStopped) return;
          watcherStopped = true;
          log?.warn?.(
            `tps-mail: new/ watcher for ${agentId} stopped: ${err?.message ?? String(err)}; ` +
              `new mail is picked up by the rescan every ${NEW_DIR_RESCAN_MS / 1000}s until it re-arms`,
          );
        });
        watchers.add(watcher);
        activeWatcher = watcher;
        return watcher;
      };

      const rearmIfStopped = () => {
        if (!watcherStopped || !isLive()) return;
        if (tickIndex - lastRearmTick < rearmDelayTicks) return;
        lastRearmTick = tickIndex;
        if (activeWatcher) {
          watchers.delete(activeWatcher);
          try { activeWatcher.close(); } catch { /* ignore */ }
          activeWatcher = null;
        }
        try {
          attachWatcher();
          watcherStopped = false;
          rearmFailures = 0;
          rearmDelayTicks = 1;
          lastRearmTick = Number.NEGATIVE_INFINITY;
          log?.info?.(`tps-mail: new/ watcher for ${agentId} re-armed`);
        } catch (err: any) {
          rearmFailures++;
          rearmDelayTicks = rearmBackoffTicks(rearmFailures);
          log?.warn?.(
            `tps-mail: new/ watcher for ${agentId} still failing after ${rearmFailures} re-arm attempt(s): ` +
              `${err?.message ?? String(err)}; next attempt in ${rearmDelayTicks} rescan tick(s)`,
          );
        }
      };

      const rescan = async () => {
        if (!isLive() || rescanning) return;
        rescanning = true;
        tickIndex++;
        try {
          rearmIfStopped();
          const filenames = await readdir(newDir);
          const present = new Set(filenames.map((filename) => resolve(newDir, filename)));
          for (const [identity, { filePath }] of transientFailures) {
            if (dirname(filePath) === newDir && (!present.has(filePath) || sourceIdentity(filePath) !== identity)) {
              transientFailures.delete(identity);
            }
          }
          for (const filename of filenames) {
            if (!isLive()) break;
            const filePath = resolve(newDir, filename);
            if (pendingWatchFiles.has(filePath)) continue;
            void processNewFile(agentId, filePath, "rescan").catch((err) => {
              log?.warn?.(`tps-mail: processNewFile error: ${err?.message ?? err}`);
            });
          }
        } catch (err: any) {
          log?.warn?.(`tps-mail: new/ rescan error for ${agentId}: ${err?.message ?? err}`);
        } finally {
          rescanning = false;
        }
      };
      const rescanInterval = setInterval(() => { void rescan(); }, NEW_DIR_RESCAN_MS);
      lifetime.intervals.add(rescanInterval);
      const deadlineSweep = setInterval(() => {
        if (!isLive()) return;
        sweepObligationDeadlines(account.mailDir, agentId, account.accountId, cfg, log, incarnation);
      }, obligationDeadlineSweepMs());
      lifetime.intervals.add(deadlineSweep);
      if (typeof (deadlineSweep as any).unref === "function") (deadlineSweep as any).unref();

      try {
        try {
          attachWatcher();
        } catch (err) {
          // No watcher was created; let the rescan tick try again.
          watcherStopped = true;
          throw err;
        }

        // Process any files already present (but not in seenFiles) in case
        // the gateway starts up after mail was already written.
        try {
          for (const filename of readdirSync(newDir)) {
            const filePath = resolve(newDir, filename);
            if (!seenFiles.has(filePath)) {
              void processNewFile(agentId, filePath).catch((err) => {
                log?.warn?.(`tps-mail: processNewFile error: ${err?.message ?? err}`);
              });
            }
          }
        } catch { /* ignore */ }

        const unknownInbounds = reconcileTerminalCurStamps(account.mailDir, agentId, log);
        const curDir = resolve(account.mailDir, agentId, "cur");

        // cli#1006 r16: resolve each OPEN obligation's cur/ lookup BEFORE the
        // unacked-cur/ recovery is scheduled. An error REPORTED here keeps the
        // sweep off that inbound — otherwise the sweep would reconcile, ack,
        // arm or fail the very obligation the startup loop leaves untouched —
        // and the loop below reuses this result instead of scanning twice. The
        // scan is a snapshot: later filesystem changes are not covered.
        const lookupOpenObligationCur = (inboundId: string): { curPath: string | null; error: string | null } => {
          let lookupError: string | null = null;
          const curPath = findCurPath(
            account.mailDir,
            agentId,
            inboundId,
            (path, code) => {
              // Only the scan's clean signals — no matching entry, or the cur/
              // directory itself absent — are a miss; a dangling cur/ symlink or
              // a listed file that is gone is a read error.
              if (code === "ENOENT" && path === curDir) return;
              lookupError ??= code ?? "INVALID_JSON";
            },
            // cli#1006 r10: startup knows no cur/ path yet. Reading past the
            // limit can still prove the entry is THERE; a miss still reports
            // SCAN_LIMIT, because absence is not provable that way.
            { presenceBeyondLimit: true },
          );
          return { curPath, error: lookupError };
        };
        const startupCurLookups = new Map<string, { curPath: string | null; error: string | null }>();
        for (const rec of listObligations(account.mailDir, agentId)) {
          if (TERMINAL_STATES.has(rec.state) || unknownInbounds.has("*") || unknownInbounds.has(rec.inboundId)) continue;
          const lookup = lookupOpenObligationCur(rec.inboundId);
          if (lookup.error !== null) {
            unknownInbounds.add(rec.inboundId);
            // Reported here, before the recovery sweep is scheduled: the loop
            // below skips this inbound, so this is its one startup report.
            reportObligationCurLookupFailure(account.mailDir, agentId, rec.inboundId, rec.obligationId, lookup.error, log);
            // cli#1059 item E: the sweep's skip keeps this inbound out of the
            // recovery loop, so a failed lookup here would leave the live
            // obligation with no context and no timer until the next restart.
            // Give it the SAME bounded in-process retry the deadline path uses:
            // one retry entry, budget and cap per obligation.
            const retryCtx = makeYieldCtx(
              account.mailDir,
              agentId,
              rec.from,
              account.accountId,
              lookup.curPath ?? "",
              rec.inboundId,
              cfg,
              log,
              incarnation,
              rec.inboundEnvelopeId,
            );
            yieldContexts.set(rec.obligationId, retryCtx);
            retryObligationRead(retryCtx, rec.obligationId, `cur/ lookup failed (${lookup.error})`, rec.state);
          }
          startupCurLookups.set(rec.inboundId, lookup);
        }

        // Crash recovery (at-least-once): re-dispatch cur/ records that were
        // promoted but never acked/nacked. cur/ is a DESTINATION, so the record
        // must PROVE it came through promote() (envelopeId + stored signed
        // envelope) and re-verify before it may be presented — otherwise the
        // sweep would bypass the enforcement point simply by reading from the
        // other directory. recoverPromoted() enforces that and quarantines a
        // record that cannot prove provenance; a Flair outage defers to the next
        // start.
        try {
          const sweepRecoveries = startupCurRecoveries.get(account.accountId) ?? new Map<string, Promise<void>[]>();
          startupCurRecoveries.set(account.accountId, sweepRecoveries);
          if (existsSync(curDir)) {
            for (const filename of readdirSync(curDir)) {
              if (!filename.endsWith(".json")) continue;
              const curPath = resolve(curDir, filename);
              if (seenFiles.has(curPath)) continue;
              const record = readMailFile(curPath);
              if (!record || record.ackedAt || record.nackedAt || unknownInbounds.has("*") || unknownInbounds.has(record.id)) continue;
              const recovery = recoverUnackedCurRecord(agentId, curPath, record);
              const forInbound = sweepRecoveries.get(record.id);
              if (forInbound) forInbound.push(recovery);
              else sweepRecoveries.set(record.id, [recovery]);
              void recovery;
            }
          }
        } catch { /* ignore */ }

        // Reap stranded tmp/*.promote scratch from an interrupted promote (the
        // catch only runs on a thrown error, so a kill leaves orphans no other
        // sweep can see).
        try {
          await sweepStrandedPromoteScratch(resolve(account.mailDir, agentId));
          if (!isLive()) break;
        } catch { /* ignore */ }

        // UNSENT NACKS (cli#389 round 10, item 1): a TERMINAL failure whose nack
        // mail never went out — a crash between settling the failure and sending
        // its nack, or a send that could not be delivered — is retried here. The
        // RECORD decides (`nackPending` with no `nackSentAt`), never the cur/
        // stamp, so a stamp can no longer stand in for a mail the sender never
        // received. AT-LEAST-ONCE: a crash after the send but before
        // `nackSentAt` is written retries delivery, so the sender may see the
        // nack twice; the record keeps the debt until a hand-off is recorded.
        //
        // cli#389 round 12, item 1 (CodeRabbit, Major): the retries run in the
        // BACKGROUND, NOT awaited on the startup path. Awaited, one unreachable
        // branch (connect has no application-level timeout) stalled recovery for
        // this agent and every later one. Each retry bounds the connection; the
        // relay bounds the send above it and then waits the ACK window; the
        // backstop sits above that whole bound and logs BY NAME
        // (`nack-retry-timeout`).
        //
        // cli#389 round 12, item 1: the ordering dependency is GONE. The sweep
        // below HOLDS any record still owing its nack (obligations.ts) while it
        // is inside the bounded hold, so an owed mail survives whether the retry
        // or the sweep runs first.
        for (const rec of listObligations(account.mailDir, agentId)) {
          if (!isLive()) break;
          if (!nackOwed(rec)) continue;
          // cli#1006 r2: the missing-cur allowance is sound only while a CLEAN
          // lookup confirms cur/ is still absent. A lookup that errors, or one
          // that finds the file again, takes the normal gated path.
          let curStillAbsent = false;
          if (rec.missingCurReason === MISSING_CUR_REASON) {
            let retryLookupError: string | null = null;
            const found = findCurPath(account.mailDir, agentId, rec.inboundId, (path, code) => {
              if (code === "ENOENT" && path === curDir) return;
              retryLookupError ??= code ?? "INVALID_JSON";
            });
            curStillAbsent = found === null && retryLookupError === null;
          }
          retryOwedNackInBackground(
            account.mailDir,
            agentId,
            rec.from,
            rec.inboundId,
            rec.failure ?? "failed",
            account.accountId,
            cfg,
            log,
            incarnation,
            rec.inboundEnvelopeId,
            // cli#1006: the owed-nack retry for a record carrying
            // MISSING_CUR_REASON, after a clean lookup still finds cur/ absent,
            // keeps the settle-path allowance. Every other record keeps the gate.
            curStillAbsent,
          );
        }

        // OBLIGATION RETENTION (cli#401): delete ONLY terminal records (acked,
        // failed) whose LAST TRANSITION is older than the window; pending /
        // posted / yielded are never deletable (recovery reads them).
        // Best-effort — a failure never blocks startup. A replayed id whose
        // record was swept opens a FRESH obligation: accepted, since relay
        // retries arrive within minutes/hours, never the window later.
        try {
          const retentionDays = resolveObligationRetentionDays(pluginConfig, (cfg as any)?.channels?.[CHANNEL_ID]);
          if (!unknownInbounds.has("*")) sweepTerminalObligations(
            account.mailDir,
            agentId,
            retentionDays,
            log,
            Date.now(),
            resolveObligationNackHoldDays(retentionDays, pluginConfig, (cfg as any)?.channels?.[CHANNEL_ID], log),
            unknownInbounds,
          );
        } catch (err: any) {
          log?.warn?.(`tps-mail: obligation retention sweep failed (ignored): ${err?.message ?? String(err)}`);
        }

        // RESTART RECOVERY (S2): in-memory timers die with the process, so
        // reconcile every durable obligation record against the maildir/outbox
        // and RE-ARM the deadline where work is still outstanding.
        for (const rec of listObligations(account.mailDir, agentId)) {
          if (!isLive()) break;
          if (TERMINAL_STATES.has(rec.state) || unknownInbounds.has("*") || unknownInbounds.has(rec.inboundId)) continue;
          // cli#1006 r16: the lookup resolved before the startup sweep is reused
          // here; a record that appeared since (created by the sweep) gets its
          // own. A REPORTED lookup error is not a MISSING cur/: an unreadable or
          // malformed file, SCAN_LIMIT or AMBIGUOUS_ID leaves the obligation
          // untouched. Above the scan limit findCurPath does not report unrelated
          // read errors, so a single matching entry beyond the limit still proves
          // presence and startup proceeds (two matches report AMBIGUOUS_ID). An
          // absent lookup passes no path: a
          // record at the conventional name for another message id proves
          // nothing, so it must not suppress missing-entry recovery.
          const lookup = startupCurLookups.get(rec.inboundId) ?? lookupOpenObligationCur(rec.inboundId);
          if (lookup.error !== null) {
            reportObligationCurLookupFailure(
              account.mailDir,
              agentId,
              rec.inboundId,
              rec.obligationId,
              lookup.error,
              log,
            );
            continue;
          }
          const ctx = makeYieldCtx(
            account.mailDir,
            agentId,
            rec.from,
            account.accountId,
            lookup.curPath ?? "",
            rec.inboundId,
            cfg,
            log,
            incarnation,
            rec.inboundEnvelopeId,
          );
          yieldContexts.set(rec.obligationId, ctx);
          await reconcileObligation(ctx, rec);
        }
      } catch (err: any) {
        log?.warn?.(
          `tps-mail: failed to watch ${newDir}: ${err?.message ?? String(err)}`,
        );
      }
    }

    resolveSweepDone();
    await shutdown;
    ctx.abortSignal?.removeEventListener("abort", abort);
  },

  stopAccount: async (ctx: ChannelGatewayContext<TpsMailAccount>) => {
    const incarnation = gatewayIncarnations.get(ctx) ?? signalIncarnations.get(ctx.abortSignal);
    if (incarnation === undefined) {
      ctx.log?.warn?.(`tps-mail: stop-account-unverified: ${ctx.account.accountId}`);
      return;
    }
    endAccountLifetime(ctx.account.accountId, incarnation);
    ctx.log?.info?.("tps-mail: stopAccount called");
  },
};

const tpsMailChannel: ChannelPlugin<TpsMailAccount> = {
  id: CHANNEL_ID as any,
  meta: {
    id: CHANNEL_ID as any,
    label: "TPS Mail",
    selectionLabel: "TPS Mail",
    blurb: "Inter-agent messaging via the local TPS mail filesystem queue",
    docsPath: "/docs/channels/tps-mail",
    order: 200,
  } as any,
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reactions: false,
    reply: true,
    edit: false,
    unsend: false,
    threads: false,
    nativeCommands: false,
  },
  defaults: {
    queue: { debounceMs: 50 },
  },
  reload: {
    configPrefixes: [`channels.${CHANNEL_ID}`, "bindings"],
  },
  config,
  outbound,
  gateway,
};

// ─── Plugin registration ─────────────────────────────────────────────────────

export default {
  register(api: OpenClawPluginApi) {
    // Capture the PLUGIN-level config (openclaw.plugin.json configSchema), which
    // the account-level ctx does not carry — the obligation retention reads its
    // key from here (cli#401).
    pluginConfig = ((api as any).pluginConfig ?? {}) as Record<string, unknown>;

    // cli#402 runtime floor: WARN (never refuse) when the HOST OpenClaw is old
    // enough to REWRITE an exact NO_REPLY into a canned phrase the token guard
    // cannot tell from a real reply — unless the effective config disables the
    // rewrite for this surface. The version comes from the RUNNING gateway's own
    // install, never the plugin's dev dependency.
    try {
      const hostVersion = detectHostOpenClawVersion();
      const guard = evaluateHostSilentReplyGuard(hostVersion, (api as any).config);
      if (guard.warn && guard.message) api.logger.warn(guard.message);
    } catch (err: any) {
      api.logger.warn(
        `openclaw-tps-mail: could not check the host NO_REPLY-rewrite floor (${err?.message ?? err}); ` +
          `if this host is older than OpenClaw 2026.5.22, set surfaces["tps-mail"].silentReplyRewrite.direct = false.`,
      );
    }

    try {
      (api as any).registerChannel({ plugin: tpsMailChannel });
      api.logger.info(`openclaw-tps-mail: registered channel "${CHANNEL_ID}"`);
    } catch (err: any) {
      api.logger.error(
        `openclaw-tps-mail: failed to register channel: ${err?.message ?? err}`,
      );
      throw err;
    }

    // YIELD DETECTION: subscribe to the run lifecycle so a yielded run with no
    // posted final arms the obligation deadline instead of being acked. If the
    // subscription API is unavailable or throws, fall back to
    // settlement-inference (a settle with no posted final and no post failure is
    // treated as yielded).
    try {
      if (installYieldSubscription(api as any)) {
        yieldDetection = "subscription";
        api.logger.info(
          "openclaw-tps-mail: yield detection via registerAgentEventSubscription",
        );
      } else {
        yieldDetection = "settlement-inference";
        api.logger.info(
          "openclaw-tps-mail: registerAgentEventSubscription unavailable; yield detection via settlement-inference",
        );
      }
    } catch (err: any) {
      yieldDetection = "settlement-inference";
      api.logger.error(
        `openclaw-tps-mail: yield subscription failed (${err?.message ?? err}); yield detection via settlement-inference`,
      );
    }
  },
};
