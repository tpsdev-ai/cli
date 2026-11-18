/**
 * verify-bin.ts — cli#1036: a core binary's absolute path on the facts verify
 * PATH (`verifyEnv().PATH`, `/usr/bin:/bin`), resolved on the host running the
 * test. A fixture that spells `/bin/grep`, `/bin/false` or `/usr/bin/test` holds
 * on Linux (where /bin is /usr/bin) and not on macOS (grep and false are only in
 * /usr/bin, test only in /bin), so runVerify reported `spawn_error` there
 * instead of the result the case is about. Throws, naming the binary and the
 * PATH, when the host has none.
 */
import { verifyEnv } from "../../src/utils/facts-verify.js";

export function verifyBin(name: string): string {
  const PATH = verifyEnv().PATH;
  const found = Bun.which(name, { PATH });
  if (!found) throw new Error(`${name} is not on the facts verify PATH (${PATH}) on this host`);
  return found;
}
