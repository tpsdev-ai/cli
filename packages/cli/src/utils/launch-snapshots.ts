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
 * snapshot has its owner record. A SIGINT, SIGTERM or SIGHUP, or a throw, while
 * the snapshot is pending runs the launcher's cleanup; a forced kill there can
 * leave the pending directory behind.
 *
 * Each snapshot records its owning launcher: pid and, when one is readable, a
 * process start token. When the recorded and current tokens are both readable
 * from the same source and differ, the sweep treats the pid as reused and the
 * owner as gone; when they match, the snapshot is kept. The next launch attempts
 * to remove published and pending entries whose recorded owner is dead, and
 * entries with no readable owner record whose directory mtime is at least a
 * grace period old: one minute for a published entry, 24 hours for a pending
 * one. A removal that fails is logged and the entry is kept. A live launch's
 * pending entry has no owner record only from creating the directory until it
 * writes the record, which it does next; 24 hours is far past that step. If a
 * later launch removes the directory while its launcher is stopped inside that
 * step, the launcher fails writing the owner record when it resumes and
 * publishes nothing.
 *
 * The sweep selects an entry only when its name is `config-` or
 * `.pending-config-` followed by exactly six letters or digits, the suffix
 * mkdtemp appends. tps's other entries in `~/.tps/launch` are attestation
 * directories (launch-attestation.ts), named `<id>-<8 hex digits>` or
 * `<first 16 characters of the id>-<8 hex digits>`, where the id has no `/`
 * (`tps agent start` accepts only ids matching `^[a-zA-Z0-9._-]{1,64}$`): the
 * ninth character from the end of such a name is `-`, and in every name the
 * sweep selects it is the `i` of `config`. So the sweep selects no attestation
 * directory, whatever the agent id.
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
import { pidState, processStartToken } from "@tpsdev-ai/agent";

export const LAUNCH_SNAPSHOT_PREFIX = "config-";
/** A snapshot in the making, renamed to `config-*` once its owner record is written. */
export const LAUNCH_SNAPSHOT_PENDING_PREFIX = ".pending-config-";
export const LAUNCH_SNAPSHOT_OWNER_FILE = "owner.json";
/** An owner record larger than this is treated as unreadable. */
export const LAUNCH_SNAPSHOT_OWNER_MAX_BYTES = 4096;
/** Default for how long an ownerless published snapshot may exist before it is treated as stale. */
export const LAUNCH_SNAPSHOT_OWNER_GRACE_MS = 60_000;
/** How long an ownerless pending snapshot may exist before it is treated as stale. */
export const LAUNCH_SNAPSHOT_PENDING_OWNER_GRACE_MS = 24 * 60 * 60 * 1000;
/** The largest pid Bun's and Node's process.kill accept as an argument. */
const LAUNCH_SNAPSHOT_MAX_PID = 2_147_483_647;
/** The six letters or digits mkdtemp appends to a snapshot prefix. */
const LAUNCH_SNAPSHOT_SUFFIX = /^[A-Za-z0-9]{6}$/;

/** Which kind of snapshot entry a name is, or null for a name the sweep never selects. */
function snapshotKind(name: string): "published" | "pending" | null {
  for (const [prefix, kind] of [
    [LAUNCH_SNAPSHOT_PENDING_PREFIX, "pending"],
    [LAUNCH_SNAPSHOT_PREFIX, "published"],
  ] as const) {
    if (name.startsWith(prefix) && LAUNCH_SNAPSHOT_SUFFIX.test(name.slice(prefix.length))) return kind;
  }
  return null;
}

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

function tokenSource(token: string): string {
  const colon = token.indexOf(":");
  return colon === -1 ? token : token.slice(0, colon);
}

/**
 * "dead" — pid gone, or pid alive under a different readable start token from
 * the same source. While the pid is alive, a token from another source, or
 * either token unavailable (the recorded token, or the current one), is
 * "unverifiable": it is kept, never treated as dead. A pid that pidState
 * classifies as "invalid" is "unreadable", like an owner record that cannot be
 * read.
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

/** The entry's recorded owner is dead, or it has no readable owner record and is at least `graceMs` old. */
function isStale(path: string, graceMs: number, now: number): boolean {
  const owner = readLaunchSnapshotOwner(path);
  const state = owner === null ? "unreadable" : ownerState(owner);
  if (state === "dead") return true;
  if (state !== "unreadable") return false;
  let mtimeMs: number;
  try {
    mtimeMs = lstatSync(path).mtimeMs;
  } catch {
    // Unknown age never licenses removal.
    return false;
  }
  return now - mtimeMs >= graceMs;
}

export interface SweepLaunchSnapshotsOptions {
  graceMs?: number;
  now?: number;
}

/**
 * Attempt to remove snapshot directories (named as the module header states)
 * directly under `launchDir` whose recorded owner is dead, or that have no
 * readable owner record and are at least their grace period old: `graceMs` for
 * a published entry, LAUNCH_SNAPSHOT_PENDING_OWNER_GRACE_MS for a pending one.
 * Age is the entry directory's mtime; an entry whose mtime cannot be read is
 * kept. A removal that fails is logged, that entry is kept, and the sweep goes
 * on to the next entry. Returns the removed paths. Throws only when the directory itself cannot be listed;
 * the caller decides whether that fails the launch.
 */
export function sweepStaleLaunchSnapshots(
  launchDir: string,
  options: SweepLaunchSnapshotsOptions = {},
): string[] {
  const graceMs = options.graceMs ?? LAUNCH_SNAPSHOT_OWNER_GRACE_MS;
  const now = options.now ?? Date.now();
  const removed: string[] = [];

  for (const entry of readdirSync(launchDir, { withFileTypes: true })) {
    const kind = snapshotKind(entry.name);
    if (kind === null) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;

    const path = join(launchDir, entry.name);
    if (!isStale(path, kind === "pending" ? LAUNCH_SNAPSHOT_PENDING_OWNER_GRACE_MS : graceMs, now)) continue;

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
