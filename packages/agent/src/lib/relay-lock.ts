import { mkdirSync } from "node:fs";
import { acquireMailLockSync, type MailLock } from "./mail-lock.js";
import { acceptanceLockRoot, acceptanceLockRootFromSnapshot, canonicalMailRoot, configuredMailRoot, RELAY_ACCEPT_LOCK_STRIPES } from "./mail-lock-namespace.js";

export { RELAY_ACCEPT_LOCK_STRIPES };

/** Resolve the mail root for CLI relay acceptance and reservation checks. */
export function relayAcceptanceLockRoot(branchId: string, id: string, mailRoot = configuredMailRoot()): string {
  return acceptanceLockRoot(mailRoot, branchId, id);
}

// When a relay stripe is required, MailClient supplies its canonical path string;
// CLI callers without it resolve the process mail root here.
export function tryAcquireRelayMoveLock(record: unknown, mailRootSnapshot?: string): MailLock | null {
  const delivery = (record as { relayDelivery?: { branchId?: unknown; id?: unknown } } | null)?.relayDelivery;
  if (typeof delivery?.branchId !== "string" || typeof delivery.id !== "string") return { release() {} };
  const root = acceptanceLockRootFromSnapshot(mailRootSnapshot ?? canonicalMailRoot(configuredMailRoot()), delivery.branchId, delivery.id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return acquireMailLockSync(root, { timeoutMs: 0 });
}
