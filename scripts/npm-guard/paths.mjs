// The npm guard's path root (cli#948 design v3 N4): the one module that defines
// the production root. Under GITHUB_ACTIONS only that root is accepted; a
// per-test root is accepted only when GITHUB_ACTIONS is not `true`.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_ROOT = "/tmp/tps-npm-guard";
export const ROOT_ENV = "TPS_NPM_GUARD_ROOT";
export const GUARD_DIR = dirname(fileURLToPath(import.meta.url));

export function selectRoot(candidate = process.env[ROOT_ENV]) {
  if (candidate === undefined || candidate === "") {
    return { ok: true, root: PRODUCTION_ROOT };
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    return { ok: false, reason: "a per-test guard root is not accepted under GITHUB_ACTIONS" };
  }
  return { ok: true, root: resolve(candidate) };
}

// The recorded-npm file holds the absolute path of the real npm.
export function recordedNpmPath(root) {
  return join(root, "real-npm");
}

export function scriptShellPath() {
  return join(GUARD_DIR, "script-shell");
}
