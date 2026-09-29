// Types for pi-tps-mail package

/**
 * A VERIFIED inbound, as `tps mail check <agent> --json` prints it (cli#429):
 * the CLI's promotion path verified its signed envelope, and `from`, `to`,
 * `body` and `envelopeId` come from that envelope.
 */
export interface MailMessage {
  /** The local record id (the `tps mail ack` key). Not part of the signature. */
  id: string;
  /** The VERIFIED sender (the signed envelope's `from`). */
  from: string;
  /** The message body from the verified envelope (usually a spec or task). */
  body: string;
  /** ISO timestamp (the signed envelope's). */
  timestamp?: string;
  /** Recipient (the signed envelope's `to`). */
  to?: string;
  /** The VERIFIED envelope `messageId`: the thread a reply to this message signs. */
  envelopeId?: string;
  /** The signed `messageId` this message itself replies to, when it is a reply. */
  replyToId?: string;
}

/** Watcher options */
export interface WatchOptions {
  /** Agent ID to watch (default: "ember") */
  agent?: string;
  /** Path to ~/.tps directory (default: process.env.HOME) */
  inboxRoot?: string;
  /** Path to launcher script (default: ~/agents/{agent}/bin/{agent}) */
  launcher?: string;
  /** Arguments to pass to the launcher (default: message body only) */
  launcherArgs?: string[];
  /** Dispatch timeout in ms (default: 1_800_000 = 30 min) */
  timeoutMs?: number;
  /** Poll interval in ms (default: 5000) */
  pollIntervalMs?: number;
  /**
   * The verified check (`tps mail check`) runs whenever new/ holds mail, and at
   * least this often otherwise, so a cur/ record whose lease expired without an
   * ack is re-presented (default: 60_000).
   */
  rescanIntervalMs?: number;
  /**
   * First re-send delay in ms after a reply send whose outcome is UNKNOWN (a
   * non-zero exit or a timeout) (default: 60_000). The same message — same
   * text, thread and envelope messageId — is re-sent after this delay,
   * doubling per failure up to 30 minutes; the launcher is not re-run.
   */
  retryBackoffMs?: number;
  /** Bound on one `tps mail send` in ms (default: 30_000). */
  sendTimeoutMs?: number;
  /** Bound on one `tps mail ack` in ms (default: 10_000). */
  ackTimeoutMs?: number;
  /** Bound on one `tps mail check` in ms (default: 30_000). */
  checkTimeoutMs?: number;
}

/** Mail watcher handle */
export interface MailWatcher {
  /** Stop the watcher: no new poll, CLI run or launcher run starts after this. */
  stop(): void;
  /** Resolves once the poll in flight when stop() was called has finished. */
  drain(): Promise<void>;
}
