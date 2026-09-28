// Types for pi-tps-mail package

/** Message structure for TPS mail */
export interface MailMessage {
  /** Unique message ID */
  id: string;
  /** Sender agent ID */
  from: string;
  /** Message body (usually a spec or task) */
  body: string;
  /** ISO timestamp */
  timestamp?: string;
  /** Recipient (if applicable) */
  to?: string;
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
  /** Poll interval for new/ in ms (default: 5000) */
  pollIntervalMs?: number;
  /**
   * First retry delay in ms after a reply send FAILS (default: 60_000). The
   * inbound is not acknowledged; it goes back to new/ and the same reply is
   * re-sent after this delay, doubling per failure up to 30 minutes.
   */
  retryBackoffMs?: number;
}

/** Mail watcher handle */
export interface MailWatcher {
  /** Stop the watcher */
  stop(): void;
}
