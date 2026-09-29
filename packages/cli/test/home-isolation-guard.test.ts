/**
 * home-isolation-guard.test.ts — cli#430.
 *
 * Coverage for the suite-level HOME isolation:
 *   - scripts/test-home-guard.mjs — the environment sanitizer, the temp/report
 *     destination check, and the `~/.tps` metadata snapshot (a diagnostic);
 *   - scripts/home-isolation-preload.ts — the launch-time precondition that
 *     aborts a run whose os.homedir() is outside the isolated test root;
 *   - the two launchers (scripts/test-suite.mjs and
 *     plugins/openclaw-tps-mail/scripts/run-tests.mjs) and the repo-root
 *     bunfig.toml, end to end.
 *
 * Every end-to-end case runs against a SIMULATED operator home (a temp dir
 * passed as HOME), never the real one: a leak these cases provoke lands in a
 * throwaway directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
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
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  IsolationRefusal,
  assertTestDestinations,
  diffSnapshots,
  sanitizedTestEnv,
  snapshotTps,
} from "../../../scripts/test-home-guard.mjs";

const REPO = resolve(import.meta.dir, "../../..");
const PRELOAD = join(REPO, "scripts/home-isolation-preload.ts");
const SUITE_LAUNCHER = join(REPO, "scripts/test-suite.mjs");
const PLUGIN_DIR = join(REPO, "plugins/openclaw-tps-mail");
const PLUGIN_LAUNCHER = join(PLUGIN_DIR, "scripts/run-tests.mjs");

/** The end-to-end cases spawn a launcher that spawns bun; allow for a slow runner. */
const E2E_TIMEOUT = 60_000;

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

describe("test-home-guard: sanitizedTestEnv", () => {
  test("drops every home-routing override and keeps everything else", () => {
    const { env, dropped } = sanitizedTestEnv({
      PATH: "/usr/bin",
      LANG: "C",
      NONO_BIN: "/usr/local/bin/nono",
      XDG_CONFIG_HOME: "/sentinel/config",
      XDG_DATA_HOME: "/sentinel/data",
      XDG_CACHE_HOME: "/sentinel/cache",
      XDG_STATE_HOME: "/sentinel/state",
      TPS_ROOT: "/sentinel/tps",
      TPS_HOME: "/sentinel",
      TPS_MAIL_DIR: "/sentinel/mail",
      TPS_IDENTITY_DIR: "/sentinel/identity",
      TPS_TEST_REPORT_DIR: "/sentinel/reports",
      TPS_AGENT_ID: "sentinel",
      FLAIR_URL: "http://sentinel.invalid",
      FLAIR_KEY_PATH: "/sentinel/flair.key",
      BOB_HOME: "/sentinel/bob",
      OPENCLAW_HOME: "/sentinel/openclaw",
      CODEX_HOME: "/sentinel/codex",
      CLAUDE_CONFIG_DIR: "/sentinel/claude",
      PI_CODING_AGENT_DIR: "/sentinel/pi",
      GIT_CONFIG_GLOBAL: "/sentinel/gitconfig",
      USERPROFILE: "/sentinel",
      TPS_TEST_MODE: "docker",
      TPS_TEST_NODE: "/usr/bin/node",
    });
    expect(Object.keys(env).sort()).toEqual(["LANG", "NONO_BIN", "PATH", "TPS_TEST_MODE", "TPS_TEST_NODE"]);
    for (const name of ["XDG_CONFIG_HOME", "TPS_ROOT", "FLAIR_URL", "BOB_HOME", "OPENCLAW_HOME", "CODEX_HOME"]) {
      expect(dropped).toContain(name);
    }
    // Names only: the values never appear in what the launcher reports.
    expect(dropped.join(" ")).not.toContain("sentinel");
  });
});

describe("test-home-guard: assertTestDestinations", () => {
  let sim: string;
  beforeEach(() => {
    sim = mktmp("tps-guard-simhome-");
  });

  for (const dir of [".tps", ".flair", "agents", ".config"]) {
    test(`refuses a TMPDIR inside ~/${dir}`, () => {
      expect(() => assertTestDestinations({ env: { HOME: sim, TMPDIR: join(sim, dir, "tmp") } })).toThrow(
        IsolationRefusal,
      );
    });
  }

  test("refuses a report dir inside ~/.flair", () => {
    expect(() => assertTestDestinations({ env: { HOME: sim }, reportDir: join(sim, ".flair", "reports") })).toThrow(
      /TPS_TEST_REPORT_DIR resolves to .*inside the operator directory/,
    );
  });

  test("refuses a path that reaches ~/.tps through a symlink", () => {
    mkdirSync(join(sim, ".tps"), { recursive: true });
    const outside = mktmp("tps-guard-link-");
    symlinkSync(join(sim, ".tps"), join(outside, "via"));
    expect(() => assertTestDestinations({ env: { HOME: sim, TMPDIR: join(outside, "via", "tmp") } })).toThrow(
      IsolationRefusal,
    );
  });

  test("accepts a temp dir and report dir outside the operator directories", () => {
    const outside = mktmp("tps-guard-outside-");
    expect(() =>
      assertTestDestinations({ env: { HOME: sim, TMPDIR: outside }, reportDir: join(outside, "reports") }),
    ).not.toThrow();
  });
});

describe("home-isolation-preload: launch-time precondition", () => {
  function runPreload(env: Record<string, string | undefined>): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync("bun", [`--preload=${PRELOAD}`, "-e", "console.log('LOADED')"], {
      encoding: "utf-8",
      env: envWith(env),
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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
    const root = mktmp("tps-guard-root-");
    const elsewhere = mktmp("tps-guard-elsewhere-");
    const r = runPreload({ TPS_TEST_ROOT: root, HOME: elsewhere });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ISOLATION GUARD");
    expect(r.stderr).toContain("OUTSIDE");
    expect(r.stdout).not.toContain("LOADED");
  });

  test("passes when os.homedir() is inside TPS_TEST_ROOT", () => {
    const root = mktmp("tps-guard-root-");
    const r = runPreload({ TPS_TEST_ROOT: root, HOME: root });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LOADED");
  });
});

// ---------------------------------------------------------------------------
// End to end, against a simulated operator home
// ---------------------------------------------------------------------------

/** A test that writes into ~/.tps of whatever HOME it runs under. */
const LEAKING_FIXTURE = `import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
test("leaks into ~/.tps", () => {
  mkdirSync(join(homedir(), ".tps"), { recursive: true });
  writeFileSync(join(homedir(), ".tps", "LEAKED"), "x");
  expect(1).toBe(1);
});
`;

/** A test that asserts none of the inherited home-routing variables reached it. */
const ENV_FIXTURE = `import { test, expect } from "bun:test";
test("inherited home-routing variables are absent", () => {
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TPS_ROOT", "TPS_HOME",
    "TPS_IDENTITY_DIR", "FLAIR_URL", "FLAIR_KEY_PATH", "BOB_HOME", "OPENCLAW_HOME", "CODEX_HOME", "PI_CODING_AGENT_DIR"]) {
    expect(process.env[name]).toBeUndefined();
  }
});
`;

/** A test that records it ran, at the path in GUARD_PROBE_MARKER. */
const RAN_FIXTURE = `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("ran", () => { writeFileSync(process.env.GUARD_PROBE_MARKER as string, "ran"); });
`;

const SENTINEL_ENV = (sentinel: string) => ({
  XDG_CONFIG_HOME: join(sentinel, "config"),
  XDG_DATA_HOME: join(sentinel, "data"),
  XDG_CACHE_HOME: join(sentinel, "cache"),
  XDG_STATE_HOME: join(sentinel, "state"),
  TPS_ROOT: join(sentinel, "tps"),
  TPS_HOME: sentinel,
  TPS_IDENTITY_DIR: join(sentinel, "identity"),
  FLAIR_URL: "http://sentinel.invalid",
  FLAIR_KEY_PATH: join(sentinel, "flair.key"),
  BOB_HOME: join(sentinel, "bob"),
  OPENCLAW_HOME: join(sentinel, "openclaw"),
  CODEX_HOME: join(sentinel, "codex"),
  PI_CODING_AGENT_DIR: join(sentinel, "pi"),
});

/** How each launcher is invoked on one fixture file. */
const LAUNCHERS = [
  {
    name: "scripts/test-suite.mjs",
    argv: (fixture: string) => [SUITE_LAUNCHER, "guard-probe", fixture],
    cwd: (fixtureDir: string) => fixtureDir,
  },
  {
    name: "the openclaw-tps-mail launcher",
    argv: (fixture: string) => [PLUGIN_LAUNCHER, fixture],
    cwd: (_fixtureDir: string) => PLUGIN_DIR,
  },
];

// bun test prints only failures and the summary when its environment says an AI
// agent is running it (measured on bun 1.3.10: CLAUDECODE, AGENT or REPL_ID alone;
// AI_AGENT alongside other agent variables). The cases below read a passing test's
// name from the output, so they clear those variables and give the same result
// whoever runs the suite.
const AGENT_DETECTION_VARS = ["CLAUDECODE", "AGENT", "REPL_ID", "AI_AGENT"];

function runLauncher(argv: string[], cwd: string, env: Record<string, string>) {
  const launchEnv = { ...env };
  for (const name of AGENT_DETECTION_VARS) delete launchEnv[name];
  const r = spawnSync(process.execPath, argv, { cwd, env: launchEnv, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("end to end: the repo-root bunfig guards a bare `bun test`", () => {
  test(
    "a bare `bun test` from the repo root aborts before a leaking test runs",
    () => {
      const sim = mktmp("tps-guard-simhome-");
      const fx = mktmp("tps-guard-fixture-");
      writeFileSync(join(fx, "leak.test.ts"), LEAKING_FIXTURE);
      const r = spawnSync("bun", ["test", join(fx, "leak.test.ts")], {
        cwd: REPO,
        env: envWith({ HOME: sim, TPS_TEST_ROOT: undefined }),
        encoding: "utf8",
      });
      expect(existsSync(join(sim, ".tps"))).toBe(false);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("HOME-ISOLATION GUARD");
    },
    E2E_TIMEOUT,
  );
});

describe("end to end: the launchers sanitize the inherited environment", () => {
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
      expect(out).toContain("refresh google updates access token");
      expect(status).toBe(0);
      // ...and the credential file under the inherited XDG_CONFIG_HOME is untouched.
      expect(readFileSync(cred, "utf8")).toBe(seed);
      expect(out).toContain("XDG_CONFIG_HOME");
    },
    E2E_TIMEOUT,
  );

  for (const launcher of LAUNCHERS) {
    test(
      `${launcher.name}: no inherited home-routing variable reaches a test`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const sentinel = mktmp("tps-guard-sentinel-");
        const reports = mktmp("tps-guard-reports-");
        const fx = mktmp("tps-guard-fixture-");
        writeFileSync(join(fx, "env.test.ts"), ENV_FIXTURE);
        // The launcher itself runs under the caller's environment, and on Linux bun
        // caches its own transpiled sources under XDG_CACHE_HOME/bun before any
        // sanitizing can happen. That write is the launcher's runtime, not a test,
        // so it is switched off here: anything left in the sentinel came from a test.
        const { status, out } = runLauncher(
          launcher.argv(join(fx, "env.test.ts")),
          launcher.cwd(fx),
          envWith({
            HOME: sim,
            TPS_TEST_REPORT_DIR: reports,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            ...SENTINEL_ENV(sentinel),
          }),
        );
        expect(out).toContain("inherited home-routing variables are absent");
        expect(status).toBe(0);
        expect(readdirSync(sentinel)).toEqual([]);
      },
      E2E_TIMEOUT,
    );
  }
});

describe("end to end: the launchers refuse an operator-critical temp or report dir", () => {
  for (const launcher of LAUNCHERS) {
    test(
      `${launcher.name}: a TMPDIR inside ~/.tps is refused before anything is created`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const trap = join(sim, ".tps", "tmp");
        mkdirSync(trap, { recursive: true }); // exists, so only the refusal keeps it empty
        const reports = mktmp("tps-guard-reports-");
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fx = mktmp("tps-guard-fixture-");
        writeFileSync(join(fx, "ran.test.ts"), RAN_FIXTURE);
        const { status, out } = runLauncher(
          launcher.argv(join(fx, "ran.test.ts")),
          launcher.cwd(fx),
          envWith({ HOME: sim, TMPDIR: trap, TPS_TEST_REPORT_DIR: reports, GUARD_PROBE_MARKER: marker }),
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
      `${launcher.name}: a TPS_TEST_REPORT_DIR inside ~/.flair is refused before anything is created`,
      () => {
        const sim = mktmp("tps-guard-simhome-");
        const reports = join(sim, ".flair", "reports");
        const marker = join(mktmp("tps-guard-marker-"), "ran");
        const fx = mktmp("tps-guard-fixture-");
        writeFileSync(join(fx, "ran.test.ts"), RAN_FIXTURE);
        const { status, out } = runLauncher(
          launcher.argv(join(fx, "ran.test.ts")),
          launcher.cwd(fx),
          envWith({ HOME: sim, TPS_TEST_REPORT_DIR: reports, GUARD_PROBE_MARKER: marker }),
        );
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(join(sim, ".flair"))).toBe(false);
        expect(status).not.toBe(0);
        expect(out).toContain("refusing to run");
      },
      E2E_TIMEOUT,
    );
  }
});
