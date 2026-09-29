/**
 * test-home-guard.mjs — the shared HOME-isolation helpers for the test
 * launchers and their preloads (cli#430).
 *
 * The cli test suite used to resolve `~/.tps` from the operator's real HOME:
 * identity fixtures (`key-test-ops36.*`, `test-bot-ops36.*`), credential audit
 * rows, and transient `auth/`, `agents/`, `run/` entries were written into the
 * live tree — on a host that runs production agents under the same user.
 *
 * THE CONTROL is HOME redirection plus an ALLOWLISTED environment, applied by
 * each launcher before bun boots:
 *   - `createIsolatedRoot` makes a fresh throwaway root under the launcher's temp
 *     dir, and `isolatedChildEnv` builds the child's WHOLE environment: the few
 *     named, path-free variables in `PASSED_ENV` (plus PATH), and the variables
 *     the launcher owns — HOME and TPS_TEST_ROOT at the root, TMPDIR/TMP/TEMP and
 *     bun's transpiler cache inside it. Every other inherited variable is
 *     dropped, including ones nobody has named yet;
 *   - `assertTestDestinations` refuses — before anything is created or deleted —
 *     a temp dir inside an operator home, a report dir inside an operator-critical
 *     directory (`~/.tps`, `~/.flair`, `~/agents`, `~/.config`), and a report,
 *     log or seal path that resolves there or is a symlink; `assertSuiteName`
 *     refuses a suite name that is not a plain file-name token;
 *   - `testRootRefusal` is the preloads' root check: a TPS_TEST_ROOT that is or
 *     contains the account's home, or that no launcher vouched for and that is or
 *     contains the HOME the process runs under, aborts the run.
 * These are LAUNCH-TIME checks, not an OS boundary: a process that ignores HOME
 * and its environment, or a caller who forges the launcher's variables, can
 * still reach the real home. The OS-enforced boundary is cli#434.
 *
 * THE LAUNCHER ITSELF runs under the caller's environment: only its CHILD gets
 * the allowlisted one. A launcher started under bun (rather than node, which
 * `bun run test` uses) may write bun's own transpiler cache under the caller's
 * XDG_CACHE_HOME before any of this runs; that write is the launcher's runtime,
 * not a test's.
 *
 * THE SNAPSHOT IS A DIAGNOSTIC, NOT A BOUNDARY. `snapshotTps` records, for every
 * entry under `<home>/.tps` it can stat and list, its path, size, mtime, ctime
 * and inode — never file contents. The launcher fails the lane on a RECORDED
 * METADATA DIFFERENCE between the snapshot taken before the run and the one
 * taken at the end. It can miss a change: an entry it cannot stat or list is
 * recorded as absent (or its children are not recorded at all), and a change
 * that leaves every recorded signature as it was is invisible to it. It does
 * not see reads, writes outside `~/.tps`, or a transient write that is gone
 * again by the end (a `~/.tps` created and removed within the run leaves no
 * difference).
 *
 * Shared by the monorepo launcher (scripts/test-suite.mjs), its preload
 * (scripts/home-isolation-preload.ts), and the openclaw-tps-mail plugin's
 * launcher and preload (plugins/openclaw-tps-mail/scripts/run-tests.mjs,
 * test/preload-guard.ts), which run only inside this monorepo: its tests import
 * packages/cli/dist, and its scripts/ and test/ directories are not part of the
 * published plugin package.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// The environment a test child gets: an allowlist
// ---------------------------------------------------------------------------

/**
 * The ONLY inherited variables a test child is given, each with the reason it
 * is passed. Everything else the launcher inherits is dropped. None of these is
 * read as a directory: apart from PATH, a value containing "/" is dropped too
 * (`isPathFree`), so a path cannot arrive under one of these names either.
 */
export const PASSED_ENV = {
  PATH: "bun, node, git and the other tools the tests spawn are found through it",
  LANG: "locale: the language and encoding of the tools the tests spawn",
  LANGUAGE: "locale: message-language preference of the tools the tests spawn",
  LC_ALL: "locale: overrides every LC_* category",
  LC_CTYPE: "locale: character encoding",
  LC_COLLATE: "locale: sort order of the tools the tests spawn",
  LC_MESSAGES: "locale: message language",
  TERM: "terminal type: bun's output formatting only",
  NO_COLOR: "turns colour off in bun's output",
  FORCE_COLOR: "turns colour on in bun's piped output",
  CI: "bun test's CI behaviour: a stray test.only fails the run, and a missing snapshot fails instead of being written",
  GITHUB_ACTIONS: "bun test prints each failure as a GitHub Actions annotation",
};

/** A value that cannot name a directory: no "/" anywhere in it. */
export function isPathFree(value) {
  return !String(value).includes("/");
}

/**
 * The allowlisted part of `env`: the `PASSED_ENV` names, each only when its
 * value is path-free (PATH excepted). Returns the names it dropped — names only,
 * never values — so a launcher can say what it removed.
 */
export function sanitizedTestEnv(env) {
  const out = {};
  const dropped = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const passed = Object.hasOwn(PASSED_ENV, name) && (name === "PATH" || isPathFree(value));
    if (passed) out[name] = value;
    else dropped.push(name);
  }
  return { env: out, dropped: dropped.sort() };
}

// ---------------------------------------------------------------------------
// The throwaway root and the variables the launcher owns
// ---------------------------------------------------------------------------

/**
 * The child's temp dir, inside the root. Kept to one character on purpose: on
 * macOS a unix socket path must fit in 103 bytes, and tests create sockets
 * under os.tmpdir().
 */
export const ROOT_TMP = "t";

/** bun's runtime transpiler cache for the child, inside the root. */
export const ROOT_BUN_CACHE = join(".cache", "bun");

/** The marker a launcher writes in the root it created; holds the run's token. */
export const ROOT_MARKER = ".tps-test-root";

/**
 * Create a fresh throwaway root under `tempBase` (realpath'd: on macOS /tmp and
 * /var are symlinks, and the guards compare realpaths), its temp dir, and the
 * marker that lets the preload tell a launcher-made root from any other
 * directory. Returns the root and the random token written into the marker.
 */
export function createIsolatedRoot(tempBase) {
  const root = realpathSync(mkdtempSync(join(tempBase, "tps-")));
  mkdirSync(join(root, ROOT_TMP), { recursive: true });
  const token = randomBytes(16).toString("hex");
  writeFileSync(join(root, ROOT_MARKER), token, { flag: "wx" });
  return { root, token };
}

/**
 * The child's WHOLE environment: the allowlisted inherited variables
 * (`sanitizedTestEnv`), then the ones the launcher owns — HOME and TPS_TEST_ROOT
 * at the root, TPS_TEST_ROOT_TOKEN (the marker's token), TMPDIR/TMP/TEMP and
 * bun's transpiler cache inside the root — then `extra` (the plugin's mail and
 * keys dirs). Returns the inherited names dropped (a name the launcher sets
 * itself is replaced, so it is not listed).
 */
export function isolatedChildEnv(inherited, { root, token, extra = {} }) {
  const { env, dropped } = sanitizedTestEnv(inherited);
  const tmp = join(root, ROOT_TMP);
  const owned = {
    HOME: root,
    TPS_TEST_ROOT: root,
    TPS_TEST_ROOT_TOKEN: token,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, ROOT_BUN_CACHE),
    ...extra,
  };
  Object.assign(env, owned);
  // A name the launcher sets itself is replaced, not dropped: report only the rest.
  return { env, dropped: dropped.filter((name) => !Object.hasOwn(owned, name)) };
}

// ---------------------------------------------------------------------------
// Where a launcher may create, write and delete
// ---------------------------------------------------------------------------

/** The operator-critical directories under a home that no test run may create or delete inside. */
export const OPERATOR_DIRS = [".tps", ".flair", "agents", ".config"];

/** A refusal to run: a destination or a suite name that the launcher will not use. */
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

/** `p` is `dir` or lies under it (both already realpath'd). */
export const inside = (dir, p) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

let accountHomeCache;

/**
 * The account's home from the user database, realpath'd; undefined without a
 * passwd entry. Under node that is os.userInfo().homedir. bun's
 * os.userInfo().homedir returns $HOME whenever HOME is set (measured on bun
 * 1.3.10), which would make "the account's home" whatever the caller says; so
 * under bun it is asked of a child bun started WITHOUT HOME, which reads the
 * user database. Computed once per process.
 */
export function accountHome() {
  if (accountHomeCache !== undefined) return accountHomeCache || undefined;
  let home = "";
  try {
    if (process.versions.bun) {
      const r = spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:os').userInfo().homedir)"], {
        cwd: "/",
        env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
        encoding: "utf8",
      });
      home = r.status === 0 ? (r.stdout ?? "").trim() : "";
    } else {
      home = userInfo().homedir ?? "";
    }
  } catch {
    home = ""; // no passwd entry (an arbitrary container uid)
  }
  accountHomeCache = home ? realpathLoose(home) : "";
  return accountHomeCache || undefined;
}

/**
 * Every home that counts as the operator's: the launcher's HOME (os.homedir()
 * when HOME is unset) and the account's home from the user database (so a run
 * with HOME pointed elsewhere still protects the real account).
 */
export function operatorHomes(env = process.env) {
  const homes = new Set([realpathLoose(env.HOME || homedir())]);
  const account = accountHome();
  if (account) homes.add(account);
  return [...homes];
}

/** The operator-critical directories (realpath'd) under every operator home. */
export function operatorCriticalDirs(env = process.env) {
  return operatorHomes(env).flatMap((home) => OPERATOR_DIRS.map((d) => realpathLoose(join(home, d))));
}

/**
 * A suite name is a report file's base name: one token of [A-Za-z0-9._-], never
 * `.`/`..` and never containing `..`. Checked before any filesystem call, so a
 * name cannot steer a report, log or seal path out of the report dir.
 */
export function assertSuiteName(suite) {
  if (typeof suite !== "string" || !/^[A-Za-z0-9._-]+$/.test(suite) || suite.includes("..") || suite === ".") {
    throw new IsolationRefusal(
      `HOME-ISOLATION GUARD: refusing the suite name ${JSON.stringify(suite)} — a suite name is the report's base name and may contain only A-Z, a-z, 0-9, ".", "_" and "-" (no path separator, no "..").`,
    );
  }
}

function refuse(label, real, hit, remedy) {
  return new IsolationRefusal(
    [
      `HOME-ISOLATION GUARD: refusing to run — ${label} resolves to "${real}", inside "${hit}".`,
      `  ${remedy}`,
    ].join("\n"),
  );
}

/**
 * Refuse — throw IsolationRefusal — when the report dir resolves inside an
 * operator-critical directory, or when one of `paths` (the report, log and seal
 * this run will delete and write) does, or is a symlink (even a dangling one:
 * writing through it would land wherever it points). Call it before the first
 * delete and again before any later write.
 */
export function assertReportPaths({ env = process.env, reportDir, paths = [] }) {
  const critical = operatorCriticalDirs(env);
  const remedy =
    "Stale reports are deleted and new ones written there, so no report path may sit inside ~/.tps, ~/.flair, ~/agents or ~/.config. Point TPS_TEST_REPORT_DIR (or the repo's test-reports/) at a directory outside them and re-run.";
  const dirReal = realpathLoose(reportDir);
  const dirHit = critical.find((dir) => inside(dir, dirReal));
  if (dirHit) throw refuse("the report dir", dirReal, dirHit, remedy);
  for (const path of paths) {
    if (dirname(resolve(path)) !== resolve(reportDir)) {
      throw new IsolationRefusal(`HOME-ISOLATION GUARD: refusing to run — the report path "${path}" is not directly inside the report dir "${reportDir}".`);
    }
    let link = false;
    try {
      link = lstatSync(path).isSymbolicLink();
    } catch {
      link = false; // absent: nothing to follow
    }
    if (link) {
      throw new IsolationRefusal(
        `HOME-ISOLATION GUARD: refusing to run — the report path "${path}" is a symlink; the launcher deletes and writes its report, log and seal and will not follow a link. Remove it and re-run.`,
      );
    }
    const real = realpathLoose(path);
    const hit = critical.find((dir) => inside(dir, real));
    if (hit) throw refuse(`the report path "${path}"`, real, hit, remedy);
  }
}

/**
 * Refuse when the launcher's temp dir — where it creates and later removes the
 * throwaway root — resolves inside (or is) any operator home. The root must be
 * made outside every operator home.
 */
export function assertTempBase({ env = process.env, tempBase }) {
  const real = realpathLoose(tempBase);
  const hit = operatorHomes(env).find((home) => inside(home, real));
  if (hit) {
    throw refuse(
      "the temp dir (TMPDIR)",
      real,
      hit,
      `The launcher creates and deletes its throwaway root there, and that must happen outside every operator home. Point TMPDIR at a directory outside "${hit}" (for example /tmp) and re-run.`,
    );
  }
}

/**
 * Every destination check a launcher makes before it creates or deletes
 * anything: the temp dir, the report dir, and each report/log/seal path.
 */
export function assertTestDestinations({ env = process.env, tempBase, reportDir, paths = [] }) {
  assertTempBase({ env, tempBase });
  assertReportPaths({ env, reportDir, paths });
}

// ---------------------------------------------------------------------------
// The preloads' root check
// ---------------------------------------------------------------------------

/**
 * Why `rootReal` (TPS_TEST_ROOT, realpath'd) must not be used as the test root,
 * or null when it may. A root may not be, or contain:
 *   - the account's home from the user database (whatever HOME says);
 *   - the HOME this process runs under (`homeReal`), unless a launcher vouched
 *     for the root: `token` (TPS_TEST_ROOT_TOKEN) equals the marker the launcher
 *     wrote in the root it created. A bare `bun test` has no launcher, so the
 *     HOME it runs under is taken to be the operator's real HOME, and since the
 *     preload also requires that HOME to lie inside the root, a bare run is
 *     always refused.
 * A launch-time check: a caller who forges the marker and the token can pass it.
 */
export function testRootRefusal({ rootReal, homeReal, token }) {
  const account = accountHome();
  if (account && inside(rootReal, account)) {
    return `TPS_TEST_ROOT resolves to "${rootReal}", which is or contains the account's home "${account}" (os.userInfo().homedir)`;
  }
  let vouched = false;
  if (token) {
    try {
      vouched = readFileSync(join(rootReal, ROOT_MARKER), "utf8") === token;
    } catch {
      vouched = false;
    }
  }
  if (!vouched && inside(rootReal, homeReal)) {
    return `TPS_TEST_ROOT resolves to "${rootReal}", which is or contains the HOME this process runs under ("${homeReal}"), and no launcher vouched for it (TPS_TEST_ROOT_TOKEN does not match ${join(rootReal, ROOT_MARKER)})`;
  }
  return null;
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
 * Snapshot `home/.tps`: every entry it can stat and list (directories AND
 * files) mapped to its size/mtime/ctime/inode signature. Contents are never
 * read. A missing tree is represented so "created during the run" is itself a
 * change. An entry that cannot be stat'ed is skipped, and a directory that
 * cannot be listed is recorded without its children — so a change there can be
 * missed.
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
 * Paths whose recorded metadata differs between two snapshots (added, removed,
 * or a changed size/mtime/ctime/inode). Sorted, so the failure message is
 * stable.
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
    `  Entries whose recorded metadata differs (path + size/mtime/ctime/inode only, never contents):`,
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
