/** Compatibility reader backed by the shared strict Ed25519 parser. */
import { readPrivateKeyAtPath } from "./agent-keys.js";

export function readSigningSeedFile(keyPath: string): Uint8Array {
  const seed = readPrivateKeyAtPath(keyPath);
  if (!seed) throw new Error(`no Ed25519 private key at ${keyPath} — refusing to send unsigned mail`);
  return seed;
}
