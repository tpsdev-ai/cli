/**
 * test-home-guard.mjs — snapshot the REAL `~/.tps` so a test run can prove it
 * did not touch it (cli#430).
 *
 * The cli test suite used to resolve `~/.tps` from the operator's real HOME:
 * identity fixtures (`key-test-ops36.*`, `test-bot-ops36.*`), credential audit
 * rows, and transient `auth/`, `agents/`, `run/` entries were written into the
 * live tree — on a host that runs production agents under the same user. The
 * fix has two halves and this is the second: the suite is LAUNCHED with HOME
 * pointing at a throwaway root (so a forgotten test cannot reach the real
 * HOME), and this module snapshots the real `~/.tps` before and after the run
 * and fails the run if anything changed.
 *
 * WHY A SNAPSHOT, NOT A PATCH. An `fs` patch cannot see
 * `import { writeFileSync } from "node:fs"`, and an in-process
 * `process.env.HOME` reassignment cannot move `os.homedir()` (bun caches it at
 * first call — which is exactly the bug this guards). A before/after snapshot of
 * the real tree is the backstop that catches a leak no matter how it was
 * written: paths, sizes and mtimes only — NEVER file contents.
 *
 * Shared by the monorepo launcher (scripts/test-suite.mjs) and the plugin's
 * self-contained launcher.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function statSig(path) {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "gone";
  }
}

/**
 * Snapshot `home/.tps`: every entry (directories AND files) mapped to a
 * size+mtime signature. Contents are never read. A missing tree is represented
 * so "created during the run" is itself a change.
 */
export function snapshotTps(home) {
  const root = join(home, ".tps");
  const entries = new Map();
  const walk = (dir, rel) => {
    entries.set(rel === "" ? "." : rel, statSig(dir));
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const childRel = rel === "" ? name : join(rel, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, childRel);
      else entries.set(childRel, `${st.size}:${st.mtimeMs}`);
    }
  };
  const exists = existsSync(root);
  if (exists) walk(root, "");
  return { exists, entries };
}

/**
 * Paths that differ between two snapshots (added, removed, or size/mtime
 * changed). Sorted, so the failure message is stable.
 */
export function diffSnapshots(before, after) {
  const changed = [];
  const keys = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const key of keys) {
    if (before.entries.get(key) !== after.entries.get(key)) changed.push(key);
  }
  if (before.exists !== after.exists) {
    changed.push(before.exists ? ".tps removed" : ".tps created");
  }
  return changed.sort();
}

/**
 * Format a failure message for a non-empty diff. Never prints file contents.
 */
export function describeLeak(home, changed) {
  const shown = changed.slice(0, 40);
  const more = changed.length > shown.length ? `\n  …and ${changed.length - shown.length} more` : "";
  return [
    `HOME-ISOLATION GUARD: the run changed the real ${join(home, ".tps")} — it is NOT touching an isolated tree.`,
    `  Changed entries (paths + size/mtime only, never contents):`,
    ...shown.map((p) => `    ${p}`),
    more,
    `  Every lane must run through its isolated launcher (scripts/test-suite.mjs /`,
    `  plugins/openclaw-tps-mail/scripts/run-tests.mjs); a test that reaches the real`,
    `  ~/.tps is a leak, not a result.`,
  ]
    .filter(Boolean)
    .join("\n");
}
