/**
 * durable-file.ts — the JSON-file primitives behind the plugin's two durable
 * stores (the dispatch latch store and the pending-audit store).
 *
 * READS. A store file that does not exist is EMPTY. Every other read failure —
 * an unreadable file, invalid JSON, or a shape the store does not recognise —
 * is THROWN, never treated as empty: treating it as empty would silently drop
 * latches or retained audit records, and the next write would replace whatever
 * the file held. Callers map a thrown store error to a refusal whose text
 * names no path.
 *
 * WRITES. `writeJsonStore` returns only after the new contents are durable:
 *   1. write a sibling temp file and fsync(2) it — the bytes are on stable
 *      storage before they become visible under the store's name;
 *   2. rename(2) it over the store — atomic: a reader sees the old file or the
 *      new one, never a partial write;
 *   3. fsync(2) the containing directory — the rename itself is persisted.
 * Any step that fails throws, and the caller treats the write as not made.
 *
 * WHAT THAT SURVIVES. The process being killed at any instant (the store holds
 * either the old or the new contents), and — on a filesystem and device that
 * honour fsync — an operating-system crash or power loss after the write
 * returned. It does NOT survive storage that acknowledges fsync without
 * persisting (a volatile write cache; on macOS, fsync(2) does not flush the
 * drive's cache — F_FULLFSYNC does, and node does not expose it), or the loss
 * of the device. The reviewer hosts run Linux, where fsync reaches the device.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Read and parse a JSON store file. Returns `undefined` ONLY when the file
 *  does not exist; any other failure throws. */
export function readJsonStore(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text);
}

/** fsync a file or directory by path. */
function fsyncPath(path: string, flags: string): void {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Replace a store file durably: temp file + fsync, atomic rename, then fsync
 *  of the directory. Throws when any step fails. */
export function writeJsonStore(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  fsyncPath(dirname(file), "r");
}

/** Append one JSON line to a log file and fsync it (the file is created with
 *  mode 0600 when absent). Throws when any step fails. */
export function appendJsonLine(file: string, value: unknown): void {
  const fd = openSync(file, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Prove the store's directory accepts the write its atomic replace performs,
 *  by creating and removing a sibling probe file. Throws when it does not. */
export function probeWritable(file: string): void {
  const probe = `${file}.probe`;
  const fd = openSync(probe, "w", 0o600);
  closeSync(fd);
  unlinkSync(probe);
}
