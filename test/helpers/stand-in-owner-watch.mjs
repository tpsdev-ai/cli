/**
 * cli#1087 — the owner watch for a shell fixture that has no child of its own
 * to wait on. It keeps the fixture alive and exits once its owner is gone,
 * replaced or unverifiable; a signal exits 0, as the trap it replaces did.
 * Reads TPS_STAND_IN_OWNER_PID and TPS_STAND_IN_OWNER_START.
 */
import { STAND_IN_POLL_MS, standInOwnerFromEnv, standInOwnerLost } from "./stand-in.mjs";

const owner = standInOwnerFromEnv();
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => process.exit(0));
}
setInterval(() => {
  if (standInOwnerLost(owner.pid, owner.start)) process.exit(0);
}, STAND_IN_POLL_MS);
