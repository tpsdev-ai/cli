/**
 * Launch snapshots — the per-launch copy of the operator's agent config.
 *
 * `tps agent start --config` copies the config into a private `config-*`
 * directory under `~/.tps/launch`, so the sandboxed workload cannot rewrite the
 * file that authorized its launch. The launcher removes that directory on exit
 * and on SIGINT/SIGTERM/SIGHUP; a forced termination leaves it behind.
 *
 * Each snapshot records its owning launcher — pid and process start token, so
 * a reused pid is not mistaken for the owner — and the next launch removes
 * entries whose recorded owner is gone. An entry with no owner record is kept
 * for a short grace period, because it may be between `mkdtemp` and the owner
 * write.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { processStartToken } from "@tpsdev-ai/agent";

export const LAUNCH_SNAPSHOT_PREFIX = "config-";
export const LAUNCH_SNAPSHOT_OWNER_FILE = "owner.json";
/** How long an ownerless snapshot may exist before it is treated as stale. */
export const LAUNCH_SNAPSHOT_OWNER_GRACE_MS = 60_000;

export interface LaunchSnapshotOwner {
  pid: number;
  startToken: string | null;
}

/** Record this process as the owner of a freshly created snapshot directory. */
export function writeLaunchSnapshotOwner(snapshotDir: string): void {
  const owner: LaunchSnapshotOwner = {
    pid: process.pid,
    startToken: processStartToken(process.pid),
  };
  writeFileSync(join(snapshotDir, LAUNCH_SNAPSHOT_OWNER_FILE), JSON.stringify(owner), {
    mode: 0o600,
    flag: "wx",
  });
}

/**
 * Read an owner record without following a symlink: the file is opened with
 * O_NOFOLLOW and its type is read from the open descriptor.
 */
function readLaunchSnapshotOwner(snapshotDir: string): LaunchSnapshotOwner | null {
  let fd: number;
  try {
    fd = openSync(join(snapshotDir, LAUNCH_SNAPSHOT_OWNER_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const parsed = JSON.parse(readFileSync(fd, "utf-8")) as Partial<LaunchSnapshotOwner>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return {
      pid: parsed.pid,
      startToken: typeof parsed.startToken === "string" ? parsed.startToken : null,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: exists but owned by someone else — alive.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function tokenSource(token: string): string {
  const colon = token.indexOf(":");
  return colon === -1 ? token : token.slice(0, colon);
}

/**
 * "dead" — pid gone, or pid alive under a different start token from the same
 * source. A token from another source, or no recorded token, is
 * "unverifiable": it is kept, never treated as dead.
 */
function ownerState(owner: LaunchSnapshotOwner): "alive" | "dead" | "unverifiable" {
  if (!pidAlive(owner.pid)) return "dead";
  if (owner.startToken === null) return "unverifiable";
  const current = processStartToken(owner.pid);
  if (current === null) return "unverifiable";
  if (tokenSource(current) !== tokenSource(owner.startToken)) return "unverifiable";
  return current === owner.startToken ? "alive" : "dead";
}

export interface SweepLaunchSnapshotsOptions {
  graceMs?: number;
  now?: number;
}

/**
 * Remove `config-*` directories directly under `launchDir` that no live owner
 * holds: a recorded owner that is dead, or no readable owner record past the
 * grace period. Returns the removed paths. Throws only when the directory
 * itself cannot be listed; the caller decides whether that fails the launch.
 */
export function sweepStaleLaunchSnapshots(
  launchDir: string,
  options: SweepLaunchSnapshotsOptions = {},
): string[] {
  const graceMs = options.graceMs ?? LAUNCH_SNAPSHOT_OWNER_GRACE_MS;
  const now = options.now ?? Date.now();
  const removed: string[] = [];

  for (const entry of readdirSync(launchDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(LAUNCH_SNAPSHOT_PREFIX)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;

    const path = join(launchDir, entry.name);
    const owner = readLaunchSnapshotOwner(path);
    if (owner === null) {
      let mtimeMs: number;
      try {
        mtimeMs = lstatSync(path).mtimeMs;
      } catch {
        // Unknown age never licenses removal.
        continue;
      }
      if (now - mtimeMs < graceMs) continue;
    } else if (ownerState(owner) !== "dead") {
      continue;
    }

    try {
      // rm does not traverse a symlink in place of the entry.
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch (error) {
      console.error(
        `warning: could not remove stale launch snapshot ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return removed;
}
