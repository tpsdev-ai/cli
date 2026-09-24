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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { Envelope, ChainEntry } from "@tpsdev-ai/agent";
import { signEnvelope } from "@tpsdev-ai/agent";
import { readAgentPrivateKey } from "@tpsdev-ai/cli/utils/agent-keys";
import { promote, recoverPromoted, sweepStrandedPromoteScratch } from "@tpsdev-ai/cli/utils/mail";
import { resolveMailRoute, type MailRoute } from "@tpsdev-ai/cli/utils/mail-routing";
import { deliverToRemoteBranch, deliverToSandbox, resolveAgentMailRoot } from "@tpsdev-ai/cli/utils/relay";
import {
  TERMINAL_STATES,
  createObligation,
  listObligations,
  newestSessionTranscript,
  readObligation,
  scanForReceipt,
  sweepTerminalObligations,
  transitionObligation,
} from "./obligations.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { detectHostOpenClawVersion, evaluateHostSilentReplyGuard } from "./host-version.js";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type {
  ChannelGatewayContext,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "openclaw/plugin-sdk/channel-contract";

// The pinned openclaw (2026.5.22) exports no `plugin-sdk/channels` subpath, and
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
  replyToId?: string;
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

function readMailFile(filePath: string): TpsMailBody | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as TpsMailBody;
  } catch {
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
  // relay watches outbox/new and calls drainOutbox() on EVERY directory event,
  // including the create event that precedes the bytes — a record written
  // straight to its final name can be read mid-write, fail JSON.parse, and be
  // QUARANTINED to sent/.malformed-* with no retry, losing the reply forever.
  // drainOutbox filters dot-prefixed names by design, so a concurrent reader
  // never sees a half-written record, and rename(2) within one filesystem is
  // atomic. (This is replicated here rather than calling queueOutboxMessage
  // because @tpsdev-ai/cli/utils/outbox is not in the CLI package's exports map.)
  const tmp = resolve(outboxNew, `.${filename}.tmp`);
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, target);
  return target;
}

/**
 * cli#389 item 1: a wire delivery leaves no LOCAL file, so the obligation scan
 * (which only looks at the maildir/outbox) could never find its receipt and a
 * delivered remote reply was later marked failed and nacked. Persist a small
 * local receipt — under `~/.tps/receipts/`, 0600, named by the reply id —
 * carrying the reply's own marker/account/from (so `scanForReceipt` accepts it)
 * plus its `route` and `branchId`.
 */
function writeRemoteReceipt(reply: TpsMailBody, branchId: string): string {
  const dir = resolve(process.env.HOME ?? homedir(), ".tps", "receipts");
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${reply.id}.json`);
  const record = {
    id: reply.id,
    from: reply.from,
    to: reply.to,
    accountId: reply.accountId,
    body: reply.body,
    timestamp: reply.timestamp,
    replyToId: reply.replyToId,
    headers: reply.headers,
    route: "remote-branch",
    branchId,
  };
  // Atomic, 0600: a concurrent scan must never read a half-written receipt.
  const tmp = resolve(dir, `.${reply.id}.tmp`);
  writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, target);
  return target;
}

/** Deliver to a remote branch, then persist the local receipt item 1 requires. */
async function deliverRemote(reply: TpsMailBody, branchId: string): Promise<void> {
  // Preserve the outbound identity (id + timestamp) so the wire payload — and
  // the branch's ACK correlation — match the record this plugin reports as the
  // reply id, not a UUID the relay invents.
  await deliverToRemoteBranch(branchId, {
    id: reply.id,
    to: reply.to,
    from: reply.from,
    body: reply.body,
    timestamp: reply.timestamp,
  });
  writeRemoteReceipt(reply, branchId);
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
      return Promise.resolve({ path: writeOutboxFile(message), route: "outbox" });
    case "remote-branch":
      // The wire path, exactly as `tps mail send` sends it, PLUS the local
      // receipt item 1 requires so a later obligation scan can find it.
      return deliverRemote(message, route.branchId).then(() => ({
        path: `remote-branch:${route.branchId}`,
        route: "remote-branch" as const,
      }));
    case "bridge":
      // A local branch-office sandbox — the CLI's own bridge, imported.
      deliverToSandbox(route.branchId, { to: message.to, from: message.from, body: message.body });
      return Promise.resolve({ path: `bridge:${route.branchId}`, route: "bridge" });
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

/**
 * Sign a dispatcher reply as a v1 signed envelope, exactly like `tps mail
 * send` (packages/cli/src/commands/mail.ts `maybeSignEnvelopeBody`). Returns
 * the JSON-stringified signed envelope, or null when the agent has no
 * signing key (caller must warn and write nothing).
 */
function signReplyEnvelope(from: string, to: string, body: string): string | null {
  const privkey = readAgentPrivateKey(from);
  if (!privkey) return null;

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

  return JSON.stringify(signEnvelope(envelope, { [from]: privkey }));
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

/**
 * Patch a mail record in place. Used to ack/nack a message that the shared
 * promote() enforcement point has already moved new/ → cur/. The promotion
 * itself is atomic inside promote() (new/ → tmp/ → cur/); this only enriches
 * the cur/ record after dispatch, so a crash here cannot replay a message.
 */
function patchMailFile(path: string, patch: Partial<TpsMailBody>): void {
  try {
    const current = readMailFile(path);
    if (!current) return;
    writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
  } catch {
    // best effort — don't crash the watcher on state-transition errors
  }
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
  curPath: string;
  inboundId: string;
  cfg: any;
  log: any;
}

/** obligationId → the context needed to ack/nack it after the dispatch is gone. */
const yieldContexts = new Map<string, YieldContext>();
const armedDeadlines = new Map<string, ReturnType<typeof setTimeout>>();

let yieldDetection: "subscription" | "settlement-inference" = "settlement-inference";

function receiptDirs(ctx: YieldContext): string[] {
  // The receipt lives where the reply was WRITTEN, so use the same locality
  // decision (cli#389). A local route scans the recipient's maildir; a
  // remote-branch route scans the local receipt we persist on a successful wire
  // send (item 1); a bridge scans the branch sandbox `deliverToSandbox` wrote
  // to; every other relayed route scans the outbox the branch drains.
  const home = process.env.HOME ?? homedir();
  const route = routeFor(ctx.mailDir, ctx.cfg, ctx.accountId, ctx.sender);
  if (route.kind === "local") {
    return [resolve(ctx.mailDir, ctx.sender, "new"), resolve(ctx.mailDir, ctx.sender, "cur")];
  }
  if (route.kind === "remote-branch") {
    return [resolve(home, ".tps", "receipts")];
  }
  if (route.kind === "bridge") {
    const mailRoot = resolveAgentMailRoot(route.branchId);
    return [resolve(mailRoot, "new"), resolve(mailRoot, "cur")];
  }
  const outbox = resolve(home, ".tps", "outbox");
  // The branch drain moves the record new/ → sent/ keeping replyToId+headers,
  // so a REMOTE receipt is either file; .malformed-* in either is a FAILURE.
  return [resolve(outbox, "new"), resolve(outbox, "sent")];
}

function ackObligation(ctx: YieldContext, obligationId: string, why: string): void {
  // Only stamp the inbound when the ACK TRANSITION actually landed. A terminal
  // record (e.g. a deadline that already FAILED the obligation) refuses the
  // transition (obligations.ts: TERMINAL_STATES is final, never resurrected)
  // and must not get an ackedAt — otherwise a late final acks the inbound
  // while the obligation stays failed (cli#400).
  const updated = transitionObligation(ctx.mailDir, ctx.agent, ctx.inboundId, "acked", {}, ctx.log);
  if (!updated || updated.state !== "acked") {
    ctx.log?.warn?.(
      `tps-mail: refusing to ack ${ctx.inboundId} — obligation is ${updated?.state ?? "gone"}; the inbound keeps no ackedAt`,
    );
    return;
  }
  patchMailFile(ctx.curPath, { ackedAt: new Date().toISOString(), read: true });
  ctx.log?.info?.(`tps-mail: acked ${ctx.inboundId} — ${why}`);
}

function failObligation(ctx: YieldContext, reason: string): void {
  transitionObligation(ctx.mailDir, ctx.agent, ctx.inboundId, "failed", { failure: reason }, ctx.log);
  patchMailFile(ctx.curPath, { nackedAt: new Date().toISOString(), nackReason: reason });
  ctx.log?.warn?.(`tps-mail: obligation for ${ctx.inboundId} FAILED: ${reason} — nacked, never acked`);
}

/** Arm (or re-arm) the yield deadline from the record's deadlineAt. */
function armDeadline(ctx: YieldContext, obligationId: string, deadlineAt?: string | null): void {
  const rec = readObligation(ctx.mailDir, ctx.agent, ctx.inboundId);
  if (!rec || TERMINAL_STATES.has(rec.state)) return; // terminal or gone — nothing to arm
  const at = deadlineAt ?? rec.deadlineAt ?? new Date(Date.now() + obligationDeadlineMs()).toISOString();
  if (rec.state !== "yielded") {
    transitionObligation(ctx.mailDir, ctx.agent, ctx.inboundId, "yielded", { deadlineAt: at }, ctx.log);
  }
  const remaining = Math.max(0, Date.parse(at) - Date.now());
  const prev = armedDeadlines.get(obligationId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    armedDeadlines.delete(obligationId);
    onDeadline(ctx, obligationId);
  }, remaining);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  armedDeadlines.set(obligationId, timer);
}

function onDeadline(ctx: YieldContext, obligationId: string): void {
  const rec = readObligation(ctx.mailDir, ctx.agent, ctx.inboundId);
  if (!rec || TERMINAL_STATES.has(rec.state)) return; // late event after failed/acked: no-op
  const receipt = scanForReceipt(receiptDirs(ctx), obligationId, ctx.agent, ctx.accountId);
  if (receipt.status === "found") {
    ackObligation(ctx, obligationId, "receipt present at the deadline");
    return;
  }
  const reason = "yielded-without-resumption";
  failObligation(ctx, reason);
  void sendNackMail(ctx, reason);
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
): YieldContext {
  return { mailDir, agent, sender, accountId, curPath, inboundId, cfg, log };
}

/**
 * Derive an obligation's truth from the maildir/outbox: a nacked cur/ record is
 * a failure; a posted marker is an ack; otherwise the work is outstanding and
 * the deadline is (re-)armed. Used by restart recovery and by a re-dispatch of
 * an inbound that already has an obligation — neither may post a second final.
 */
function reconcileObligation(ctx: YieldContext, rec: { obligationId: string; deadlineAt: string | null; inboundId: string }): void {
  const curRec = ctx.curPath ? readMailFile(ctx.curPath) : null;
  if (curRec?.nackedAt) {
    transitionObligation(ctx.mailDir, ctx.agent, ctx.inboundId, "failed", {
      failure: curRec.nackReason ?? "nacked",
    }, ctx.log);
    return;
  }
  const receipt = scanForReceipt(receiptDirs(ctx), rec.obligationId, ctx.agent, ctx.accountId);
  if (receipt.status === "found") {
    ackObligation(ctx, rec.obligationId, "recovered: receipt already posted");
    return;
  }
  armDeadline(ctx, rec.obligationId, rec.deadlineAt);
}

async function sendNackMail(ctx: YieldContext, reason: string): Promise<void> {
  const transcript = newestSessionTranscript(process.env.HOME ?? homedir(), ctx.agent);
  const detail = transcript
    ? `${reason}; the newest session transcript is ${transcript.path} (mtime ${transcript.mtime})`
    : `${reason}; no session transcript was found under the agent's sessions dir`;
  const signedBody = signReplyEnvelope(ctx.agent, ctx.sender, detail);
  const message: TpsMailBody = {
    id: randomUUID(),
    from: ctx.agent,
    to: ctx.sender,
    body: signedBody ?? detail,
    timestamp: new Date().toISOString(),
    replyToId: ctx.inboundId,
    accountId: ctx.accountId,
    headers: {
      "X-TPS-Trust": "agent",
      "X-TPS-Surface": CHANNEL_ID,
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
      await deliverRemote(message, route.branchId);
    } else if (route.kind === "bridge") {
      deliverToSandbox(route.branchId, { to: ctx.sender, from: ctx.agent, body: message.body });
    } else {
      ctx.log?.warn?.(
        `tps-mail: no delivery route for the nack to ${ctx.sender} ` +
          `(${route.kind === "failed" ? route.reason : "no binding, no maildir, no remote branch, no bridge"}); the obligation record carries the failure`,
      );
      return;
    }
    ctx.log?.warn?.(`tps-mail: nack delivered to ${ctx.sender} for ${ctx.inboundId}`);
  } catch (err: any) {
    ctx.log?.warn?.(`tps-mail: could not deliver the nack for ${ctx.inboundId}: ${err?.message ?? err}`);
  }
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
      const rec = readObligation(ctx.mailDir, ctx.agent, ctx.inboundId);
      if (!rec || TERMINAL_STATES.has(rec.state)) return;
      armDeadline(ctx, rec.obligationId);
    },
  });
  return true;
}

/** The cur/ path for an inbound id (cur filenames are timestamp-id, not the id). */
function findCurPath(mailDir: string, agent: string, inboundId: string): string | null {
  const curDir = resolve(mailDir, agent, "cur");
  try {
    for (const name of readdirSync(curDir)) {
      if (!name.endsWith(".json")) continue;
      const p = resolve(curDir, name);
      const rec = readMailFile(p);
      if (rec?.id === inboundId) return p;
    }
  } catch {
    // no cur dir yet
  }
  return null;
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
    const message: TpsMailBody = {
      id: randomUUID(),
      from: sender,
      to: ctx.to,
      body: ctx.text,
      timestamp: now,
      replyToId: ctx.replyToId ?? undefined,
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

const gateway: ChannelGatewayAdapter<TpsMailAccount> = {
  startAccount: async (ctx: ChannelGatewayContext<TpsMailAccount>) => {
    const { account, cfg, log } = ctx;
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

    const watchers: FSWatcher[] = [];
    // seenFiles dedupes inotify events (fs.watch can fire multiple times per
    // write — see the debounce in the watcher callback). It is intentionally
    // NOT pre-populated from the existing new/ snapshot at startup: any file
    // already sitting in new/ when the gateway starts is mail that arrived
    // while the gateway was down (or that a previous turn never ack'd) and
    // MUST be processed on this startup, not silently swallowed.
    //
    // Replay safety comes from `moveToCur` after dispatch — successful turns
    // ack and move the file to cur/, failed dispatches nack and also move to
    // cur/, malformed files are moved to dlq/. None of these paths leave a
    // file in new/, so re-processing the same id twice is impossible across
    // restarts unless the gateway crashed mid-turn (acceptable: at-least-once
    // delivery is the contract).
    const seenFiles = new Set<string>();

    async function processNewFile(recipient: string, filePath: string): Promise<void> {
      if (seenFiles.has(filePath)) return;
      seenFiles.add(filePath);

      // ONE enforcement point, shared with the CLI: parse wrapper → envelope,
      // verify through an always-constructed Flair client, check recipient and
      // replay, and move new/ → cur/ (or dlq/ with a `.reason` sidecar). The
      // plugin carries no verification implementation of its own.
      const promoted = await promote(recipient, filePath);
      if (!promoted.ok) {
        log?.warn?.(
          `tps-mail: not promoted (${promoted.class}) for ${recipient}: ${promoted.reason}`,
        );
        return;
      }
      await deliverPromoted(recipient, promoted.message, promoted.path);
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
        const recovered = await recoverPromoted(recipient, curPath);
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
    async function deliverPromoted(recipient: string, msg: TpsMailBody, curPath: string): Promise<void> {
      if (seenFiles.has(curPath)) return;
      seenFiles.add(curPath);

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

      // ONE obligation-discharging post per inbound (cli#338 + S2). The
      // dispatcher's deliver callback receives blocks in order; we emit only
      // the FINAL message, once. There is deliberately NO suppression by "the
      // agent already sent something": the dispatcher's final is ALWAYS posted
      // and is the only obligation-discharging post.
      //
      // The obligation record is created HERE, keyed on the inbound id — a
      // replayed inbound finds its record and opens NO second obligation.
      const obligationId = randomUUID();
      const created = createObligation(
        account.mailDir,
        recipient,
        () => ({
          obligationId,
          inboundId: msg.id,
          inboundTimestamp: msg.timestamp,
          from: msg.from,
          to: recipient,
          accountId: account.accountId,
          state: "pending",
          deadlineAt: null,
          attempts: 1,
        }),
        log,
      );
      const obId = created.record.obligationId;
      const yieldCtx = makeYieldCtx(account.mailDir, recipient, msg.from, account.accountId, curPath, msg.id, cfg, log);
      yieldContexts.set(obId, yieldCtx);

      // A replayed inbound (or a re-dispatch) must NOT open a SECOND obligation
      // and must NOT post a SECOND final: reconcile the existing record instead
      // (receipt → ack; nacked → failed; otherwise re-arm the deadline).
      if (!created.created) {
        log?.info?.(`tps-mail: inbound ${msg.id} already has obligation ${obId}; reconciling, not re-dispatching`);
        reconcileObligation(yieldCtx, created.record);
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
              if (info?.kind !== "final") return;
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
              if (info?.kind === "final") sawSuppressedFinal = true;
            },
          },
        });

        // POST EXACTLY ONCE, after the dispatch has resolved.
        if (latestFinalText !== null) {
          const replyText = latestFinalText;
          // Requirement 4: sign the reply (Ed25519 + messageId).
          const signedBody = signReplyEnvelope(recipient, msg.from, replyText);
          if (!signedBody) {
            postFailure = postFailure ?? `missing-signing-key:${recipient}`;
            log?.warn?.(
              `tps-mail: no signing key for ${recipient}; cannot sign dispatcher reply to ${msg.from}`,
            );
          } else {
            const reply: TpsMailBody = {
              id: randomUUID(),
              from: recipient,
              to: msg.from,
              body: signedBody,
              timestamp: new Date().toISOString(),
              replyToId: msg.id,
              accountId: account.accountId,
              headers: {
                "X-TPS-Trust": "agent",
                "X-TPS-Surface": CHANNEL_ID,
                "X-TPS-InReplyTo": msg.id,
                // THE RECEIPT: the marker the ack scan keys on.
                "X-TPS-Obligation": obId,
              },
              deliveryAttempts: 0,
            };

            // (cli#389) Route the reply through the SAME locality decision as
            // `tps mail send` and the outbound adapter. `posted` is set ONLY
            // after the delivery returns; a throw, or an unknown recipient on
            // the office, is a NAMED failure.
            try {
              const route = routeFor(account.mailDir, cfg as any, ctx.accountId ?? "default", msg.from);
              if (route.kind === "local") {
                writeMailFile(account.mailDir, msg.from, reply);
                log?.info?.(
                  `tps-mail: reply ${reply.id} from ${recipient} to ${msg.from} (via dispatcher, route=local)`,
                );
                posted = true;
              } else if (route.kind === "outbox") {
                const path = writeOutboxFile(reply);
                log?.info?.(
                  `tps-mail: reply ${reply.id} from ${recipient} to ${msg.from} (via dispatcher, route=outbox: ${path})`,
                );
                posted = true;
              } else if (route.kind === "remote-branch") {
                await deliverRemote(reply, route.branchId);
                log?.info?.(
                  `tps-mail: reply ${reply.id} from ${recipient} to ${msg.from} (via dispatcher, route=remote-branch: ${route.branchId}; receipt persisted)`,
                );
                posted = true;
              } else if (route.kind === "bridge") {
                deliverToSandbox(route.branchId, { to: msg.from, from: recipient, body: reply.body });
                log?.info?.(
                  `tps-mail: reply ${reply.id} from ${recipient} to ${msg.from} (via dispatcher, route=bridge: ${route.branchId})`,
                );
                posted = true;
              } else {
                postFailure = postFailure ?? (route.kind === "failed" ? route.reason : `no-route:${msg.from}`);
                log?.warn?.(
                  route.kind === "failed"
                    ? `tps-mail: refusing the reply to ${msg.from}: ${route.reason} (the GAL names branch ${route.branchId} with no remote registration)`
                    : `tps-mail: no delivery route for reply recipient ${msg.from} ` +
                        `(not bound to this gateway, no local maildir, no registered remote branch); refusing to write where nothing reads it`,
                );
              }
              if (posted) transitionObligation(account.mailDir, recipient, msg.id, "posted", {}, log);
            } catch (err: any) {
              postFailure = postFailure ?? `write-failed:${err?.message ?? err}`;
            }
          }
        }

        // Read the runtime's failedCounts (diagnostic — a non-zero count with
        // no posted final is exactly the shape that used to ack silently).
        const failedCounts = dispatchResult?.failedCounts;
        if (failedCounts !== undefined) {
          log?.warn?.(`tps-mail: runtime failedCounts for ${msg.id}: ${JSON.stringify(failedCounts)}`);
        }

        // THE ACK IS GATED ON THE RECEIPT, never on the dispatch settling.
        const receipt = scanForReceipt(receiptDirs(yieldCtx), obId, recipient, account.accountId);
        if (receipt.status === "found") {
          ackObligation(yieldCtx, obId, "receipt found");
        } else if (receipt.status === "malformed" && posted) {
          // ONLY when THIS turn posted: a `.malformed-*` cannot be tied to this
          // obligation (its marker is unreadable) and quarantined records stay
          // in the dirs, so an unrelated one must not fail a later non-posting
          // turn (cli#398 T4). A posted reply the scan cannot find as a valid
          // receipt is the one case that is ours.
          failObligation(yieldCtx, "receipt-malformed");
        } else if (postFailure) {
          failObligation(yieldCtx, postFailure);
        } else if (sawSuppressedFinal && latestFinalText === null) {
          // The turn produced finals, but every one was empty or silent — a
          // NAMED failure with a nack, never a silent yield. `latestFinalText`
          // must be null: a turn that POSTED a real final whose receipt is
          // absent is the posted-without-receipt path below, not this one.
          failObligation(yieldCtx, "empty-final-text");
        } else {
          // No final posted and no post failure: the run yielded without
          // resumption (subscription event, or settlement-inference). Stay
          // UNACKED in cur/ and arm the deadline.
          armDeadline(yieldCtx, obId);
          log?.warn?.(
            `tps-mail: obligation for ${msg.id} is YIELDED (no final posted yet); deadline armed`,
          );
        }
      } catch (err: any) {
        log?.warn?.(
          `tps-mail: dispatch failed for ${msg.id}: ${err?.message ?? String(err)}`,
        );
        transitionObligation(account.mailDir, recipient, msg.id, "failed", {
          failure: `dispatch failed: ${err?.message ?? String(err)}`,
        }, log);
        patchMailFile(curPath, {
          nackedAt: new Date().toISOString(),
          nackReason: `dispatch failed: ${err?.message ?? String(err)}`,
        });
      }
    }

    // Launch a watcher per agent inbox.
    for (const agentId of boundAgents) {
      const newDir = resolve(account.mailDir, agentId, "new");
      if (!existsSync(newDir)) {
        mkdirSync(newDir, { recursive: true });
      }
      try {
        const watcher = fsWatch(newDir, { persistent: true }, (_event, filename) => {
          if (!filename) return;
          const filePath = resolve(newDir, String(filename));
          if (!existsSync(filePath)) return;
          // Debounce: fs.watch can fire multiple events per file write.
          setTimeout(() => {
            processNewFile(agentId, filePath).catch((err) => {
              log?.warn?.(`tps-mail: processNewFile error: ${err?.message ?? err}`);
            });
          }, 50);
        });
        watchers.push(watcher);

        // Process any files already present (but not in seenFiles) in case
        // the gateway starts up after mail was already written.
        try {
          for (const filename of readdirSync(newDir)) {
            const filePath = resolve(newDir, filename);
            if (!seenFiles.has(filePath)) {
              void processNewFile(agentId, filePath);
            }
          }
        } catch { /* ignore */ }

        // Crash recovery (at-least-once): re-dispatch cur/ records that were
        // promoted but never acked/nacked. cur/ is a DESTINATION, so the record
        // must PROVE it came through promote() (envelopeId + stored signed
        // envelope) and re-verify before it may be presented — otherwise the
        // sweep would bypass the enforcement point simply by reading from the
        // other directory. recoverPromoted() enforces that and quarantines a
        // record that cannot prove provenance; a Flair outage defers to the next
        // start.
        const curDir = resolve(account.mailDir, agentId, "cur");
        try {
          if (existsSync(curDir)) {
            for (const filename of readdirSync(curDir)) {
              if (!filename.endsWith(".json")) continue;
              const curPath = resolve(curDir, filename);
              if (seenFiles.has(curPath)) continue;
              const record = readMailFile(curPath);
              if (!record || record.ackedAt || record.nackedAt) continue;
              void recoverUnackedCurRecord(agentId, curPath, record);
            }
          }
        } catch { /* ignore */ }

        // Reap stranded tmp/*.promote scratch from an interrupted promote (the
        // catch only runs on a thrown error, so a kill leaves orphans no other
        // sweep can see).
        try {
          await sweepStrandedPromoteScratch(resolve(account.mailDir, agentId));
        } catch { /* ignore */ }

        // OBLIGATION RETENTION (cli#401): delete ONLY terminal records (acked,
        // failed) whose LAST TRANSITION is older than the window; pending /
        // posted / yielded are never deletable (recovery reads them).
        // Best-effort — a failure never blocks startup. A replayed id whose
        // record was swept opens a FRESH obligation: accepted, since relay
        // retries arrive within minutes/hours, never the window later.
        try {
          sweepTerminalObligations(
            account.mailDir,
            agentId,
            resolveObligationRetentionDays(pluginConfig, (cfg as any)?.channels?.[CHANNEL_ID]),
            log,
          );
        } catch (err: any) {
          log?.warn?.(`tps-mail: obligation retention sweep failed (ignored): ${err?.message ?? String(err)}`);
        }

        // RESTART RECOVERY (S2): in-memory timers die with the process, so
        // reconcile every durable obligation record against the maildir/outbox
        // and RE-ARM the deadline where work is still outstanding.
        for (const rec of listObligations(account.mailDir, agentId)) {
          if (TERMINAL_STATES.has(rec.state)) continue;
          const recCurPath = findCurPath(account.mailDir, agentId, rec.inboundId);
          const ctx = makeYieldCtx(
            account.mailDir,
            agentId,
            rec.from,
            account.accountId,
            recCurPath ?? resolve(account.mailDir, agentId, "cur", `${rec.inboundId}.json`),
            rec.inboundId,
            cfg,
            log,
          );
          yieldContexts.set(rec.obligationId, ctx);
          reconcileObligation(ctx, rec);
        }
      } catch (err: any) {
        log?.warn?.(
          `tps-mail: failed to watch ${newDir}: ${err?.message ?? String(err)}`,
        );
      }
    }

    // Keep the promise alive until the gateway signals shutdown. If we
    // return immediately after setting up watchers, the gateway interprets
    // it as "the account went down" and enters an auto-restart loop.
    //
    // We resolve the promise only when ctx.abortSignal fires. That's the
    // signal from the gateway that startAccount should terminate — at that
    // point we close watchers and return.
    await new Promise<void>((resolveShutdown) => {
      if (ctx.abortSignal?.aborted) {
        resolveShutdown();
        return;
      }
      ctx.abortSignal?.addEventListener(
        "abort",
        () => {
          for (const w of watchers) {
            try { w.close(); } catch { /* ignore */ }
          }
          log?.info?.("tps-mail: stopped all watchers");
          resolveShutdown();
        },
        { once: true },
      );
    });
  },

  stopAccount: async (ctx: ChannelGatewayContext<TpsMailAccount>) => {
    // Cleanup happens via abortSignal in startAccount. Nothing to do here.
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
