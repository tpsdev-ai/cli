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
 *   1. write a sibling temp file with a UNIQUE name, created exclusively
 *      (O_EXCL), and fsync(2) it — the bytes are on stable storage before they
 *      become visible under the store's name, and no other writer can share
 *      or replace the temp file;
 *   2. rename(2) it over the store — atomic: a reader sees the old file or the
 *      new one, never a partial write;
 *   3. fsync(2) the containing directory — the rename itself is persisted.
 * Any step that fails throws (removing the temp file), and the caller treats
 * the write as not made. The old-or-new guarantee is per replacement; a
 * read-modify-write is atomic only under the store's lock (store-lock.ts).
 *
 * WHAT THAT SURVIVES. The process being killed at any instant (the store holds
 * either the old or the new contents), and — on a filesystem and device that
 * honour fsync — an operating-system crash or power loss after the write
 * returned. It does NOT survive storage that acknowledges fsync without
 * persisting (a volatile write cache; on macOS, fsync(2) does not flush the
 * drive's cache — F_FULLFSYNC does, and node does not expose it), or the loss
 * of the device. The reviewer hosts run Linux, where fsync reaches the device.
 */

import { randomBytes } from "node:crypto";
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

/** A sibling name no other writer uses: pid plus 12 random bytes. */
function uniqueSibling(file: string, suffix: string): string {
  return `${file}.${process.pid}.${randomBytes(12).toString("hex")}.${suffix}`;
}

/** Replace a store file durably: a uniquely named, exclusively created temp
 *  file + fsync, atomic rename, then fsync of the directory. Throws when any
 *  step fails. */
export function writeJsonStore(file: string, value: unknown): void {
  const tmp = uniqueSibling(file, "tmp");
  const fd = openSync(tmp, "wx", 0o600);
  let renamed = false;
  try {
    try {
      writeSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    renamed = true;
    fsyncPath(dirname(file), "r");
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing else uses that name; a leftover temp file is inert.
      }
    }
  }
}

/** Append one JSON line to a log file and fsync it. When the call CREATES the
 *  file (mode 0600), the directory is fsync'ed too, so the new entry — and
 *  with it the line — survives a crash. Throws when any step fails. */
export function appendJsonLine(file: string, value: unknown): void {
  let fd: number;
  let created = true;
  try {
    fd = openSync(file, "ax", 0o600);
  } catch (err) {
    if ((err as { code?: unknown }).code !== "EEXIST") throw err;
    created = false;
    fd = openSync(file, "a", 0o600);
  }
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) fsyncPath(dirname(file), "r");
}

/** Prove the store's directory accepts the write its atomic replace performs,
 *  by creating (exclusively, under a unique name) and removing a sibling probe
 *  file. Throws when it does not. */
export function probeWritable(file: string): void {
  const probe = uniqueSibling(file, "probe");
  const fd = openSync(probe, "wx", 0o600);
  closeSync(fd);
  unlinkSync(probe);
}
