/**
 * durable-file.ts — the JSON-file primitives behind the plugin's two durable
 * stores (the dispatch latch store and the pending-audit store).
 *
 * A store file that does not exist is EMPTY. Every other read failure — an
 * unreadable file, invalid JSON, or a shape the store does not recognise — is
 * THROWN, never treated as empty: treating it as empty would silently drop
 * latches or retained audit records, and the next write would replace whatever
 * the file held. Callers map a thrown store error to a refusal whose text names
 * no path.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

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

/** Replace a store file atomically: write a sibling temp file, then rename. */
export function writeJsonStore(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

/** Prove the store's directory accepts the write its atomic replace performs,
 *  by creating and removing a sibling probe file. Throws when it does not. */
export function probeWritable(file: string): void {
  const probe = `${file}.probe`;
  writeFileSync(probe, "", { encoding: "utf8", mode: 0o600 });
  unlinkSync(probe);
}
