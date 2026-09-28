/**
 * latch-admin.ts — the HOST's command for the dispatch latch store.
 *
 * This is a command-line program the host operator runs on the gateway host,
 * as the gateway's service user. It is not registered with OpenClaw and no
 * agent-invokable tool reaches it: the plugin registers exactly one verb,
 * `github_review`, which can set a latch but never clear one.
 *
 *   node dist/src/latch-admin.js list  <reconcileFile>
 *   node dist/src/latch-admin.js clear <reconcileFile> <dispatchId>
 *
 * Clear a `reconcile_required` latch only AFTER reconciling the pull request's
 * reviews on GitHub. A `posted` latch records the dispatch's one verdict; the
 * remedy for a further review is a fresh dispatch, not clearing the latch. A
 * store file this command cannot parse is refused and left untouched. A latch
 * the gateway could only hold in memory (its host log says so) is dropped by
 * restarting the gateway once the reviews are reconciled.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FileReconcileStore } from "./audit.js";

export const LATCH_ADMIN_USAGE = [
  "usage: latch-admin list  <reconcileFile>",
  "       latch-admin clear <reconcileFile> <dispatchId>",
].join("\n");

/** Run one latch-admin command. Returns the process exit code: 0 success,
 *  1 the store could not be read or written, 2 usage. */
export function runLatchAdmin(argv: string[], out: (line: string) => void, err: (line: string) => void): number {
  const [command, file, dispatchId, ...rest] = argv;
  const usable = (command === "list" && file && dispatchId === undefined) || (command === "clear" && file && dispatchId && rest.length === 0);
  if (!usable) {
    err(LATCH_ADMIN_USAGE);
    return 2;
  }
  const store = new FileReconcileStore(file!);
  try {
    if (command === "list") {
      for (const entry of store.list()) out(`${entry.dispatchId}\t${entry.latch}`);
      return 0;
    }
    out(store.clear(dispatchId!) ? `cleared ${dispatchId}` : `no latch for ${dispatchId}`);
    return 0;
  } catch (e) {
    err(`latch-admin: the latch store could not be ${command === "list" ? "read" : "updated"}: ${(e as Error).message}`);
    return 1;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = runLatchAdmin(
    process.argv.slice(2),
    (line) => console.log(line),
    (line) => console.error(line),
  );
}
