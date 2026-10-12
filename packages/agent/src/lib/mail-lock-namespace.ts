/**
 * mail-lock-namespace.ts — the ONE derivation of the relay lock namespace for a
 * physical mail store (cli#616).
 *
 * The CLI relay acceptance path keys its locks off the process mail root
 * (`TPS_MAIL_DIR`), while the agent MailClient keys off its configured
 * `mailDir`. When the two point at the same physical store through different
 * settings — a symlinked directory, a relative segment — the two used to
 * derive different lock namespaces for it, so acceptance's stripe and the
 * same-ID move coordination did not cover MailClient promotion or dead-letter
 * moves. Deriving every lock from the store's RESOLVED REAL PATH (symlinks and
 * `.`/`..` resolved) makes the two agree by construction, in one module both
 * packages import, so the derivation cannot drift.
 */
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RELAY_ACCEPT_LOCK_STRIPES = 64;

/** The process mail root, unresolved: `TPS_MAIL_DIR`, else `~/.tps/mail`. */
export function configuredMailRoot(): string {
  return process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
}

/**
 * The canonical mail root for lock derivation: the resolved real path of
 * `mailRoot`, with symlinks and `.`/`..` segments resolved. A root that does not
 * exist yet is created first, then resolved, so a store made here resolves the
 * same way for a later process that reaches it by another path.
 */
export function canonicalMailRoot(mailRoot: string): string {
  mkdirSync(mailRoot, { recursive: true, mode: 0o700 });
  return realpathSync(mailRoot);
}

/** The acceptance-stripe lock root for one relayed delivery, under `mailRoot`. */
export function acceptanceLockRoot(mailRoot: string, branchId: string, id: string): string {
  const stripe = createHash("sha256").update(branchId).update("\0").update(id).digest()[0]! % RELAY_ACCEPT_LOCK_STRIPES;
  return join(canonicalMailRoot(mailRoot), ".relay-accept-locks", String(stripe));
}

/** The mailbox lock root for `agentId`, under `mailRoot`. */
export function mailboxLockRoot(mailRoot: string, agentId: string): string {
  return join(canonicalMailRoot(mailRoot), agentId);
}

/** The canonical root for a mailbox directory already resolved to a path. */
export function canonicalMailboxRoot(mailboxRoot: string): string {
  mkdirSync(mailboxRoot, { recursive: true, mode: 0o700 });
  return realpathSync(mailboxRoot);
}
