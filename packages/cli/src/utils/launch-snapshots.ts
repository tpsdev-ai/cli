/**
 * Launch snapshots — the per-launch copy of the operator's agent config.
 *
 * `tps agent start --config` copies the config into a private `config-*`
 * directory under `~/.tps/launch`, so the sandboxed workload cannot rewrite the
 * file that authorized its launch. The launcher removes that directory on exit
 * and on SIGINT/SIGTERM/SIGHUP; a forced termination leaves it behind.
 *
 * A snapshot is created under a `.pending-config-*` name, gets its owner
 * record, and is then renamed to its final `config-*` name, so a published
 * snapshot has its owner record. The sweep does not examine pending entries at
 * all: a pending directory exists between its creation and that rename, and a
 * launch may be paused there for any length of time, so a sweep that touched it
 * could race that launch. A forced kill in that window can leave one small
 * directory behind.
 *
 * Each snapshot records its owning launcher: pid and, when one is readable, a
 * process start token. When the recorded and current tokens are both readable
 * from the same source and differ, the sweep treats the pid as reused and the
 * owner as gone; when they match, the snapshot is kept. The next
 * launch removes published entries whose recorded owner is dead, plus
 * published entries with no readable owner record past a grace period.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { processStartToken } from "@tpsdev-ai/agent";

export const LAUNCH_SNAPSHOT_PREFIX = "config-";
/** A snapshot in the making: never swept, renamed to `config-*` once owned. */
export const LAUNCH_SNAPSHOT_PENDING_PREFIX = ".pending-config-";
export const LAUNCH_SNAPSHOT_OWNER_FILE = "owner.json";
/** An owner record larger than this is treated as unreadable. */
export const LAUNCH_SNAPSHOT_OWNER_MAX_BYTES = 4096;
/** Default for how long an ownerless snapshot may exist before it is treated as stale. */
export const LAUNCH_SNAPSHOT_OWNER_GRACE_MS = 60_000;
/** The largest pid Bun's and Node's process.kill accept as an argument. */
const LAUNCH_SNAPSHOT_MAX_PID = 2_147_483_647;

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
 * Read an owner record without blocking on a special file: the `owner.json`
 * leaf is opened O_NOFOLLOW|O_NONBLOCK (a symlink at the leaf is not
 * followed), must be a regular file, and must be at most
 * LAUNCH_SNAPSHOT_OWNER_MAX_BYTES. Anything else — missing, not a regular file,
 * oversized, unparsable, a pid that is not an integer in
 * 1..LAUNCH_SNAPSHOT_MAX_PID, a token of the wrong shape, or an error closing
 * the file — is an unreadable owner, which the sweep treats as ownerless.
 */
function readLaunchSnapshotOwner(snapshotDir: string): LaunchSnapshotOwner | null {
  let fd: number;
  try {
    fd = openSync(
      join(snapshotDir, LAUNCH_SNAPSHOT_OWNER_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  let owner: LaunchSnapshotOwner | null;
  try {
    owner = parseLaunchSnapshotOwner(fd);
  } catch {
    owner = null;
  }
  try {
    closeSync(fd);
  } catch {
    return null;
  }
  return owner;
}

function parseLaunchSnapshotOwner(fd: number): LaunchSnapshotOwner | null {
  const stat = fstatSync(fd);
  if (!stat.isFile()) return null;
  if (stat.size > LAUNCH_SNAPSHOT_OWNER_MAX_BYTES) return null;
  const buffer = Buffer.allocUnsafe(stat.size);
  const read = readSync(fd, buffer, 0, stat.size, 0);
  const parsed = JSON.parse(buffer.subarray(0, read).toString("utf-8")) as Partial<LaunchSnapshotOwner>;
  const pid = parsed.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || pid > LAUNCH_SNAPSHOT_MAX_PID) return null;
  const startToken = parsed.startToken;
  if (startToken !== null && typeof startToken !== "string") return null;
  return { pid, startToken };
}

/** Argument errors from process.kill (Bun and Node raise ERR_INVALID_ARG_TYPE for a pid out of range). */
const PID_ARGUMENT_ERRORS = new Set(["ERR_INVALID_ARG_TYPE", "ERR_OUT_OF_RANGE", "EINVAL", "ERANGE"]);

function pidState(pid: number): "alive" | "gone" | "invalid" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: no such process. An argument error: not a valid owner pid.
    // EPERM: exists but owned by someone else — alive.
    if (code === "ESRCH") return "gone";
    if (code !== undefined && PID_ARGUMENT_ERRORS.has(code)) return "invalid";
    return "alive";
  }
}

function tokenSource(token: string): string {
  const colon = token.indexOf(":");
  return colon === -1 ? token : token.slice(0, colon);
}

/**
 * "dead" — pid gone, or pid alive under a different readable start token from
 * the same source. While the pid is alive, a token from another source, or
 * either token unavailable (the recorded token, or the current one), is
 * "unverifiable": it is kept, never treated as dead. A pid for which process.kill
 * raises one of PID_ARGUMENT_ERRORS is "unreadable", like an owner record that
 * cannot be read.
 */
function ownerState(owner: LaunchSnapshotOwner): "alive" | "dead" | "unverifiable" | "unreadable" {
  const pid = pidState(owner.pid);
  if (pid === "invalid") return "unreadable";
  if (pid === "gone") return "dead";
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
 * Remove `config-*` directories directly under `launchDir` whose recorded
 * owner is dead, or that have no readable owner record past the grace period.
 * Pending (`.pending-config-*`) entries are not examined. Age is the entry
 * directory's mtime; an entry whose mtime cannot be read is kept. Returns the
 * removed paths. Throws only when the directory itself cannot be listed; the
 * caller decides whether that fails the launch.
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
    const state = owner === null ? "unreadable" : ownerState(owner);
    if (state === "unreadable") {
      let mtimeMs: number;
      try {
        mtimeMs = lstatSync(path).mtimeMs;
      } catch {
        // Unknown age never licenses removal.
        continue;
      }
      if (now - mtimeMs < graceMs) continue;
    } else if (state !== "dead") {
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
