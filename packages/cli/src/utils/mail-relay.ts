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
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RELAY_PID_PATH = join(homedir(), ".tps", "relay.pid");
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

/**
 * Run the relay daemon loop. Polls until SIGTERM/SIGINT.
 */
export async function runRelayDaemon(mailDir: string): Promise<void> {
  // Write PID file
  mkdirSync(join(homedir(), ".tps"), { recursive: true });
  writeFileSync(RELAY_PID_PATH, `${process.pid}\n`, "utf-8");

  process.on("SIGTERM", () => {
    rmSync(RELAY_PID_PATH, { force: true });
    process.exit(0);
  });
  process.on("SIGINT", () => {
    rmSync(RELAY_PID_PATH, { force: true });
    process.exit(0);
  });

  console.log(
    `[relay] TPS mail relay started (pid=${process.pid}, mailDir=${mailDir})`,
  );

  while (true) {
    try {
      const n = deliverPendingMail(mailDir);
      if (n > 0) console.log(`[relay] Delivered ${n} message(s)`);
    } catch (err: any) {
      console.error(`[relay] Error:`, err?.message ?? err);
    }
    await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
  }
}

/** Get relay PID if running, else null. */
export function getRelayPid(): number | null {
  if (!existsSync(RELAY_PID_PATH)) return null;
  try {
    const pid = parseInt(readFileSync(RELAY_PID_PATH, "utf-8").trim(), 10);
    // Verify process is alive
    process.kill(pid, 0);
    return pid;
  } catch {
    rmSync(RELAY_PID_PATH, { force: true });
    return null;
  }
}
