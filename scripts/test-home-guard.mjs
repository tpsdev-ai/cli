/**
 * test-home-guard.mjs — the shared HOME-isolation helpers for the test
 * launchers (cli#430).
 *
 * The cli test suite used to resolve `~/.tps` from the operator's real HOME:
 * identity fixtures (`key-test-ops36.*`, `test-bot-ops36.*`), credential audit
 * rows, and transient `auth/`, `agents/`, `run/` entries were written into the
 * live tree — on a host that runs production agents under the same user.
 *
 * THE CONTROL is HOME redirection plus a sanitized environment, applied by each
 * launcher before bun boots:
 *   - `sanitizedTestEnv` removes every inherited variable that can route a
 *     write around HOME (XDG base dirs, TPS_*, FLAIR_*, BOB_*, OPENCLAW_*,
 *     CODEX_HOME, …), so a test's paths fall back to the child's HOME, which the
 *     launcher points at a throwaway root;
 *   - `assertTestDestinations` refuses — before anything is created or deleted —
 *     a temp dir or report dir that resolves inside an operator-critical
 *     directory (`~/.tps`, `~/.flair`, `~/agents`, `~/.config`).
 *
 * THE SNAPSHOT IS A DIAGNOSTIC, NOT A BOUNDARY. `snapshotTps` records, for every
 * entry under `<home>/.tps`, its path, size, mtime, ctime and inode — never file
 * contents. `diffSnapshots` then reports a change that PERSISTS to the end of the
 * run: an entry added or removed, a size or mtime change, a file replaced by
 * rename (new inode), a same-size rewrite whose mtime was restored (restoring
 * mtime moves ctime), and a create-then-remove inside an existing directory (the
 * directory's own mtime/ctime move). It does NOT detect: reads; writes outside
 * `~/.tps`; a `~/.tps` that did not exist, was created, and was removed again.
 * Nothing here is OS-enforced: a process that ignores HOME and the environment
 * can still reach the real home.
 *
 * Shared by the monorepo launcher (scripts/test-suite.mjs) and the
 * openclaw-tps-mail plugin launcher (plugins/openclaw-tps-mail/scripts/run-tests.mjs),
 * which runs only inside this monorepo: its tests import packages/cli/dist, and
 * its scripts/ directory is not part of the published plugin package.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// The environment a test child inherits
// ---------------------------------------------------------------------------

/**
 * Inherited variable FAMILIES dropped from every test child: each is read as a
 * path (or an identity/endpoint) that bypasses HOME — TPS_ROOT, TPS_HOME,
 * TPS_IDENTITY_DIR, TPS_REGISTRY_DIR, TPS_MAIL_DIR, TPS_CONTEXT_DIR, FLAIR_URL,
 * FLAIR_KEY_PATH, FLAIR_DIR, OPENCLAW_HOME, … The launcher sets the few it owns
 * (TPS_TEST_ROOT, and the plugin's mail/keys dirs) AFTER sanitizing.
 */
export const DROPPED_ENV_PREFIXES = ["TPS_", "FLAIR_", "BOB_", "OPENCLAW_"];

/** Single inherited variables dropped for the same reason (each is read as a path by the code or its tools). */
export const DROPPED_ENV_NAMES = [
  "XDG_CONFIG_HOME", // auth.ts gemini sync, agent llm/provider.ts, nono profiles
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME", // nono state (the attested launcher pins its own)
  "CODEX_HOME", // auth.ts codex sync, llm-proxy.ts
  "CLAUDE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "GIT_CONFIG_GLOBAL", // a `git config --global` in a test would write it
  "USERPROFILE", // init.ts falls back to it
  "DEPLOY_BOT_TPS_DIR",
  "AGENT_WORKSPACE", // expanded into agent config paths
];

/**
 * Test KNOBS kept even though they carry the TPS_ prefix: none names a directory
 * the suite writes under.
 */
export const KEPT_TPS_KNOBS = ["TPS_TEST_MODE", "TPS_TEST_NODE", "TPS_TEST_KEEP_ROOT"];

/**
 * A copy of `env` with every home-routing override removed (see the two lists
 * above). Returns the names it dropped — names only, never values — so a
 * launcher can say what it removed.
 */
export function sanitizedTestEnv(env) {
  const out = {};
  const dropped = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const family = DROPPED_ENV_PREFIXES.some((p) => name.startsWith(p)) && !KEPT_TPS_KNOBS.includes(name);
    if (family || DROPPED_ENV_NAMES.includes(name)) {
      dropped.push(name);
      continue;
    }
    out[name] = value;
  }
  return { env: out, dropped: dropped.sort() };
}

// ---------------------------------------------------------------------------
// Where a launcher may create and delete
// ---------------------------------------------------------------------------

/** The operator-critical directories under a home that no test run may create or delete inside. */
export const OPERATOR_DIRS = [".tps", ".flair", "agents", ".config"];

/** A refusal to run: a destination resolves inside an operator-critical directory. */
export class IsolationRefusal extends Error {}

/**
 * realpath() for a path that may not exist yet: resolve the nearest existing
 * ancestor (so a symlink anywhere above counts) and re-append the rest.
 */
export function realpathLoose(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(realpathLoose(parent), basename(abs));
  }
}

const inside = (dir, p) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * Every home that counts as the operator's: the launcher's HOME, what
 * os.homedir() resolves, and the account's home from the user database (so a
 * run with HOME pointed elsewhere still protects the real account).
 */
export function operatorHomes(env = process.env) {
  const homes = new Set();
  let account;
  try {
    account = userInfo().homedir;
  } catch {
    account = undefined; // no passwd entry (an arbitrary container uid)
  }
  for (const h of [env.HOME, homedir(), account]) {
    if (h) homes.add(realpathLoose(h));
  }
  return [...homes];
}

/** The operator-critical directories (realpath'd) under every operator home. */
export function operatorCriticalDirs(env = process.env) {
  return operatorHomes(env).flatMap((home) => OPERATOR_DIRS.map((d) => realpathLoose(join(home, d))));
}

/**
 * Refuse — throw IsolationRefusal — when the launcher's temp dir (os.tmpdir(),
 * and the TMPDIR/TMP/TEMP the child inherits) or the report dir resolves inside
 * an operator-critical directory. Call it BEFORE creating or deleting anything:
 * the launcher creates and removes its throwaway root under the temp dir and
 * deletes stale reports in the report dir.
 */
export function assertTestDestinations({ env = process.env, reportDir } = {}) {
  const critical = operatorCriticalDirs(env);
  const checks = [["os.tmpdir()", tmpdir()]];
  for (const name of ["TMPDIR", "TMP", "TEMP"]) {
    if (env[name]) checks.push([name, env[name]]);
  }
  if (reportDir) checks.push(["TPS_TEST_REPORT_DIR", reportDir]);
  for (const [label, value] of checks) {
    const real = realpathLoose(value);
    const hit = critical.find((dir) => inside(dir, real));
    if (hit) {
      throw new IsolationRefusal(
        [
          `HOME-ISOLATION GUARD: refusing to run — ${label} resolves to "${real}", inside the operator directory "${hit}".`,
          "  The launcher creates and deletes its throwaway root under the temp dir and deletes",
          "  stale reports in the report dir, so neither may sit inside ~/.tps, ~/.flair, ~/agents",
          `  or ~/.config. Point ${label === "os.tmpdir()" ? "TMPDIR" : label} at a directory outside them (for example /tmp) and re-run.`,
        ].join("\n"),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The ~/.tps metadata snapshot (a diagnostic)
// ---------------------------------------------------------------------------

/** size:mtime:ctime:inode, nanosecond-exact. Restoring mtime (utimes) moves ctime; a rename-over moves the inode. */
function signature(st) {
  return `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
}

function statSig(path) {
  try {
    return signature(statSync(path, { bigint: true }));
  } catch {
    return "gone";
  }
}

/**
 * Snapshot `home/.tps`: every entry (directories AND files) mapped to its
 * size/mtime/ctime/inode signature. Contents are never read. A missing tree is
 * represented so "created during the run" is itself a change.
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
        st = statSync(full, { bigint: true });
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, childRel);
      else entries.set(childRel, signature(st));
    }
  };
  const exists = existsSync(root);
  if (exists) walk(root, "");
  return { exists, entries };
}

/**
 * Paths that differ between two snapshots (added, removed, or a changed
 * size/mtime/ctime/inode). Sorted, so the failure message is stable.
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
    `HOME-ISOLATION GUARD: the run changed ${join(home, ".tps")} — the HOME this launcher runs under, which no test may write.`,
    `  Changed entries (path + size/mtime/ctime/inode only, never contents):`,
    ...shown.map((p) => `    ${p}`),
    more,
    `  Every lane must run through its isolated launcher (scripts/test-suite.mjs /`,
    `  plugins/openclaw-tps-mail/scripts/run-tests.mjs); a test that reaches this`,
    `  ~/.tps is a leak, not a result. (On a host where live agents write ~/.tps,`,
    `  their activity shows here too: run with HOME pointed at an empty directory.)`,
  ]
    .filter(Boolean)
    .join("\n");
}
