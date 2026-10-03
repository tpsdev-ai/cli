// The mailbox lock lives in @tpsdev-ai/agent so MailClient and promote() hold the same one.
export { acquireMailLock, acquireMailLockSync, MAIL_LOCK_DIR, type MailLock, mailLockPath, processStartToken } from "@tpsdev-ai/agent";
