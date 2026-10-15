/**
 * mail-lock-namespace.ts — the derivation of the relay lock roots that CLI relay
 * acceptance and the agent MailClient coordinate on (cli#616).
 *
 * CLI relay acceptance takes its acceptance stripe from the process mail root
 * (`TPS_MAIL_DIR`); its recipient mailbox locks come from the selected mailbox
 * and scan roots, which can be branch-office mailboxes outside that root.
 * MailClient derives its stripe and mailbox paths from one resolved mail-root
 * string per operation, also resolving the mailbox directory beneath it.
 *
 * The relay stripe is a cooperative lock among MailClients that resolve the
 * same canonical path. The OS follows same-user filesystem changes to that
 * path during an operation; the stripe does not exclude them.
 *
 * Mailbox lock roots come from here only for acceptance and
 * MailClient: acceptance uses canonicalMailboxRoot; MailClient derives its
 * promotion and recovery lock paths from the canonical mailbox string resolved
 * once per operation (cli#636). The CLI's other mailbox lock sites use the
 * mailbox root path as given.
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
  return acceptanceLockRootFromSnapshot(canonicalMailRoot(mailRoot), branchId, id);
}

/** Derive a stripe path from a canonical mail-root string without resolving again. */
export function acceptanceLockRootFromSnapshot(mailRoot: string, branchId: string, id: string): string {
  const stripe = createHash("sha256").update(branchId).update("\0").update(id).digest()[0]! % RELAY_ACCEPT_LOCK_STRIPES;
  return join(mailRoot, ".relay-accept-locks", String(stripe));
}

/** The mailbox lock root for `agentId`, under `mailRoot`. */
export function mailboxLockRoot(mailRoot: string, agentId: string): string {
  return join(canonicalMailRoot(mailRoot), agentId);
}

/** The resolved real path of a mailbox directory, created first if absent. */
export function canonicalMailboxRoot(mailboxRoot: string): string {
  mkdirSync(mailboxRoot, { recursive: true, mode: 0o700 });
  return realpathSync(mailboxRoot);
}
