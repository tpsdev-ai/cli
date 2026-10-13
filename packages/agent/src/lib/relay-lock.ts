import { mkdirSync } from "node:fs";
import { acquireMailLockSync, type MailLock } from "./mail-lock.js";
import { acceptanceLockRoot, configuredMailRoot, RELAY_ACCEPT_LOCK_STRIPES } from "./mail-lock-namespace.js";

export { RELAY_ACCEPT_LOCK_STRIPES };

/**
 * The acceptance-stripe lock root for one relayed delivery. `mailRoot` defaults
 * to the process mail root; MailClient passes its configured `mailDir` as
 * `mailRoot` to `tryAcquireRelayMoveLock`, which derives the same root, so each
 * side derives the stripe from the mail root it is configured with.
 */
export function relayAcceptanceLockRoot(branchId: string, id: string, mailRoot = configuredMailRoot()): string {
  return acceptanceLockRoot(mailRoot, branchId, id);
}

export function tryAcquireRelayMoveLock(record: unknown, mailRoot = configuredMailRoot()): MailLock | null {
  const delivery = (record as { relayDelivery?: { branchId?: unknown; id?: unknown } } | null)?.relayDelivery;
  if (typeof delivery?.branchId !== "string" || typeof delivery.id !== "string") return { release() {} };
  const root = acceptanceLockRoot(mailRoot, delivery.branchId, delivery.id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return acquireMailLockSync(root, { timeoutMs: 0 });
}
