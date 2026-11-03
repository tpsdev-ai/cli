/**
 * TPS Mail Relay — standalone daemon that routes outbox → recipient inboxes.
 *
 * Watches all {mailDir}/*\/outbox/ dirs, moves messages to {mailDir}/{to}/new/.
 * Runs as a separate process: `tps mail relay start|stop|status`
 *
 * This is the correct mail infrastructure, not a per-agent hack. Eventually
 * this becomes the bridge to remote agents over wire protocol.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pidState, processStartToken, type PidState } from "@tpsdev-ai/agent";
import snooplogg from "snooplogg";
import { homeDir } from "./home.js";
import { readPidFile, removePidFile, serializePidRecord, type PidFileState } from "./pid-file.js";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:mail");


function relayPidPath(): string {
  return join(homeDir(), ".tps", "relay.pid");
}
const RELAY_POLL_MS = 500;

/** agentId validation — same rule as everywhere else */
function isValidAgentId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/**
 * Scan all agent outboxes and deliver messages to recipient inboxes.
 * Returns number of messages delivered.
 */
export function deliverPendingMail(mailDir: string): number {
  let delivered = 0;

  if (!existsSync(mailDir)) return 0;

  const agents = readdirSync(mailDir).filter((d) => isValidAgentId(d));

  for (const agent of agents) {
    const outbox = join(mailDir, agent, "outbox");
    if (!existsSync(outbox)) continue;

    const files = readdirSync(outbox).filter(
      (f) => !f.startsWith(".") && f.endsWith(".json"),
    );

    for (const file of files) {
      const srcPath = join(outbox, file);
      try {
        const raw = readFileSync(srcPath, "utf-8");
        const msg = JSON.parse(raw) as {
          to: string;
          body: string;
          sentAt: string;
        };

        if (!msg.to || !isValidAgentId(msg.to)) {
          // Invalid recipient — dead-letter (move to dead/ dir)
          const dead = join(mailDir, agent, "dead");
          mkdirSync(dead, { recursive: true });
          renameSync(srcPath, join(dead, file));
          continue;
        }

        const recipientInbox = join(mailDir, msg.to, "new");
        mkdirSync(recipientInbox, { recursive: true });

        // Stable filename: sentAt + original filename (prevents collisions)
        const safeTs = (msg.sentAt ?? new Date().toISOString()).replace(
          /[:.]/g,
          "-",
        );
        const destFile = `${safeTs}-${agent}-${file}`;
        renameSync(srcPath, join(recipientInbox, destFile));

        delivered++;
      } catch {
        // Leave in outbox — will retry next poll
      }
    }
  }

  return delivered;
}

/** The relay's own pid file, best effort at exit. */
function removeOwnPidFile(): void {
  try {
    removePidFile(relayPidPath());
  } catch {
    /* exit path: nothing left to report to */
  }
}

/**
 * Run the relay daemon loop. Polls until SIGTERM/SIGINT.
 */
export async function runRelayDaemon(mailDir: string): Promise<void> {
  // Write PID file. The record carries the kernel start token so a later stop
  // can tell this process from an unrelated one that reused the pid.
  mkdirSync(join(homeDir(), ".tps"), { recursive: true });
  writeFileSync(relayPidPath(), serializePidRecord(process.pid, processStartToken(process.pid)), "utf-8");

  process.on("SIGTERM", () => {
    removeOwnPidFile();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    removeOwnPidFile();
    process.exit(0);
  });

  slog(
    `[relay] TPS mail relay started (pid=${process.pid}, mailDir=${mailDir})`,
  );

  while (true) {
    try {
      const n = deliverPendingMail(mailDir);
      if (n > 0) slog(`[relay] Delivered ${n} message(s)`);
    } catch (err: any) {
      serror(`[relay] Error:`, err?.message ?? err);
    }
    await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
  }
}

/** Classify the relay pid file. */
export function readRelayPidFile(): PidFileState {
  return readPidFile(relayPidPath());
}

/** Get relay PID if running, else null. */
export function getRelayPid(probe: (pid: number) => PidState = pidState): number | null {
  const state = readRelayPidFile();
  if (state.kind === "missing" || state.kind === "unreadable") return null;
  // Invalid and stale files name no live relay: remove them.
  if (state.kind === "invalid" || state.kind === "stale") {
    removePidFile(state.path);
    return null;
  }
  if (state.kind === "running") return state.pid;
  // A legacy record (no token) is live: report it for status/start, but stop
  // re-reads the file and refuses to signal an unverifiable identity.
  if (probe(state.pid) === "alive") return state.pid;
  removePidFile(state.path);
  return null;
}
