import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireMailLockSync, type MailLock } from "./mail-lock.js";

export const RELAY_ACCEPT_LOCK_STRIPES = 64;

// Lock sharing requires matching process mail directories; MailClient.mailDir does not select this namespace.
export function relayAcceptanceLockRoot(branchId: string, id: string): string {
  const stripe = createHash("sha256").update(branchId).update("\0").update(id).digest()[0]! % RELAY_ACCEPT_LOCK_STRIPES;
  const mailDir = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
  return join(mailDir, ".relay-accept-locks", String(stripe));
}

export function tryAcquireRelayMoveLock(record: unknown): MailLock | null {
  const delivery = (record as { relayDelivery?: { branchId?: unknown; id?: unknown } } | null)?.relayDelivery;
  if (typeof delivery?.branchId !== "string" || typeof delivery.id !== "string") return { release() {} };
  const root = relayAcceptanceLockRoot(delivery.branchId, delivery.id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return acquireMailLockSync(root, { timeoutMs: 0 });
}
