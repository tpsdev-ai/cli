/**
 * mail-watch — watch an agent's inbox and run exec hooks on new mail.
 *
 * OPS-121: fs.watch + debounce for low-latency delivery, backed by a
 * low-frequency poll fallback. fs.watch (FSEvents on macOS) goes deaf after
 * uptime, so it can't be the sole trigger — the poll keeps delivery going.
 * Near-zero idle CPU.
 *
 * Security mitigations (K&S):
 * - exec hooks use args[] array, no shell interpolation
 * - agent IDs validated: ^[a-zA-Z0-9._-]+$
 * - max 3 concurrent handlers
 *
 * NON-CONSUMING (cli#375): the watcher verifies each record in `new/` IN PLACE
 * with the same verification `promote()` applies, and presents ONLY records
 * that verify. It calls no consumer path — no promote, no lease, no ack, no
 * `checkMessages` — and never moves a record out of `new/`. A record that does
 * not verify is skipped and logged; it is never presented.
 *
 * Hook contract:
 * - the VERIFIED body arrives on the hook's stdin (the signed plaintext,
 *   written to the hook as UTF-8);
 * - the four mail variables the watcher sets come from VERIFIED fields:
 *   TPS_MAIL_ID (the verified envelope id), TPS_MAIL_FROM, TPS_MAIL_TO (the
 *   watched agent) and TPS_MAIL_TIMESTAMP. The hook process also inherits the
 *   watcher's environment (plus any `env` on the hook), so those four are the
 *   only mail variables this module vouches for.
 */

import { isMailboxMessageFile } from "@tpsdev-ai/agent";
import { execSync, spawn } from "node:child_process";
import { existsSync, watch as fsWatch, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MailMessage } from "../utils/mail.js";
import { mailRootForRecordPath, getInbox, isConsumedForMailbox, type VerifyRecordResult, verifyRecordForMailbox } from "../utils/mail.js";
import { externalDispatchRefusal } from "../utils/mail-tier.js";
import { SANDBOX_REQUIRED_FLAG } from "../utils/nono.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchExecHook {
  /** Command + args — no shell interpolation. */
  args: string[];
  /** Environment variables to set for the hook process. */
  env?: Record<string, string>;
}

export interface MailWatchOptions {
  /** Agent ID to watch. Must match ^[a-zA-Z0-9._-]+$ */
  agent: string;
  /** Debounce window in ms — coalesces rapid fs events (default: 50) */
  debounceMs?: number;
  /** Exec hook to run on each new message. */
  hook?: WatchExecHook;
  /** Called for each new message. */
  onMessage?: (msg: MailMessage) => void | Promise<void>;
  /** Max concurrent handlers (default: 3) */
  maxConcurrent?: number;
  /** Polling-fallback interval in ms — guards against fs.watch going deaf (default: 15000) */
  pollMs?: number;
  /**
   * Liveness heartbeat fired once per poll cycle (ops-i3vw — Flair Presence dogfood).
   * Binding the heartbeat to the SAME poll loop that delivers mail means a stalled
   * or dead watcher stops beating — so its Presence record goes stale and the
   * staleness monitor flags it. This directly catches the 2026-06-25 failure
   * (a watcher stalled 13h with nothing recording its liveness). Errors are
   * swallowed: a heartbeat failure must never crash the mail loop.
   */
  onPoll?: () => void | Promise<void>;
  /**
   * Test seam: awaited before each record's `verifyRecordForMailbox` call. It can
   * delay that call but not replace it: its return value is ignored, and a throw
   * withholds the record as a verification error does.
   */
  beforeVerify?: () => Promise<void>;
  /**
   * Test seam: the fs.watch implementation. Defaults to node's `fs.watch`. A
   * test that must prove the POLL path alone passes a no-op here, so no fs
   * event can deliver the mail it writes.
   */
  watchImpl?: (dir: string, listener: () => void) => { close(): void };
  /**
   * Readiness seam: called ONCE, on the event-loop turn after the watcher's
   * FIRST scan attempt of `new/` completes, whether or not that listing
   * succeeded (a failed listing is logged and still counts). By then fs.watch
   * has been called and the startup scan is over, so a record written afterwards
   * is picked up by an fs event or a poll tick, never by the startup scan.
   * It does NOT guarantee that fs.watch reports a write made immediately
   * afterwards in good time: on macOS, FSEvents can report such a write seconds
   * late. Tests that exercise the fs-event path therefore pass a `watchImpl`
   * that captures the listener, and fire it themselves after the write.
   * Default: no-op. It is informational only: errors thrown by the callback are
   * swallowed, and it does not affect delivery.
   */
  onReady?: () => void;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const AGENT_ID_RE = /^[a-zA-Z0-9._-]+$/;

export function validateAgentId(agentId: string): void {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(
      `Invalid agent ID: ${JSON.stringify(agentId)}. Must match ^[a-zA-Z0-9._-]+$`
    );
  }
}

// ---------------------------------------------------------------------------
// Reading `new/` for verification (cli#375)
// ---------------------------------------------------------------------------
//
// `new/` is listed and each record is verified IN PLACE through
// `verifyRecordForMailbox` — the same policy `promote()` applies — so an
// unverified record is never handed on.

type NewFile = { file: string; identity: string; fileKey: string };

function fileIdentity(path: string, file: string): string {
  const stat = statSync(path);
  return `${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

/**
 * File identities (`*.json`) directly under `dir`; `[]` when `dir` is absent, and
 * `null` when the LISTING FAILS (a read error). The two are distinct: an absent
 * or empty `new/` means no files, but a failed listing must not be read as
 * "every file left" (see processNew).
 */
type NewListing = NewFile[] & { unstatable: Map<string, string> };

function listNewFiles(dir: string): NewListing | null {
  try {
    const files = [] as unknown as NewListing;
    // A per-entry stat failure other than ENOENT (a symlink loop, a symlink
    // through a regular file) is that ENTRY's problem, not the listing's: skip
    // it and keep its dedup state (processNew treats its name as present). An
    // entry that vanished (ENOENT) keeps today's behaviour and is dropped
    // silently.
    files.unstatable = new Map();
    for (const file of readdirSync(dir).filter(isMailboxMessageFile)) {
      try {
        const identity = fileIdentity(join(dir, file), file);
        files.push({ file, identity, fileKey: identity.split(":").slice(0, -2).join(":") });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") files.unstatable.set(file, code ?? String(err));
      }
    }
    return files;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    const empty = [] as unknown as NewListing;
    empty.unstatable = new Map();
    return empty;
  }
}

/** The file name an identity (`file:dev:ino:size:mtime`) or a fileKey (`file:dev:ino`) belongs to. */
function fileOfIdentity(identity: string): string {
  return identity.split(":").slice(0, -4).join(":");
}
function fileOfKey(fileKey: string): string {
  return fileKey.split(":").slice(0, -2).join(":");
}

/**
 * Read one `new/` record. `gone` when the file no longer exists (ENOENT after
 * the listing), `read-error` for any other failure to read it, and `corrupt`
 * when its contents are not a JSON object.
 */
type NewRecordRead =
  | { kind: "record"; record: MailMessage }
  | { kind: "gone" }
  | { kind: "read-error"; detail: string }
  | { kind: "corrupt" };

function readNewRecord(filePath: string): NewRecordRead {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "gone" };
    return { kind: "read-error", detail: code ?? (err instanceof Error ? err.message : String(err)) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "corrupt" };
  return { kind: "record", record: parsed as MailMessage };
}

/**
 * Project a VERIFIED message to the fields a hook/onMessage may see: the
 * verified envelope fields, plus the local `read` flag (always false here). `id`
 * is the VERIFIED envelope id (never the unsigned wrapper id), and the unsigned
 * wrapper fields the source file carried — `headers` above all — are dropped.
 */
function projectVerified(m: MailMessage): MailMessage {
  const out: MailMessage = {
    id: m.envelopeId as string,
    from: m.from,
    to: m.to,
    body: m.body,
    timestamp: m.timestamp,
    read: false,
  };
  if (m.envelopeId !== undefined) out.envelopeId = m.envelopeId;
  if (m.replyToId !== undefined) out.replyToId = m.replyToId;
  return out;
}

// ---------------------------------------------------------------------------
// Exec hook runner
// ---------------------------------------------------------------------------

/**
 * Run a hook for a single VERIFIED message.
 * Writes the verified body to stdin and sets the four TPS_MAIL_* variables from
 * verified fields (the rest of the environment is inherited).
 * No shell interpolation — args passed directly to spawn().
 */
function runHook(hook: WatchExecHook, msg: MailMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!hook.args.length) { resolve(); return; }

    const child = spawn(hook.args[0]!, hook.args.slice(1), {
      env: {
        ...process.env,
        ...(hook.env ?? {}),
        TPS_MAIL_ID: msg.id,
        TPS_MAIL_FROM: msg.from,
        TPS_MAIL_TO: msg.to,
        TPS_MAIL_TIMESTAMP: msg.timestamp,
      },
      stdio: ["pipe", "inherit", "inherit"],
    });

    child.stdin.write(msg.body, "utf-8");
    child.stdin.end();

    child.on("exit", () => resolve());
    child.on("error", () => resolve()); // hook errors don't crash the watcher
  });
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export interface MailWatcher {
  stop(): void;
}

/**
 * Watch an agent's inbox for new messages using fs.watch + debounce.
 * Zero CPU overhead when idle. Returns a handle with stop() to cancel.
 */
export function watchMail(opts: MailWatchOptions): MailWatcher {
  validateAgentId(opts.agent);

  const debounceMs = opts.debounceMs ?? 50;
  const maxConcurrent = opts.maxConcurrent ?? 3;
  let stopped = false;
  let activeHandlers = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const inbox = getInbox(opts.agent);

  /** Consecutive failed per-file read, verification or consumed-history attempts before classification. */
  const MAX_UNRESOLVED_ATTEMPTS = 10;

  // File associations survive read and verifier errors; pending gates keep empty sets.
  // Register associations after the gates; keep history errors pending.
  // Pending replacements release their hold on refusal or a verified different id.
  const presented = new Map<string, Set<string>>();
  const pendingEnvelopeIds = new Map<string, string>();
  // Attempts belong to the observed identity; replacements retry when it changes.
  const unresolvedAttempts = new Map<string, number>();
  // A resident identity's verdict prevents repeated verification and logging.
  // Clear absent identities before verification yields.
  const classified = new Map<string, string>();
  // new/ entries already reported as unstat-able. The warning is logged once
  // per continuous failure: it is logged again if the failure stops and recurs.
  const warnedUnstatable = new Set<string>();

  // Name each entry a listing could not stat and keep one warning per
  // continuous failure; a file this listing stats again leaves the set. Every
  // successful listing of new/ (the scan and the trim) reports through it, so a
  // failure that persists into the next scan is not named twice.
  const reportUnstatable = (entries: Map<string, string>) => {
    for (const [file, code] of entries) {
      if (warnedUnstatable.has(file)) continue;
      warnedUnstatable.add(file);
      console.error(`[mail-watch] ${opts.agent}: skipping ${file} — cannot stat ${join(inbox.fresh, file)} (${code})`);
    }
    for (const file of warnedUnstatable) if (!entries.has(file)) warnedUnstatable.delete(file);
  };

  // Verified records waiting for a free slot. The concurrency cap must hold
  // WITHOUT dropping the rest, so over-cap records wait here and are delivered
  // as slots free.
  const pending: MailMessage[] = [];
  let checking = false;
  // A processNew call while a scan is active sets ONE pending rescan (a flag,
  // not a queue), run when that scan finishes.
  let rescan = false;

  // Fire the readiness seam once, when the FIRST scan attempt has finished,
  // whether or not its listing succeeded. fs.watch was called before the
  // startup processNew(), but that does not mean the OS is already reporting
  // events for new/ (see MailWatchOptions.onReady).
  let readyFired = false;
  const fireReady = () => {
    if (readyFired) return;
    readyFired = true;
    // On the next turn of the event loop, after the startup scan has finished.
    setImmediate(() => {
      try { opts.onReady?.(); } catch { /* a readiness callback must not crash the watcher */ }
    });
  };

  const drain = () => {
    while (!stopped && pending.length > 0 && activeHandlers < maxConcurrent) {
      const msg = pending.shift();
      if (msg === undefined) break;
      // The callback and the hook each get their own copy, so the callback
      // cannot change what the hook receives.
      const forCallback = structuredClone(msg);
      const forHook = structuredClone(msg);
      activeHandlers++;
      (async () => {
        try {
          if (opts.onMessage) await opts.onMessage(forCallback);
        } catch { /* callback errors don't crash the watcher */ }
        try {
          if (opts.hook) await runHook(opts.hook, forHook);
        } catch { /* hook errors don't crash the watcher */ }
      })().finally(() => {
        activeHandlers--;
        if (!stopped) drain();
      });
    }
  };

  // Verify each record in `new/` IN PLACE and queue ONLY the records that
  // verify. Nothing is moved, leased or acked. A record that does not verify is
  // logged and skipped, never presented.
  const processNew = async () => {
    if (stopped) return;
    if (checking) { rescan = true; return; }
    checking = true;
    try {
      const files = listNewFiles(inbox.fresh);
      if (files === null) {
        // The listing FAILED. A failed read is not "every file left": keep the
        // dedup state so a still-present file is not presented twice when the
        // listing recovers.
        console.error("[mail-watch] cannot list new/; keeping the current dedup state");
        return;
      }
      const present = new Set(files.map(({ identity }) => identity));
      const paths = new Set(files.map(({ file }) => file));
      const fileKeys = new Set(files.map(({ fileKey }) => fileKey));
      const kept = files.unstatable;
      reportUnstatable(kept);
      for (const file of pendingEnvelopeIds.keys()) if (!paths.has(file) && !kept.has(file)) pendingEnvelopeIds.delete(file);
      for (const file of classified.keys()) if (!present.has(file) && !kept.has(fileOfIdentity(file))) classified.delete(file);
      for (const file of unresolvedAttempts.keys()) if (!present.has(file) && !kept.has(fileOfIdentity(file))) unresolvedAttempts.delete(file);
      for (const [envId, filesWithId] of presented) {
        for (const fileKey of filesWithId) {
          if (fileKeys.has(fileKey) || kept.has(fileOfKey(fileKey))) continue;
          const file = fileKey.split(":").slice(0, -2).join(":");
          if (paths.has(file) && !pendingEnvelopeIds.has(file)) {
            pendingEnvelopeIds.set(file, envId);
          }
          filesWithId.delete(fileKey);
        }
      }

      const noteUnresolved = (file: string, identity: string) => {
        const attempts = (unresolvedAttempts.get(identity) ?? 0) + 1;
        unresolvedAttempts.set(identity, attempts);
        if (attempts < MAX_UNRESOLVED_ATTEMPTS) {
          return true;
        }
        classified.set(identity, "unresolved");
        console.error(
          `[mail-watch] ${file}: not presented (${attempts} consecutive failed per-file attempts; classified); ` +
            "file left in new/; restart mail-watch to retry it.",
        );
        return false;
      };

      for (const { file, identity, fileKey } of files) {
        if (classified.has(identity)) continue;
        const path = join(inbox.fresh, file);
        const read = readNewRecord(path);
        try {
          if (fileIdentity(path, file) !== identity) {
            present.delete(identity);
            rescan = true;
            continue;
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") continue;
        }
        // Removed after the listing: nothing to present, and not classified.
        if (read.kind === "gone") {
          pendingEnvelopeIds.delete(file);
          unresolvedAttempts.delete(identity);
          present.delete(identity);
          continue;
        }
        if (read.kind === "read-error") {
          // A read error is not a verdict: withhold it for retry before classification.
          if (!noteUnresolved(file, identity)) continue;
          console.error(
            `[mail-watch] ${opts.agent}: ${file} not presented — cannot read ${path} (${read.detail}); ` +
              "the file is left untouched and is retried on the next scan if it remains in new/. " +
              "Remedy: make that path readable by this user.",
          );
          continue;
        }
        if (read.kind === "corrupt") {
          pendingEnvelopeIds.delete(file);
          unresolvedAttempts.delete(identity);
          classified.set(identity, "corrupt");
          console.error(`[mail-watch] ${file}: not presented (corrupt record)`);
          continue;
        }
        const record = read.record;
        let result: VerifyRecordResult;
        try {
          if (opts.beforeVerify) await opts.beforeVerify();
          result = await verifyRecordForMailbox(opts.agent, record, mailRootForRecordPath(path));
        } catch (err) {
          // Verifier exceptions retry before classification; malformed structure is a terminal invalid result.
          if (noteUnresolved(file, identity)) {
            console.error(
              `[mail-watch] ${record.id}: verification error (${err instanceof Error ? err.message : String(err)})`,
            );
          }
          continue;
        }
        if (!result.ok) {
          pendingEnvelopeIds.delete(file);
          unresolvedAttempts.delete(identity);
          classified.set(identity, `refused:${result.class}`);
          console.error(`[mail-watch] ${record.id}: not presented (${result.class}: ${result.reason})`);
          continue;
        }
        const envId = result.message.envelopeId;
        if (envId === undefined) {
          pendingEnvelopeIds.delete(file);
          unresolvedAttempts.delete(identity);
          classified.set(identity, "refused:no-envelope-id");
          continue;
        }
        if (pendingEnvelopeIds.get(file) !== envId) pendingEnvelopeIds.delete(file);
        for (const [previousId, filesWithId] of presented) {
          if (previousId !== envId) filesWithId.delete(fileKey);
        }
        // cli#433 (slice B2-1): honour the SIGNED tier. An arbitrary hook command
        // has no external capability set, so external-tier mail is not presented
        // (the hook does not run), with a named reason.
        const refusal = externalDispatchRefusal(result.message.envelope, result.message.from, result.message.trustTier);
        if (refusal) {
          pendingEnvelopeIds.delete(file);
          unresolvedAttempts.delete(identity);
          classified.set(identity, "refused:external-tier");
          console.error(`[mail-watch] ${envId}: not presented (${refusal})`);
          continue;
        }
        // Skip a verified record whose id the consumed history holds. When that
        // history cannot be read, withhold it for retry before classification.
        let consumed: boolean;
        try {
          consumed = isConsumedForMailbox(opts.agent, envId);
        } catch (err) {
          pendingEnvelopeIds.set(file, envId);
          if (!noteUnresolved(file, identity)) continue;
          console.error(
            `[mail-watch] ${opts.agent}: ${file}: ${envId} not presented — ${err instanceof Error ? err.message : String(err)}; ` +
              "the file is left untouched and is retried on the next scan if it remains in new/. " +
              "Remedy: make that path readable by this user.",
          );
          continue;
        }
        if (consumed) {
          pendingEnvelopeIds.delete(file);
          unresolvedAttempts.delete(identity);
          classified.set(identity, "already-consumed");
          console.error(`[mail-watch] ${envId}: not presented (already consumed)`);
          continue;
        }
        pendingEnvelopeIds.delete(file);
        classified.set(identity, "presented");
        unresolvedAttempts.delete(identity);
        // Add tracked, eligible verified files before trimming so replacements
        // preserve the presented id.
        let filesWithId = presented.get(envId);
        const alreadyPresented = presented.has(envId);
        if (filesWithId === undefined) {
          filesWithId = new Set<string>();
          presented.set(envId, filesWithId);
        }
        filesWithId.add(fileKey);
        if (alreadyPresented) continue;
        pending.push(projectVerified(result.message));
      }
      // Trim after tracking eligible verified replacements to preserve their id.
      // Recheck identities after awaited verification before releasing ids.
      const atTrim = listNewFiles(inbox.fresh);
      if (atTrim === null) {
        console.error("[mail-watch] cannot list new/; keeping the current dedup state");
        return;
      }
      // Report and clear before the rescan decision: this listing succeeded, so
      // its names must be warned (and a recovered name cleared) even when a new
      // identity sends us into the rescan.
      reportUnstatable(atTrim.unstatable);
      if (atTrim.some(({ identity }) => !present.has(identity))) {
        rescan = true;
        return;
      }
      const trimPresent = new Set(atTrim.map(({ identity }) => identity));
      const trimPaths = new Set(atTrim.map(({ file }) => file));
      const trimKept = new Set([...kept.keys(), ...atTrim.unstatable.keys()]);
      for (const file of pendingEnvelopeIds.keys()) if (!trimPaths.has(file) && !trimKept.has(file)) pendingEnvelopeIds.delete(file);
      for (const identity of classified.keys()) if (!trimPresent.has(identity) && !trimKept.has(fileOfIdentity(identity))) classified.delete(identity);
      for (const identity of unresolvedAttempts.keys()) if (!trimPresent.has(identity) && !trimKept.has(fileOfIdentity(identity))) unresolvedAttempts.delete(identity);
      const held = new Set(pendingEnvelopeIds.values());
      const trimFileKeys = new Set(atTrim.map(({ fileKey }) => fileKey));
      for (const [envId, filesWithId] of presented) {
        for (const fileKey of filesWithId) if (!trimFileKeys.has(fileKey) && !trimKept.has(fileOfKey(fileKey))) filesWithId.delete(fileKey);
        if (filesWithId.size === 0 && !held.has(envId)) presented.delete(envId);
      }
    } finally {
      checking = false;
      fireReady();
      drain();
      // Yield between rescans so a synchronous read failure cannot recurse.
      if (rescan && !stopped) { rescan = false; setImmediate(() => { void processNew(); }); }
    }
  };

  const onFsEvent = () => {
    if (stopped) return;
    // Debounce: coalesce rapid rename/create events
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void processNew(); }, debounceMs);
  };

  // fs.watch on new/ fires on file create/rename — low-latency, but fs.watch
  // (FSEvents on macOS) silently stops emitting after uptime. So treat fs.watch
  // as a latency optimization, NOT the source of truth: the low-frequency poll
  // keeps delivery going even if the watcher goes deaf.
  const watchImpl = opts.watchImpl ?? ((dir: string, listener: () => void) => fsWatch(dir, listener));
  const watcher = watchImpl(inbox.fresh, onFsEvent);
  const pollMs = opts.pollMs ?? 15_000;

  // Liveness heartbeat — fire once per GUARANTEED poll cycle (not the fs-event
  // path, which can go deaf). A heartbeat error never propagates: it must not
  // crash the mail loop. If the watcher stalls/dies, the heartbeat stops with
  // it → Presence goes stale → the staleness monitor flags it. (ops-i3vw)
  const beat = () => {
    if (stopped || !opts.onPoll) return;
    Promise.resolve()
      .then(() => opts.onPoll!())
      .catch(() => { /* heartbeat failure must not crash the watcher */ });
  };

  const pollTimer = setInterval(() => { void processNew(); beat(); }, pollMs);

  // Deliver anything already waiting in new/ at (re)start, immediately — so a
  // kickstart RECOVERS stuck mail instead of waiting for the first event/poll.
  void processNew();
  // Beat once at startup so a fresh (re)start registers liveness immediately.
  beat();

  return {
    stop() {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(pollTimer);
      try { watcher.close(); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// Daemon (launchd on macOS, nohup on Linux)
// ---------------------------------------------------------------------------

const PLIST_LABEL_PREFIX = "ai.tpsdev.mail-watch";

function plistLabel(agent: string): string {
  return `${PLIST_LABEL_PREFIX}.${agent}`;
}

function plistPath(agent: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${plistLabel(agent)}.plist`);
}

function logDir(): string {
  const dir = join(homedir(), ".tps", "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Escape a string for safe embedding inside a plist XML <string> element. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the launchd plist for an agent's mail-watch daemon.
 * Exported for unit testing (asserts ProcessType=Background + valid XML).
 */
export function buildPlist(agent: string, tpsBin: string, extraHookArgs: string[]): string {
  const label = plistLabel(agent);
  const stdout = join(logDir(), `mail-watch-${agent}.log`);
  const stderr = join(logDir(), `mail-watch-${agent}.error.log`);

  // XML-escape all args before embedding in plist
  const hookArgs = extraHookArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");

  // Build ProgramArguments array — escape paths too (handles spaces, &, etc.)
  // `${SANDBOX_REQUIRED_FLAG}` is asserted here (cli#341 S1a): this unit launches
  // an agent in a non-interactive context, so the launcher must be told — and a
  // hand-edited plist that drops it is refused by the launcher instead of
  // silently running the agent unsandboxed.
  const progArgs = [
    `    <string>${xmlEscape(process.execPath)}</string>`,
    `    <string>${xmlEscape(tpsBin)}</string>`,
    `    <string>mail</string>`,
    `    <string>watch</string>`,
    `    <string>${xmlEscape(agent)}</string>`,
    `    <string>${SANDBOX_REQUIRED_FLAG}</string>`,
    ...(extraHookArgs.length ? [`    <string>--exec</string>`, hookArgs] : []),
  ].join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>

  <key>ProgramArguments</key>
  <array>
${progArgs}
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <!--
    KEEPALIVE COUPLING (cli#341 S1a) — {SuccessfulExit:false} is load-bearing and
    is ONLY correct together with "the launcher logs the refusal and exits 0":
      * {Crashed:true} restarts only on *signal* death (a refusal's exit 78
        gives ONE launch — measured).
      * {SuccessfulExit:false} + exit 78 gives 13 relaunches in 12 s.
    So the launcher exits 0 on a refusal (TPS_SUPERVISED=1 in EnvironmentVariables
    below) → a refused unit goes quiet, while a genuine crash (non-zero/signal)
    still relaunches. Do not change this key without changing that path.
  -->

  <!--
    ProcessType=Background tells launchd this is a long-lived background daemon.
    Without it, the watcher's idle poll timer (waking every ~15s) gets the job
    power-classified as "inefficient" and macOS reaps it with a clean exit 0 —
    which KeepAlive(SuccessfulExit:false) does NOT restart (exit 0 is "successful"),
    so the agent goes silently deaf. Background processing type opts the job out of
    that idle-reap. (ops-bayh)
  -->
  <key>ProcessType</key>
  <string>Background</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${xmlEscape(stdout)}</string>

  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderr)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(homedir())}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <!-- TPS_SUPERVISED=1 → a refusal logs and exits 0 (see KEEPALIVE COUPLING). -->
    <key>TPS_SUPERVISED</key>
    <string>1</string>
  </dict>
</dict>
</plist>
`;
}

export function installDaemon(agent: string, hookArgs: string[] = []): void {
  validateAgentId(agent); // validate before platform check
  if (platform() !== "darwin") {
    throw new Error("--daemon install is only supported on macOS (launchd). On Linux, use a supervisor or nohup manually.");
  }

  const tpsBin = resolve(fileURLToPath(import.meta.url), "../../bin/tps.js");
  const plist = buildPlist(agent, tpsBin, hookArgs);
  const path = plistPath(agent);
  const label = plistLabel(agent);

  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(path, plist, "utf-8");

  // Unload if already loaded, then load fresh
  try { execSync(`launchctl unload "${path}" 2>/dev/null`, { stdio: "ignore" }); } catch {}
  execSync(`launchctl load "${path}"`, { stdio: "inherit" });

  console.log(`✅ mail-watch daemon installed and started (${label})`);
  console.log(`   Log: ${join(logDir(), `mail-watch-${agent}.log`)}`);
  console.log(`   Plist: ${path}`);
}

export function uninstallDaemon(agent: string): void {
  validateAgentId(agent); // validate before platform check
  if (platform() !== "darwin") {
    throw new Error("--daemon uninstall is only supported on macOS (launchd).");
  }

  const path = plistPath(agent);
  if (!existsSync(path)) {
    console.log(`No daemon installed for agent: ${agent}`);
    return;
  }

  try { execSync(`launchctl unload "${path}"`, { stdio: "ignore" }); } catch {}
  unlinkSync(path);
  console.log(`✅ mail-watch daemon uninstalled (${plistLabel(agent)})`);
}

export function daemonStatus(agent: string): void {
  validateAgentId(agent);
  const path = plistPath(agent);
  const label = plistLabel(agent);

  if (!existsSync(path)) {
    console.log(`mail-watch daemon: NOT INSTALLED (${label})`);
    return;
  }

  try {
    const out = execSync(`launchctl list | grep "${label}" 2>/dev/null`, { encoding: "utf-8" });
    if (out.trim()) {
      const parts = out.trim().split(/\s+/);
      const pid = parts[0] !== "-" ? `PID ${parts[0]}` : "not running";
      console.log(`mail-watch daemon: ✅ LOADED (${pid})`);
    } else {
      console.log(`mail-watch daemon: INSTALLED but NOT LOADED`);
    }
  } catch {
    console.log(`mail-watch daemon: INSTALLED but NOT LOADED`);
  }
  console.log(`   Plist: ${path}`);
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

export interface MailWatchArgs {
  agent: string;
  hook?: string[];       // exec hook args from CLI
  debounce?: number;     // debounce window in ms
  json?: boolean;        // output messages as JSON
  interval?: number;     // kept for back-compat, unused (was polling interval)
  daemon?: string;       // "install" | "uninstall" | "status"
}

export async function runMailWatch(args: MailWatchArgs): Promise<void> {
  // Handle daemon subcommands
  if (args.daemon) {
    validateAgentId(args.agent);
    switch (args.daemon) {
      case "install":
        installDaemon(args.agent, args.hook ?? []);
        return;
      case "uninstall":
        uninstallDaemon(args.agent);
        return;
      case "status":
        daemonStatus(args.agent);
        return;
      default:
        console.error(`Unknown daemon action: ${args.daemon}. Use: install | uninstall | status`);
        process.exit(1);
    }
  }

  validateAgentId(args.agent);

  const hook: WatchExecHook | undefined = args.hook?.length
    ? { args: args.hook }
    : undefined;

  // Flair Presence heartbeat (ops-i3vw) — DEFAULT-OFF, byte-identical when off.
  // Enable per-agent by setting TPS_PRESENCE_BEAT_CMD to an executable that
  // emits the agent's Presence (it reads TPS_AGENT_ID / FLAIR_AGENT_ID). The
  // watcher fires it once per poll cycle; failures are swallowed inside watchMail.
  const beatCmd = process.env.TPS_PRESENCE_BEAT_CMD;
  const onPoll: (() => void) | undefined = beatCmd
    ? () => {
        // Fire-and-forget; never block or crash the mail loop. No shell interp.
        const child = spawn(beatCmd, [], {
          env: { ...process.env, FLAIR_AGENT_ID: process.env.FLAIR_AGENT_ID ?? args.agent, TPS_AGENT_ID: process.env.TPS_AGENT_ID ?? args.agent },
          stdio: "ignore",
        });
        child.on("error", () => { /* heartbeat failure must not crash the watcher */ });
      }
    : undefined;

  const watcher = watchMail({
    agent: args.agent,
    debounceMs: args.debounce,
    hook,
    maxConcurrent: 3,
    onPoll,
    onMessage: (msg) => {
      if (args.json) {
        console.log(JSON.stringify(msg));
      } else {
        console.log(`📬 ${msg.from} → ${msg.to}  ${msg.timestamp}`);
        console.log(msg.body);
        console.log("---");
      }
    },
  });

  // Graceful shutdown
  const shutdown = () => {
    watcher.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  await new Promise<void>(() => {});
}
