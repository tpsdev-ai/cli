// proc-start-tokens.mjs — test support for cli#1045.
//
// A live pid whose recorded `ps:` start token differs from its current one is
// unverified, not stale (a `ps:` token may predate the TZ/locale pin), so a
// test that stages a REUSED live pid — a same-source token the live process
// cannot carry — needs `proc:` tokens. This installs a reader through the agent
// package's start-token seam that gives every live pid a `proc:` token: the
// real `/proc/<pid>/stat` fields where they are readable (Linux), otherwise a
// stat field list whose starttime is the pid (deterministic across processes,
// so a CLI subprocess started with the preload agrees with the test process).
//
// Plain JS so a bun test can import it and `node --import` can preload it
// (proc-start-tokens-preload.mjs) into a CLI subprocess. Both resolve
// `@tpsdev-ai/agent` to the same built module the CLI uses.
import { readFileSync } from "node:fs";
import { pidState, startTokenTestHooks } from "@tpsdev-ai/agent";

/** `/proc/<pid>/stat` fields after `comm`, or null where it cannot be read. */
function realProcStatFields(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const rparen = stat.lastIndexOf(")");
    return rparen === -1 ? null : stat.slice(rparen + 2).split(" ");
  } catch {
    return null;
  }
}

/** A stat field list for a live pid whose starttime (fields[19]) is the pid itself. */
function stagedProcStatFields(pid) {
  if (pidState(pid) !== "alive") return null;
  return ["S", ...Array(18).fill("0"), String(pid)];
}

/** Install the `proc:` reader; returns a function that restores the previous one. */
export function installProcStartTokens() {
  const previous = startTokenTestHooks.readStat;
  startTokenTestHooks.readStat = (pid) => realProcStatFields(pid) ?? stagedProcStatFields(pid);
  return () => {
    startTokenTestHooks.readStat = previous;
  };
}
