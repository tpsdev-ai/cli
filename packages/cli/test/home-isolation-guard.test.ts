/**
 * home-isolation-guard.test.ts — cli#430.
 *
 * Coverage for the suite-level HOME isolation:
 *   - scripts/test-home-guard.mjs — the environment ALLOWLIST, the throwaway
 *     root, the temp/report destination checks, the suite-name check, the
 *     preloads' root check, and the `~/.tps` metadata snapshot (a diagnostic);
 *   - scripts/home-isolation-preload.ts and the two plugins' test/preload-guard.ts —
 *     the launch-time precondition, in every location a bare `bun test` can
 *     start from;
 *   - the three launchers (scripts/test-suite.mjs and each plugin's
 *     scripts/run-tests.mjs), end to end.
 *
 * Every end-to-end case runs against a SIMULATED operator home (a temp dir
 * passed as HOME), never the real one: a leak these cases provoke lands in a
 * throwaway directory. Fixture tests receive the paths they need baked into
 * their source, not through the environment — the launchers pass a test only
 * their allowlist.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  IsolationRefusal,
  PASSED_ENV,
  ROOT_MARKER,
  accountHome,
  assertReportPaths,
  assertSuiteName,
  assertTempBase,
  diffSnapshots,
  isolatedChildEnv,
  sanitizedTestEnv,
  snapshotTps,
  testRootRefusal,
} from "../../../scripts/test-home-guard.mjs";

const REPO = resolve(import.meta.dir, "../../..");
const PRELOAD = join(REPO, "scripts/home-isolation-preload.ts");
const SUITE_LAUNCHER = join(REPO, "scripts/test-suite.mjs");
const GUARD_MODULE = join(REPO, "scripts/test-home-guard.mjs");
const PLUGIN_DIR = join(REPO, "plugins/openclaw-tps-mail");
const PLUGIN_LAUNCHER = join(PLUGIN_DIR, "scripts/run-tests.mjs");
const REVIEW_DIR = join(REPO, "plugins/openclaw-github-review");
const REVIEW_LAUNCHER = join(REVIEW_DIR, "scripts/run-tests.mjs");

/** The end-to-end cases spawn a launcher that spawns bun; allow for a slow runner. */
const E2E_TIMEOUT = 60_000;

/** node, when installed: `bun run test` starts the launchers under node. */
const NODE = Bun.which("node");

let dirs: string[] = [];
beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/** process.env with overrides; an explicit `undefined` DELETES the variable. */
function envWith(overrides: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** A string literal for fixture source: paths are baked in, never passed through the environment. */
const q = (s: string): string => JSON.stringify(s);

/** A whole-second timestamp a minute ago: utimes() can restore it exactly. */
function wholeSecondInThePast(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
}

describe("test-home-guard: ~/.tps metadata snapshot (a diagnostic)", () => {
  let home: string;
  beforeEach(() => {
    home = mktmp("tps-guard-home-");
  });

  test("no change -> empty diff", () => {
    mkdirSync(join(home, ".tps", "identity"), { recursive: true });
    writeFileSync(join(home, ".tps", "identity", "a.key"), "seed");
    const before = snapshotTps(home);
    // A second snapshot of an untouched tree is identical.
    expect(diffSnapshots(before, snapshotTps(home))).toEqual([]);
  });

  test("a created .tps is a change", () => {
    const before = snapshotTps(home); // .tps does not exist yet
    mkdirSync(join(home, ".tps"), { recursive: true });
    const changed = diffSnapshots(before, snapshotTps(home));
    expect(changed).toContain(".tps created");
  });

  test("a new file under .tps is a change", () => {
    mkdirSync(join(home, ".tps", "identity"), { recursive: true });
    const before = snapshotTps(home);
    writeFileSync(join(home, ".tps", "identity", "key-test-ops36.key"), "seed");
    const changed = diffSnapshots(before, snapshotTps(home));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.some((p) => p.includes("key-test-ops36.key"))).toBe(true);
  });

  test("a size change to an existing file is a change", () => {
    mkdirSync(join(home, ".tps", "credentials"), { recursive: true });
    writeFileSync(join(home, ".tps", "credentials", "audit.log"), "row\n");
    const before = snapshotTps(home);
    writeFileSync(join(home, ".tps", "credentials", "audit.log"), "row\nrow2\n");
    const changed = diffSnapshots(before, snapshotTps(home));
    expect(changed.some((p) => p.includes("audit.log"))).toBe(true);
  });

  test("a same-size rewrite with its mtime restored is a change (restoring mtime moves ctime)", async () => {
    const file = join(home, ".tps", "identity", "a.key");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "seed-1");
    const t = wholeSecondInThePast();
    utimesSync(file, t, t);
    await Bun.sleep(50); // past the filesystem's timestamp tick
    const s0 = statSync(file, { bigint: true });
    const before = snapshotTps(home);
    writeFileSync(file, "seed-2"); // same size
    utimesSync(file, t, t); // mtime restored exactly
    const s1 = statSync(file, { bigint: true });
    // What a size+mtime signature compares is identical...
    expect(s1.size).toBe(s0.size);
    expect(s1.mtimeNs).toBe(s0.mtimeNs);
    // ...and the snapshot still reports the file.
    expect(diffSnapshots(before, snapshotTps(home))).toContain(join("identity", "a.key"));
  });

  test("a file replaced by rename with the same size and mtime is a change (new inode)", () => {
    const file = join(home, ".tps", "identity", "a.key");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "seed-1");
    const t = wholeSecondInThePast();
    utimesSync(file, t, t);
    const s0 = statSync(file, { bigint: true });
    const before = snapshotTps(home);
    const staged = join(dirname(file), ".a.key.new");
    writeFileSync(staged, "seed-2");
    utimesSync(staged, t, t);
    renameSync(staged, file);
    const s1 = statSync(file, { bigint: true });
    expect(s1.size).toBe(s0.size);
    expect(s1.mtimeNs).toBe(s0.mtimeNs);
    expect(s1.ino).not.toBe(s0.ino);
    expect(diffSnapshots(before, snapshotTps(home))).toContain(join("identity", "a.key"));
  });

  test("a file created and removed inside an existing directory is a change (the directory moves)", () => {
    const run = join(home, ".tps", "run");
    mkdirSync(run, { recursive: true });
    const t = wholeSecondInThePast();
    utimesSync(run, t, t);
    const before = snapshotTps(home);
    writeFileSync(join(run, "probe.pid"), "1");
    unlinkSync(join(run, "probe.pid"));
    expect(diffSnapshots(before, snapshotTps(home))).toContain("run");
  });

  test("LIMIT (documented): a ~/.tps created and removed within the run leaves no difference", () => {
    const before = snapshotTps(home); // no .tps
    mkdirSync(join(home, ".tps", "auth"), { recursive: true });
    rmSync(join(home, ".tps"), { recursive: true, force: true });
    expect(diffSnapshots(before, snapshotTps(home))).toEqual([]);
  });
});

describe("test-home-guard: the environment ALLOWLIST", () => {
  test("passes only the allowlisted names and drops everything else, including a variable nobody has named", () => {
    const { env, dropped } = sanitizedTestEnv({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      TERM: "xterm-256color",
      NO_COLOR: "1",
      CI: "true",
      GITHUB_ACTIONS: "true",
      // Path-bearing, identity or credential variables — named or not:
      NONO_BIN: "/sentinel/nono",
      XDG_CONFIG_HOME: "/sentinel/config",
      XDG_CACHE_HOME: "/sentinel/cache",
      TMPDIR: "/sentinel/tmp",
      TPS_ROOT: "/sentinel/tps",
      TPS_TEST_MODE: "docker",
      TPS_TEST_NODE: "/sentinel/node",
      FLAIR_URL: "http://sentinel.invalid",
      CODEX_HOME: "/sentinel/codex",
      SSH_AUTH_SOCK: "/sentinel/agent.sock",
      NODE_OPTIONS: "--require /sentinel/hook.js",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "/sentinel/bun-cache",
      OPENAI_API_KEY: "sentinel-key",
      CLAUDECODE: "1",
      SOME_FUTURE_TOOL_DIR: "/sentinel/future",
    });
    expect(Object.keys(env).sort()).toEqual(["CI", "GITHUB_ACTIONS", "LANG", "LC_ALL", "NO_COLOR", "PATH", "TERM"]);
    for (const name of ["NONO_BIN", "XDG_CONFIG_HOME", "TMPDIR", "TPS_ROOT", "SSH_AUTH_SOCK", "NODE_OPTIONS", "SOME_FUTURE_TOOL_DIR"]) {
      expect(dropped).toContain(name);
    }
    // Names only: the values never appear in what the launcher reports.
    expect(dropped.join(" ")).not.toContain("sentinel");
  });

  test("an allowlisted name whose value is a path is dropped too (PATH excepted)", () => {
    const { env, dropped } = sanitizedTestEnv({
      PATH: "/usr/bin:/bin",
      LANG: "/sentinel/locale",
      LC_ALL: "/sentinel/locale",
      TERM: "../sentinel",
      CI: "true",
    });
    expect(Object.keys(env).sort()).toEqual(["CI", "PATH"]);
    expect(dropped).toEqual(["LANG", "LC_ALL", "TERM"]);
  });

  test("every allowlisted name states why it is passed", () => {
    for (const [name, reason] of Object.entries(PASSED_ENV)) {
      expect(typeof reason, name).toBe("string");
      expect((reason as string).length, name).toBeGreaterThan(10);
    }
  });

  test("the child environment is the allowlist plus the launcher's own values, temp and bun cache inside the root", () => {
    const root = "/iso/tps-root";
    const { env, dropped } = isolatedChildEnv(
      { PATH: "/usr/bin", HOME: "/sentinel/home", TMPDIR: "/sentinel/tmp", XDG_CACHE_HOME: "/sentinel/cache" },
      { root, token: "tok", extra: { TPS_MAIL_DIR: `${root}/.tps/mail` } },
    );
    expect(Object.keys(env).sort()).toEqual([
      "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
      "HOME",
      "PATH",
      "TEMP",
      "TMP",
      "TMPDIR",
      "TPS_MAIL_DIR",
      "TPS_TEST_ROOT",
      "TPS_TEST_ROOT_TOKEN",
    ]);
    expect(env.HOME).toBe(root);
    expect(env.TPS_TEST_ROOT).toBe(root);
    for (const name of ["TMPDIR", "TMP", "TEMP", "BUN_RUNTIME_TRANSPILER_CACHE_PATH"]) {
      expect(env[name].startsWith(`${root}/`), name).toBe(true);
    }
    // HOME and TMPDIR are replaced, not dropped.
    expect(dropped).toEqual(["XDG_CACHE_HOME"]);
  });
});

describe("test-home-guard: destinations and suite names", () => {
  let sim: string;
  beforeEach(() => {
    sim = mktmp("tps-guard-simhome-");
  });

  for (const sub of ["", ".tps", ".flair", "agents", ".config", "tmp"]) {
    test(`refuses a temp dir at ~/${sub} (the root must be made outside every operator home)`, () => {
      expect(() => assertTempBase({ env: { HOME: sim }, tempBase: join(sim, sub) })).toThrow(IsolationRefusal);
    });
  }

  test("refuses a temp dir that reaches the operator home through a symlink", () => {
    const outside = mktmp("tps-guard-link-");
    symlinkSync(sim, join(outside, "via"));
    expect(() => assertTempBase({ env: { HOME: sim }, tempBase: join(outside, "via", "tmp") })).toThrow(IsolationRefusal);
  });

  test("accepts a temp dir outside the operator home", () => {
    const outside = mktmp("tps-guard-outside-");
    expect(() => assertTempBase({ env: { HOME: sim }, tempBase: outside })).not.toThrow();
  });

  test("refuses a report dir inside ~/.flair", () => {
    expect(() => assertReportPaths({ env: { HOME: sim }, reportDir: join(sim, ".flair", "reports") })).toThrow(
      /the report dir resolves to .*inside/,
    );
  });

  test("refuses a report dir that is a symlink into ~/.tps (what a default test-reports/ link would be)", () => {
    mkdirSync(join(sim, ".tps", "reports"), { recursive: true });
    const repo = mktmp("tps-guard-repo-");
    symlinkSync(join(sim, ".tps", "reports"), join(repo, "test-reports"));
    expect(() => assertReportPaths({ env: { HOME: sim }, reportDir: join(repo, "test-reports") })).toThrow(IsolationRefusal);
  });

  test("refuses a report path that is a symlink, even a dangling one", () => {
    const reports = mktmp("tps-guard-reports-");
    symlinkSync(join(sim, ".tps", "identity", "victim.log"), join(reports, "cli.log"));
    expect(() =>
      assertReportPaths({ env: { HOME: sim }, reportDir: reports, paths: [join(reports, "cli.log")] }),
    ).toThrow(/is a symlink/);
  });

  test("refuses a report path that is not directly inside the report dir", () => {
    const reports = mktmp("tps-guard-reports-");
    expect(() =>
      assertReportPaths({ env: { HOME: sim }, reportDir: reports, paths: [join(reports, "..", "victim.xml")] }),
    ).toThrow(IsolationRefusal);
  });

  test("accepts a report dir and report paths outside the operator directories", () => {
    const reports = mktmp("tps-guard-reports-");
    expect(() =>
      assertReportPaths({ env: { HOME: sim }, reportDir: reports, paths: [join(reports, "cli.xml"), join(reports, "cli.log")] }),
    ).not.toThrow();
  });

  test("refuses a report dir that IS the operator home (its report, log and seal would be deleted and written there)", () => {
    expect(() =>
      assertReportPaths({ env: { HOME: sim }, reportDir: sim, paths: [join(sim, "cli.xml"), join(sim, "cli.log"), join(sim, "cli.xml.sha256")] }),
    ).toThrow(`the report dir resolves to "${sim}", which is or contains the operator home "${sim}"`);
  });

  test("refuses a report dir that resolves to the operator home through a symlink or a `..`", () => {
    const outside = mktmp("tps-guard-link-");
    symlinkSync(sim, join(outside, "home-link"));
    mkdirSync(join(sim, "sub"));
    for (const dir of [join(outside, "home-link"), `${join(sim, "sub")}/..`]) {
      expect(() => assertReportPaths({ env: { HOME: sim }, reportDir: dir }), dir).toThrow(
        `the report dir resolves to "${sim}", which is or contains the operator home "${sim}"`,
      );
    }
  });

  test("refuses a report dir that is an ancestor of the operator home (its parent, and /)", () => {
    for (const dir of [dirname(sim), "/"]) {
      expect(() => assertReportPaths({ env: { HOME: sim }, reportDir: dir }), dir).toThrow(
        `the report dir resolves to "${dir}", which is or contains the operator home "${sim}"`,
      );
    }
  });

  test.skipIf(!accountHome())("refuses the account's home, and its parent, as the report dir whatever HOME says", () => {
    const account = accountHome() as string;
    expect(() => assertReportPaths({ env: { HOME: sim }, reportDir: account })).toThrow(
      `the report dir resolves to "${account}", which is or contains the operator home "${account}"`,
    );
    expect(() => assertReportPaths({ env: { HOME: sim }, reportDir: dirname(account) })).toThrow(
      "which is or contains the operator home",
    );
  });

  test("still accepts a report dir below the operator home, beside it, or sharing its name as a string prefix", () => {
    const base = mktmp("tps-guard-base-");
    const home = join(base, "home");
    mkdirSync(home);
    // Below the home but outside its operator directories: where a repo checked
    // out under $HOME keeps its default test-reports/.
    for (const dir of [join(home, "work", "cli", "test-reports"), join(base, "reports"), `${home}-reports`, join(base, "hom")]) {
      expect(
        () => assertReportPaths({ env: { HOME: home }, reportDir: dir, paths: [join(dir, "cli.xml"), join(dir, "cli.log")] }),
        dir,
      ).not.toThrow();
    }
  });

  test("a suite name is a plain file-name token", () => {
    for (const ok of ["cli", "agent", "pi-tps-mail", "root-test", "attested", "a.b_c-1"]) {
      expect(() => assertSuiteName(ok), ok).not.toThrow();
    }
    for (const bad of ["../../../.tps/identity/key", "a/b", "a\\b", "..", ".", "a..b", "x y", "", "x;y", "é"]) {
      expect(() => assertSuiteName(bad), bad).toThrow(IsolationRefusal);
    }
  });
});

describe("test-home-guard: the preloads' root check", () => {
  test("a launcher-made root (its marker's token presented) is accepted", () => {
    const root = mktmp("tps-guard-root-");
    writeFileSync(join(root, ROOT_MARKER), "tok");
    expect(testRootRefusal({ rootReal: root, homeReal: root, token: "tok" })).toBeNull();
  });

  test("a root that is the HOME this process runs under, without the launcher's token, is refused", () => {
    const sim = mktmp("tps-guard-simhome-");
    expect(testRootRefusal({ rootReal: sim, homeReal: sim, token: undefined })).toContain("no launcher vouched");
  });

  test("a token that does not match the root's marker does not vouch", () => {
    const root = mktmp("tps-guard-root-");
    writeFileSync(join(root, ROOT_MARKER), "real-token");
    expect(testRootRefusal({ rootReal: root, homeReal: root, token: "forged" })).toContain("no launcher vouched");
  });

  test.skipIf(!accountHome())("a root that contains the account's home is refused, whatever HOME says", () => {
    const sim = mktmp("tps-guard-simhome-");
    expect(testRootRefusal({ rootReal: "/", homeReal: sim, token: "tok" })).toContain("account's home");
  });
});

// ---------------------------------------------------------------------------
// The preload, spawned
// ---------------------------------------------------------------------------

describe("home-isolation-preload: launch-time precondition", () => {
  function runPreload(env: Record<string, string | undefined>): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync("bun", [`--preload=${PRELOAD}`, "-e", "console.log('LOADED')"], {
      encoding: "utf-8",
      env: envWith(env),
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function launcherRoot(): { root: string; token: string } {
    const root = mktmp("tps-guard-root-");
    writeFileSync(join(root, ROOT_MARKER), "launcher-token");
    return { root, token: "launcher-token" };
  }

  test("aborts when TPS_TEST_ROOT is unset", () => {
    // CONTROL: without the precondition, a bare `bun test` under a real HOME
    // runs the suite against the real ~/.tps.
    const r = runPreload({ TPS_TEST_ROOT: undefined });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ISOLATION GUARD");
    expect(r.stdout).not.toContain("LOADED");
  });

  test("aborts when os.homedir() is outside TPS_TEST_ROOT", () => {
    const { root, token } = launcherRoot();
    const elsewhere = mktmp("tps-guard-elsewhere-");
    const r = runPreload({ TPS_TEST_ROOT: root, TPS_TEST_ROOT_TOKEN: token, HOME: elsewhere });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ISOLATION GUARD");
    expect(r.stderr).toContain("OUTSIDE");
    expect(r.stdout).not.toContain("LOADED");
  });

  test("aborts on a spoofed root: TPS_TEST_ROOT=$HOME with no launcher token", () => {
    const sim = mktmp("tps-guard-simhome-");
    const r = runPreload({ TPS_TEST_ROOT: sim, TPS_TEST_ROOT_TOKEN: undefined, HOME: sim });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no launcher vouched");
    expect(r.stdout).not.toContain("LOADED");
  });

  test("aborts on a spoofed root that CONTAINS HOME", () => {
    const sim = mktmp("tps-guard-simhome-");
    mkdirSync(join(sim, "inner"));
    const r = runPreload({ TPS_TEST_ROOT: sim, TPS_TEST_ROOT_TOKEN: undefined, HOME: join(sim, "inner") });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no launcher vouched");
    expect(r.stdout).not.toContain("LOADED");
  });

  test("aborts when the token does not match the root's marker", () => {
    const { root } = launcherRoot();
    const r = runPreload({ TPS_TEST_ROOT: root, TPS_TEST_ROOT_TOKEN: "forged", HOME: root });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no launcher vouched");
    expect(r.stdout).not.toContain("LOADED");
  });

  test.skipIf(!accountHome())("aborts on a root that contains the account's home, even with HOME elsewhere", () => {
    const sim = mktmp("tps-guard-simhome-");
    const r = runPreload({ TPS_TEST_ROOT: "/", TPS_TEST_ROOT_TOKEN: "any", HOME: sim });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("account's home");
    expect(r.stdout).not.toContain("LOADED");
  });

  test("passes for a launcher-made root with HOME inside it", () => {
    const { root, token } = launcherRoot();
    const r = runPreload({ TPS_TEST_ROOT: root, TPS_TEST_ROOT_TOKEN: token, HOME: root });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LOADED");
  });
});

// ---------------------------------------------------------------------------
// End to end: a bare `bun test` in every location that has a guarding bunfig
// ---------------------------------------------------------------------------

/**
 * A leaking test whose module records that it LOADED: an imported module and the
 * test file's own top-level body each write a marker before any test runs. The
 * preload must abort before either.
 */
function markerFixture(): { dir: string; file: string; importMarker: string; bodyMarker: string } {
  const dir = mktmp("tps-guard-fixture-");
  const markers = mktmp("tps-guard-markers-");
  const importMarker = join(markers, "imported");
  const bodyMarker = join(markers, "module-body");
  writeFileSync(
    join(dir, "top-marker.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${q(importMarker)}, "imported");\n`,
  );
  writeFileSync(
    join(dir, "leak.test.ts"),
    `import "./top-marker.ts";
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
writeFileSync(${q(bodyMarker)}, "module body ran");
test("leaks into ~/.tps", () => {
  mkdirSync(join(homedir(), ".tps"), { recursive: true });
  writeFileSync(join(homedir(), ".tps", "LEAKED"), "x");
  expect(1).toBe(1);
});
`,
  );
  return { dir, file: join(dir, "leak.test.ts"), importMarker, bodyMarker };
}

const BARE_RUN_LOCATIONS = [
  { name: "the repo root", cwd: REPO },
  { name: "packages/agent", cwd: join(REPO, "packages/agent") },
  { name: "packages/cli", cwd: join(REPO, "packages/cli") },
  { name: "packages/pi-tps-mail", cwd: join(REPO, "packages/pi-tps-mail") },
  { name: "plugins/openclaw-tps-mail", cwd: PLUGIN_DIR },
  { name: "plugins/openclaw-github-review", cwd: REVIEW_DIR },
];

describe("end to end: a bare `bun test` aborts before any test module body runs", () => {
  test(
    "CONTROL: with no guarding bunfig, the fixture's import and module-body markers fire",
    () => {
      const sim = mktmp("tps-guard-simhome-");
      const fx = markerFixture();
      const r = spawnSync("bun", ["test", fx.file], {
        cwd: fx.dir, // no bunfig.toml here: nothing stands in the way
        env: envWith({ HOME: sim, TPS_TEST_ROOT: undefined, TPS_TEST_ROOT_TOKEN: undefined }),
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(existsSync(fx.importMarker)).toBe(true);
      expect(existsSync(fx.bodyMarker)).toBe(true);
    },
    E2E_TIMEOUT,
  );

  for (const location of BARE_RUN_LOCATIONS) {
    const cases: Array<{ what: string; reason: string; env: (sim: string) => Record<string, string | undefined> }> = [
      { what: "TPS_TEST_ROOT unset", reason: "TPS_TEST_ROOT is not set", env: () => ({ TPS_TEST_ROOT: undefined }) },
      {
        what: "a spoofed TPS_TEST_ROOT=$HOME (and an existing TPS_MAIL_DIR under it)",
        reason: "no launcher vouched",
        env: (sim) => {
          // The mail dir exists, so the plugin's mail rule alone would let the run through.
          mkdirSync(join(sim, ".tps", "mail"), { recursive: true });
          return { TPS_TEST_ROOT: sim, TPS_MAIL_DIR: join(sim, ".tps", "mail") };
        },
      },
    ];
    for (const c of cases) {
      test(
        `from ${location.name}, ${c.what}`,
        () => {
          const sim = mktmp("tps-guard-simhome-");
          const fx = markerFixture();
          const r = spawnSync("bun", ["test", fx.file], {
            cwd: location.cwd,
            env: envWith({ TPS_TEST_ROOT_TOKEN: undefined, TPS_MAIL_DIR: undefined, ...c.env(sim), HOME: sim }),
            encoding: "utf8",
          });
          expect(existsSync(fx.importMarker)).toBe(false);
          expect(existsSync(fx.bodyMarker)).toBe(false);
          expect(existsSync(join(sim, ".tps", "LEAKED"))).toBe(false);
          expect(r.status).not.toBe(0);
          expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("ISOLATION GUARD");
          expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain(c.reason);
        },
        E2E_TIMEOUT,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// End to end: the launchers, against a simulated operator home
// ---------------------------------------------------------------------------

/** A test that records it ran, at a path baked into its source. */
function ranFixture(marker: string): string {
  const dir = mktmp("tps-guard-fixture-");
  writeFileSync(
    join(dir, "ran.test.ts"),
    `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("ran", () => { writeFileSync(${q(marker)}, "ran"); });\n`,
  );
  return join(dir, "ran.test.ts");
}

/**
 * How each launcher is invoked on one fixture file, and the suite name its
 * report carries. `fake` is the launcher's path inside a COPY of the repo
 * layout (the symlink case builds one), and `fakeCwd` the directory it runs
 * from there — null for the monorepo launcher, which runs beside the fixture.
 */
const LAUNCHERS = [
  {
    name: "scripts/test-suite.mjs",
    suite: "guard-probe",
    argv: (fixture: string) => [SUITE_LAUNCHER, "guard-probe", fixture],
    cwd: (fixture: string) => dirname(fixture),
    fake: "scripts/test-suite.mjs",
    fakeCwd: null as string | null,
  },
  {
    name: "the openclaw-tps-mail launcher",
    suite: "plugin",
    argv: (fixture: string) => [PLUGIN_LAUNCHER, fixture],
    cwd: (_fixture: string) => PLUGIN_DIR,
    fake: "plugins/openclaw-tps-mail/scripts/run-tests.mjs",
    fakeCwd: "plugins/openclaw-tps-mail",
  },
  {
    name: "the openclaw-github-review launcher",
    suite: "github-review",
    argv: (fixture: string) => [REVIEW_LAUNCHER, fixture],
    cwd: (_fixture: string) => REVIEW_DIR,
    fake: "plugins/openclaw-github-review/scripts/run-tests.mjs",
    fakeCwd: "plugins/openclaw-github-review",
  },
];

/** Run a launcher under `runtime` (bun by default — this process's own). */
function runLauncher(argv: string[], cwd: string, env: Record<string, string>, runtime: string = process.execPath) {
  const r = spawnSync(runtime, argv, { cwd, env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}

/** The JUnit report a launcher wrote shows `name` as a case that passed. */
function junitPassed(reportDir: string, suite: string, name: string): boolean {
  const path = join(reportDir, `${suite}.xml`);
  if (!existsSync(path)) return false;
  const xml = readFileSync(path, "utf8");
  const at = xml.indexOf(`name="${name}"`);
  if (at < 0) return false;
  const end = xml.indexOf("</testcase>", at);
  const selfClosed = xml.slice(at, xml.indexOf(">", at) + 1).endsWith("/>");
  const body = selfClosed ? "" : xml.slice(at, end < 0 ? undefined : end);
  return !body.includes("<failure") && !body.includes("<skipped");
}

const SENTINEL_ENV = (sentinel: string) => ({
  XDG_CONFIG_HOME: join(sentinel, "config"),
  XDG_DATA_HOME: join(sentinel, "data"),
  XDG_CACHE_HOME: join(sentinel, "cache"),
  XDG_STATE_HOME: join(sentinel, "state"),
  TPS_ROOT: join(sentinel, "tps"),
  TPS_HOME: sentinel,
  TPS_IDENTITY_DIR: join(sentinel, "identity"),
  TPS_MAIL_DIR: join(sentinel, "mail"),
  FLAIR_URL: "http://sentinel.invalid",
  FLAIR_KEY_PATH: join(sentinel, "flair.key"),
  BOB_HOME: join(sentinel, "bob"),
  OPENCLAW_HOME: join(sentinel, "openclaw"),
  CODEX_HOME: join(sentinel, "codex"),
  PI_CODING_AGENT_DIR: join(sentinel, "pi"),
  NONO_BIN: join(sentinel, "nono"),
  NODE_OPTIONS: `--require ${join(sentinel, "hook.js")}`,
  // A variable no list names: an allowlist drops it anyway.
  GUARD_UNNAMED_TOOL_DIR: join(sentinel, "unnamed"),
});

/**
 * Every name a test may see: the allowlist, the variables the launchers set,
 * and NODE_ENV (bun test sets it).
 */
const EXPECTED_NAMES = [
  ...Object.keys(PASSED_ENV),
  "HOME",
  "TPS_TEST_ROOT",
  "TPS_TEST_ROOT_TOKEN",
  "TMPDIR",
  "TMP",
  "TEMP",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "TPS_MAIL_DIR",
  "TPS_TEST_KEYS_DIR",
  "TPS_MAIL_REQUIRE_EXPLICIT_DIR",
  // The github-review lane's gateway-boundary test runs OpenClaw under node.
  "TPS_LANE_NODE",
  "NODE_ENV",
];

/** A test that checks the environment it (and a process it spawns) got. */
const ENV_FIXTURE = `import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
const EXPECTED = new Set(${JSON.stringify(EXPECTED_NAMES)});
test("only the allowlist and the launcher variables reach a test", () => {
  expect(Object.keys(process.env).filter((n) => !EXPECTED.has(n))).toEqual([]);
  const child = spawnSync("/usr/bin/env", [], { encoding: "utf8" }).stdout
    .split("\\n").filter(Boolean).map((l) => l.slice(0, l.indexOf("=")));
  expect(child.filter((n) => !EXPECTED.has(n))).toEqual([]);
  const root = realpathSync(process.env.TPS_TEST_ROOT);
  const within = (p) => p === root || p.startsWith(root + "/");
  for (const p of [homedir(), tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP, process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH]) {
    expect(within(p)).toBe(true);
  }
});
`;

describe("end to end: the launchers give a test only the allowlisted environment", () => {
  test(
    "an inherited XDG_CONFIG_HOME is not written by the Google refresh path (auth.test.ts)",
    () => {
      const sim = mktmp("tps-guard-simhome-");
      const sentinel = mktmp("tps-guard-xdg-");
      const reports = mktmp("tps-guard-reports-");
      const cred = join(sentinel, "gemini", "oauth_creds.json");
      mkdirSync(dirname(cred), { recursive: true });
      const seed = JSON.stringify({ access_token: "SENTINEL", refresh_token: "SENTINEL-R", expiry_date: 1 });
      writeFileSync(cred, seed);
      const { status, out } = runLauncher(
        [SUITE_LAUNCHER, "guard-xdg-probe", "./test/auth.test.ts", "-t", "refresh google"],
        join(REPO, "packages/cli"),
        envWith({ HOME: sim, XDG_CONFIG_HOME: sentinel, TPS_TEST_REPORT_DIR: reports }),
      );
      // The refresh path ran (auth.test.ts's Google refresh case passed)...
      expect(junitPassed(reports, "guard-xdg-probe", "refresh google updates access token")).toBe(true);
      expect(status).toBe(0);
      // ...and the credential file under the inherited XDG_CONFIG_HOME is untouched.
      expect(readFileSync(cred, "utf8")).toBe(seed);
      expect(out).toContain("XDG_CONFIG_HOME");
    },
    E2E_TIMEOUT,
  );

  for (const launcher of LAUNCHERS) {
    test(
      `${launcher.name}: only the allowlist and the launcher variables reach a test`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const sentinel = mktmp("tps-guard-sentinel-");
        const reports = mktmp("tps-guard-reports-");
        const fx = mktmp("tps-guard-fixture-");
        writeFileSync(join(fx, "env.test.ts"), ENV_FIXTURE);
        // The launcher runs under bun here, with the caller's environment, and bun
        // may cache its own transpiled sources under XDG_CACHE_HOME/bun before the
        // launcher runs a line. That write is the launcher's runtime, not a test's,
        // so it is switched off for the LAUNCHER only (the child gets its own cache
        // setting from the launcher): anything left in the sentinel came from a test.
        // The case after this one runs the launcher under node with the normal
        // cache setting.
        const { status, out } = runLauncher(
          launcher.argv(join(fx, "env.test.ts")),
          launcher.cwd(join(fx, "env.test.ts")),
          envWith({
            HOME: sim,
            TPS_TEST_REPORT_DIR: reports,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            ...SENTINEL_ENV(sentinel),
          }),
        );
        expect(junitPassed(reports, launcher.suite, "only the allowlist and the launcher variables reach a test")).toBe(
          true,
        );
        expect(status).toBe(0);
        expect(readdirSync(sentinel)).toEqual([]);
        // The dropped names are reported, never their values.
        expect(out).toContain("GUARD_UNNAMED_TOOL_DIR");
        expect(out).not.toContain(join(sentinel, "unnamed"));
      },
      E2E_TIMEOUT,
    );

    test.skipIf(!NODE)(
      `${launcher.name}: under node with the normal cache setting, the child's bun cache lands inside the root, not the caller's XDG_CACHE_HOME`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const sentinel = mktmp("tps-guard-sentinel-");
        const reports = mktmp("tps-guard-reports-");
        const fx = mktmp("tps-guard-fixture-");
        // A module over bun's 50 KB transpiler-cache threshold, so the child caches it.
        const big = Array.from({ length: 3000 }, (_, i) => `export const x${i}: number = ${i};`).join("\n");
        writeFileSync(join(fx, "big.ts"), `${big}\n`);
        writeFileSync(
          join(fx, "big.test.ts"),
          `import { test, expect } from "bun:test";\nimport { x1 } from "./big.ts";\ntest("big", () => { expect(x1).toBe(1); });\n`,
        );
        mkdirSync(join(sentinel, "cache"));
        const { status, stdout } = runLauncher(
          launcher.argv(join(fx, "big.test.ts")),
          launcher.cwd(join(fx, "big.test.ts")),
          envWith({
            HOME: sim,
            TPS_TEST_REPORT_DIR: reports,
            XDG_CACHE_HOME: join(sentinel, "cache"),
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: undefined,
            TPS_TEST_KEEP_ROOT: "1",
          }),
          NODE as string,
        );
        const kept = /kept isolated root (\S+)/.exec(stdout)?.[1];
        expect(kept).toBeDefined();
        dirs.push(kept as string);
        expect(junitPassed(reports, launcher.suite, "big")).toBe(true);
        expect(status).toBe(0);
        expect(readdirSync(join(sentinel, "cache"))).toEqual([]);
        // The launcher's cache setting: bun writes its cache files straight into it.
        expect(readdirSync(join(kept as string, ".cache", "bun")).some((f) => f.endsWith(".pile"))).toBe(true);
      },
      E2E_TIMEOUT,
    );
  }
});

/**
 * A launcher run as its real lane: the monorepo launcher under suite `cli`, each
 * plugin launcher under its own fixed suite name. The report, log and seal it
 * deletes and writes are `<suite>.xml`, `<suite>.log` and `<suite>.xml.sha256`.
 */
function asLane(launcher: (typeof LAUNCHERS)[number], fixture: string): { suite: string; argv: string[] } {
  return launcher.suite === "guard-probe"
    ? { suite: "cli", argv: [SUITE_LAUNCHER, "cli", fixture] }
    : { suite: launcher.suite, argv: launcher.argv(fixture) };
}

/** Operator files at the names a lane's launcher deletes and writes in `dir`; returns each path with its bytes. */
function seedReportNames(dir: string, suite: string): Map<string, Buffer> {
  const seeded = new Map<string, Buffer>();
  for (const name of [`${suite}.xml`, `${suite}.log`, `${suite}.xml.sha256`]) {
    const bytes = Buffer.from(`operator file ${name}\n`);
    writeFileSync(join(dir, name), bytes);
    seeded.set(join(dir, name), bytes);
  }
  return seeded;
}

describe("end to end: the launchers refuse an operator-critical destination before creating anything", () => {
  for (const launcher of LAUNCHERS) {
    test(
      `${launcher.name}: a TPS_TEST_REPORT_DIR that IS the operator home is refused; the report, log and seal names already there are byte-identical afterwards`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const tmp = mktmp("tps-guard-tmp-");
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fixture = ranFixture(marker);
        const { suite, argv } = asLane(launcher, fixture);
        const seeded = seedReportNames(sim, suite);
        const { status, out } = runLauncher(
          argv,
          launcher.cwd(fixture),
          envWith({ HOME: sim, TMPDIR: tmp, TPS_TEST_REPORT_DIR: sim }),
        );
        // The operator's files first: each still there, byte for byte.
        for (const [path, bytes] of seeded) {
          expect(existsSync(path), path).toBe(true);
          expect(readFileSync(path).toString("hex"), path).toBe(bytes.toString("hex"));
        }
        expect(readdirSync(sim).sort()).toEqual([...seeded.keys()].map((p) => basename(p)).sort()); // nothing added
        expect(existsSync(marker)).toBe(false); // no test ran
        expect(readdirSync(tmp)).toEqual([]); // no throwaway root was made
        expect(status).not.toBe(0);
        expect(out).toContain(`the report dir resolves to "${sim}", which is or contains the operator home "${sim}"`);
      },
      E2E_TIMEOUT,
    );

    test(
      `${launcher.name}: a TPS_TEST_REPORT_DIR above the operator home is refused; the report, log and seal names already there are byte-identical afterwards`,
      () => {
        const base = mktmp("tps-guard-base-");
        const sim = join(base, "home");
        mkdirSync(sim);
        const tmp = mktmp("tps-guard-tmp-");
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fixture = ranFixture(marker);
        const { suite, argv } = asLane(launcher, fixture);
        const seeded = seedReportNames(base, suite);
        const { status, out } = runLauncher(
          argv,
          launcher.cwd(fixture),
          envWith({ HOME: sim, TMPDIR: tmp, TPS_TEST_REPORT_DIR: base }),
        );
        // The operator's files first: each still there, byte for byte.
        for (const [path, bytes] of seeded) {
          expect(existsSync(path), path).toBe(true);
          expect(readFileSync(path).toString("hex"), path).toBe(bytes.toString("hex"));
        }
        expect(readdirSync(base).sort()).toEqual(["home", ...[...seeded.keys()].map((p) => basename(p))].sort());
        expect(readdirSync(sim)).toEqual([]);
        expect(existsSync(marker)).toBe(false); // no test ran
        expect(readdirSync(tmp)).toEqual([]); // no throwaway root was made
        expect(status).not.toBe(0);
        expect(out).toContain(`the report dir resolves to "${base}", which is or contains the operator home "${sim}"`);
      },
      E2E_TIMEOUT,
    );

    test(
      `${launcher.name}: a TPS_TEST_REPORT_DIR below the operator home, outside its operator directories, still works`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const reports = join(sim, "work", "cli", "test-reports");
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fixture = ranFixture(marker);
        const { suite, argv } = asLane(launcher, fixture);
        const { status } = runLauncher(argv, launcher.cwd(fixture), envWith({ HOME: sim, TPS_TEST_REPORT_DIR: reports }));
        expect(existsSync(marker)).toBe(true);
        expect(junitPassed(reports, suite, "ran")).toBe(true);
        expect(readdirSync(reports).sort()).toEqual([`${suite}.log`, `${suite}.xml`, `${suite}.xml.sha256`]);
        expect(status).toBe(0);
      },
      E2E_TIMEOUT,
    );

    test(
      `${launcher.name}: a TMPDIR inside ~/.tps is refused`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const trap = join(sim, ".tps", "tmp");
        mkdirSync(trap, { recursive: true }); // exists, so only the refusal keeps it empty
        const reports = mktmp("tps-guard-reports-");
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fixture = ranFixture(marker);
        const { status, out } = runLauncher(
          launcher.argv(fixture),
          launcher.cwd(fixture),
          envWith({ HOME: sim, TMPDIR: trap, TPS_TEST_REPORT_DIR: reports }),
        );
        expect(existsSync(marker)).toBe(false); // no test ran
        expect(readdirSync(trap)).toEqual([]); // no throwaway root was created there
        expect(readdirSync(reports)).toEqual([]); // nothing was written or deleted
        expect(status).not.toBe(0);
        expect(out).toContain("refusing to run");
      },
      E2E_TIMEOUT,
    );

    test(
      `${launcher.name}: a TMPDIR that IS the operator home is refused`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        writeFileSync(join(sim, "operator-file"), "x");
        const reports = mktmp("tps-guard-reports-");
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fixture = ranFixture(marker);
        const { status, out } = runLauncher(
          launcher.argv(fixture),
          launcher.cwd(fixture),
          envWith({ HOME: sim, TMPDIR: sim, TPS_TEST_REPORT_DIR: reports }),
        );
        expect(existsSync(marker)).toBe(false);
        expect(readdirSync(sim)).toEqual(["operator-file"]); // no root was made in the home
        expect(status).not.toBe(0);
        expect(out).toContain("the temp dir (TMPDIR) resolves");
      },
      E2E_TIMEOUT,
    );

    test(
      `${launcher.name}: a TPS_TEST_REPORT_DIR inside ~/.flair is refused`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const reports = join(sim, ".flair", "reports");
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fixture = ranFixture(marker);
        const { status, out } = runLauncher(
          launcher.argv(fixture),
          launcher.cwd(fixture),
          envWith({ HOME: sim, TPS_TEST_REPORT_DIR: reports }),
        );
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(join(sim, ".flair"))).toBe(false);
        expect(status).not.toBe(0);
        expect(out).toContain("refusing to run");
      },
      E2E_TIMEOUT,
    );

    test(
      `${launcher.name}: the DEFAULT test-reports/, symlinked into ~/.tps, is refused before its report is deleted`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const target = join(sim, ".tps", "reports");
        mkdirSync(target, { recursive: true });
        const live = join(target, `${launcher.suite}.xml`);
        writeFileSync(live, "operator file");
        // A copy of the repo's launcher layout whose test-reports/ is the link.
        const fake = mktmp("tps-guard-fakerepo-");
        mkdirSync(join(fake, "scripts"));
        for (const f of ["test-suite.mjs", "test-home-guard.mjs", "home-isolation-preload.ts"]) {
          copyFileSync(join(REPO, "scripts", f), join(fake, "scripts", f));
        }
        // Every launcher, so the case runs each lane from the copied layout.
        for (const [rel, source] of [
          ["plugins/openclaw-tps-mail/scripts/run-tests.mjs", PLUGIN_LAUNCHER],
          ["plugins/openclaw-github-review/scripts/run-tests.mjs", REVIEW_LAUNCHER],
        ] as const) {
          mkdirSync(join(fake, dirname(rel)), { recursive: true });
          copyFileSync(source, join(fake, rel));
        }
        symlinkSync(target, join(fake, "test-reports"));
        const fakeLauncher = join(fake, launcher.fake);
        const argv = launcher.fakeCwd ? [fakeLauncher] : [fakeLauncher, launcher.suite];
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fixture = ranFixture(marker);
        const { status, out } = runLauncher(
          [...argv, fixture],
          launcher.fakeCwd ? join(fake, launcher.fakeCwd) : dirname(fixture),
          envWith({ HOME: sim, TPS_TEST_REPORT_DIR: undefined }),
        );
        expect(existsSync(marker)).toBe(false);
        expect(readFileSync(live, "utf8")).toBe("operator file"); // not deleted, not rewritten
        expect(readdirSync(target)).toEqual([`${launcher.suite}.xml`]);
        expect(status).not.toBe(0);
        expect(out).toContain("the report dir resolves");
      },
      E2E_TIMEOUT,
    );

    test(
      `${launcher.name}: a report path that is a symlink into ~/.tps is refused before anything is deleted or written`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        mkdirSync(join(sim, ".tps", "identity"), { recursive: true });
        const victim = join(sim, ".tps", "identity", "victim.log");
        const reports = mktmp("tps-guard-reports-");
        const link = join(reports, `${launcher.suite}.log`);
        symlinkSync(victim, link); // dangling: a write through it would create the victim
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fixture = ranFixture(marker);
        const { status, out } = runLauncher(
          launcher.argv(fixture),
          launcher.cwd(fixture),
          envWith({ HOME: sim, TPS_TEST_REPORT_DIR: reports }),
        );
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(victim)).toBe(false);
        expect(lstatSync(link).isSymbolicLink()).toBe(true); // not deleted either
        expect(status).not.toBe(0);
        expect(out).toContain("is a symlink");
      },
      E2E_TIMEOUT,
    );

    test(
      `${launcher.name}: a seal path a test turned into a symlink is not written through at the end`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        mkdirSync(join(sim, ".tps"), { recursive: true });
        const victim = join(sim, ".tps", "seal-target");
        const reports = mktmp("tps-guard-reports-");
        const seal = join(reports, `${launcher.suite}.xml.sha256`);
        const fx = mktmp("tps-guard-fixture-");
        writeFileSync(
          join(fx, "plant.test.ts"),
          `import { test } from "bun:test";\nimport { symlinkSync } from "node:fs";\ntest("plants a link at the seal path", () => { symlinkSync(${q(victim)}, ${q(seal)}); });\n`,
        );
        const { status, out } = runLauncher(
          launcher.argv(join(fx, "plant.test.ts")),
          launcher.cwd(join(fx, "plant.test.ts")),
          envWith({ HOME: sim, TPS_TEST_REPORT_DIR: reports }),
        );
        expect(lstatSync(seal).isSymbolicLink()).toBe(true); // the test did plant it
        expect(existsSync(victim)).toBe(false); // and nothing was written through it
        expect(status).not.toBe(0);
        expect(out).toContain("not sealing the report");
      },
      E2E_TIMEOUT,
    );
  }

  test(
    "scripts/test-suite.mjs: a suite name that climbs out of the report dir is refused before any filesystem call",
    () => {
      const sim = mktmp("tps-guard-simhome-");
      const base = mktmp("tps-guard-base-");
      const reports = join(base, "reports");
      mkdirSync(reports);
      const victims = ["victim.xml", "victim.log", "victim.xml.sha256"].map((f) => join(base, f));
      for (const v of victims) writeFileSync(v, "operator file");
      const marker = join(mktmp("tps-guard-marker-"), "ran");
      const fixture = ranFixture(marker);
      const { status, out } = runLauncher(
        [SUITE_LAUNCHER, "../victim", fixture],
        dirname(fixture),
        envWith({ HOME: sim, TPS_TEST_REPORT_DIR: reports }),
      );
      expect(existsSync(marker)).toBe(false);
      for (const v of victims) expect(readFileSync(v, "utf8")).toBe("operator file");
      expect(readdirSync(reports)).toEqual([]);
      expect(status).not.toBe(0);
      expect(out).toContain("refusing the suite name");
    },
    E2E_TIMEOUT,
  );
});

describe("end to end: the ~/.tps diagnostic fails the lane", () => {
  for (const launcher of LAUNCHERS) {
    test(
      `${launcher.name}: a passing test that writes the launcher's ~/.tps by an absolute path fails the lane`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        mkdirSync(join(sim, ".tps"), { recursive: true });
        const reports = mktmp("tps-guard-reports-");
        const fx = mktmp("tps-guard-fixture-");
        // A simulated leak that ignores HOME: the path is baked into the test.
        writeFileSync(
          join(fx, "abs.test.ts"),
          `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("writes by absolute path", () => { writeFileSync(${q(join(sim, ".tps", "LEAKED"))}, "x"); });\n`,
        );
        const { status, out } = runLauncher(
          launcher.argv(join(fx, "abs.test.ts")),
          launcher.cwd(join(fx, "abs.test.ts")),
          envWith({ HOME: sim, TPS_TEST_REPORT_DIR: reports }),
        );
        // The test itself passed...
        expect(junitPassed(reports, launcher.suite, "writes by absolute path")).toBe(true);
        // ...and the lane failed on the recorded difference.
        expect(status).not.toBe(0);
        expect(out).toContain("HOME-ISOLATION GUARD: the run changed");
        expect(out).toContain("LEAKED");
      },
      E2E_TIMEOUT,
    );
  }
});

// ---------------------------------------------------------------------------
// End to end: the launchers refuse a caller-supplied --reporter-outfile
// ---------------------------------------------------------------------------

describe("end to end: the launchers refuse a caller-supplied --reporter-outfile", () => {
  // Each case gives the launcher a dedicated, empty TMPDIR. The launcher makes its
  // throwaway root under its temp dir (os.tmpdir(), which reads TMPDIR), so that
  // directory still being empty afterwards shows no root was created: a listing of
  // the file system, not the launcher's console output.
  for (const launcher of LAUNCHERS) {
    test(
      `${launcher.name}: --reporter-outfile=<sim home> is refused (equals form)`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const tmp = mktmp("tps-guard-tmp-");
        const reports = mktmp("tps-guard-reports-");
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fixture = ranFixture(marker);
        const reportPath = join(sim, ".tps", "x.xml");
        const { status, out } = runLauncher(
          [...launcher.argv(fixture), `--reporter-outfile=${reportPath}`],
          launcher.cwd(fixture),
          envWith({ HOME: sim, TMPDIR: tmp, TPS_TEST_REPORT_DIR: reports }),
        );
        expect(existsSync(marker)).toBe(false); // no test ran
        // Refused before the launcher created its throwaway root or any report file.
        expect(readdirSync(tmp)).toEqual([]);
        expect(readdirSync(reports)).toEqual([]);
        expect(existsSync(join(sim, ".tps"))).toBe(false);
        expect(status).not.toBe(0);
        expect(out).toContain("--reporter-outfile");
        expect(out).toContain("the launcher owns");
        expect(out).not.toContain("isolated root");
      },
      E2E_TIMEOUT,
    );

    test(
      `${launcher.name}: --reporter-outfile <sim home> is refused (space form)`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const tmp = mktmp("tps-guard-tmp-");
        const reports = mktmp("tps-guard-reports-");
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fixture = ranFixture(marker);
        const reportPath = join(sim, "agents", "x.xml");
        const { status, out } = runLauncher(
          [...launcher.argv(fixture), "--reporter-outfile", reportPath],
          launcher.cwd(fixture),
          envWith({ HOME: sim, TMPDIR: tmp, TPS_TEST_REPORT_DIR: reports }),
        );
        expect(existsSync(marker)).toBe(false); // no test ran
        // Refused before the launcher created its throwaway root or any report file.
        expect(readdirSync(tmp)).toEqual([]);
        expect(readdirSync(reports)).toEqual([]);
        expect(existsSync(join(sim, "agents"))).toBe(false);
        expect(status).not.toBe(0);
        expect(out).toContain("--reporter-outfile");
        expect(out).toContain("the launcher owns");
        expect(out).not.toContain("isolated root");
      },
      E2E_TIMEOUT,
    );

    test(
      `${launcher.name}: --reporter-outfile to an outside path is still refused`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const tmp = mktmp("tps-guard-tmp-");
        const reports = mktmp("tps-guard-reports-");
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fixture = ranFixture(marker);
        const { status, out } = runLauncher(
          [...launcher.argv(fixture), "--reporter-outfile=/some/path.xml"],
          launcher.cwd(fixture),
          envWith({ HOME: sim, TMPDIR: tmp, TPS_TEST_REPORT_DIR: reports }),
        );
        expect(existsSync(marker)).toBe(false); // no test ran
        // Refused before the launcher created its throwaway root or any report file.
        expect(readdirSync(tmp)).toEqual([]);
        expect(readdirSync(reports)).toEqual([]);
        expect(status).not.toBe(0);
        expect(out).toContain("--reporter-outfile");
        expect(out).toContain("the launcher owns");
        expect(out).not.toContain("isolated root");
      },
      E2E_TIMEOUT,
    );
  }
});

// ---------------------------------------------------------------------------
// runSuite, called directly: a refused --reporter-outfile is a catchable refusal
// ---------------------------------------------------------------------------

const OUTFILE_REFUSAL =
  "refusing --reporter-outfile: the launcher owns the report destination (set TPS_TEST_REPORT_DIR instead)";

describe("scripts/test-suite.mjs: a refused --reporter-outfile is an IsolationRefusal, not an exit", () => {
  const runtimes: Array<[string, string | null]> = [
    ["bun", process.execPath],
    ["node", NODE],
  ];
  for (const [runtime, exe] of runtimes) {
    test.skipIf(!exe)(
      `under ${runtime}, a direct caller of runSuite catches the refusal (both forms) and keeps running; nothing is created`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const tmp = mktmp("tps-guard-tmp-");
        const reports = mktmp("tps-guard-reports-");
        const fx = mktmp("tps-guard-fixture-");
        const target = join(sim, ".tps", "x.xml");
        // A caller in its own process: it imports runSuite and the refusal class
        // by absolute path and prints what each call did, then that it went on.
        writeFileSync(
          join(fx, "caller.mjs"),
          `import { runSuite } from ${q(SUITE_LAUNCHER)};
import { IsolationRefusal } from ${q(GUARD_MODULE)};
for (const args of [[${q(`--reporter-outfile=${target}`)}], ["--reporter-outfile", ${q(target)}]]) {
  try {
    runSuite({ suite: "cli", args, cwd: ${q(fx)}, env: { HOME: ${q(sim)} }, reportDir: ${q(reports)}, tempBase: ${q(tmp)} });
    console.log("RETURNED");
  } catch (err) {
    console.log(err instanceof IsolationRefusal ? "CAUGHT IsolationRefusal: " + err.message : "CAUGHT other: " + err);
  }
}
console.log("CONTINUED");
`,
        );
        const r = spawnSync(exe as string, [join(fx, "caller.mjs")], {
          cwd: fx,
          env: envWith({ HOME: sim }),
          encoding: "utf8",
        });
        expect(r.stdout).toBe(`CAUGHT IsolationRefusal: ${OUTFILE_REFUSAL}\nCAUGHT IsolationRefusal: ${OUTFILE_REFUSAL}\nCONTINUED\n`);
        expect(r.status).toBe(0);
        expect(readdirSync(tmp)).toEqual([]); // no throwaway root
        expect(readdirSync(reports)).toEqual([]); // no report, log or seal
        expect(existsSync(join(sim, ".tps"))).toBe(false);
      },
      E2E_TIMEOUT,
    );
  }

  test(
    "the CLI still exits 1 with the one-line refusal on stderr (both forms), and nothing is created",
    () => {
      const sim = mktmp("tps-guard-simhome-");
      const tmp = mktmp("tps-guard-tmp-");
      const reports = mktmp("tps-guard-reports-");
      const marker = join(mktmp("tps-guard-marker-"), "ran");
      const fixture = ranFixture(marker);
      const target = join(sim, ".tps", "x.xml");
      for (const form of [[`--reporter-outfile=${target}`], ["--reporter-outfile", target]]) {
        const r = spawnSync(process.execPath, [SUITE_LAUNCHER, "cli", fixture, ...form], {
          cwd: dirname(fixture),
          env: envWith({ HOME: sim, TMPDIR: tmp, TPS_TEST_REPORT_DIR: reports }),
          encoding: "utf8",
        });
        expect(r.stderr, form.join(" ")).toBe(`cli: ${OUTFILE_REFUSAL}\n`);
        expect(r.stdout, form.join(" ")).toBe("");
        expect(r.status, form.join(" ")).toBe(1);
      }
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
      expect(readdirSync(reports)).toEqual([]);
      expect(existsSync(join(sim, ".tps"))).toBe(false);
    },
    E2E_TIMEOUT,
  );
});
