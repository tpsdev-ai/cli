/**
 * test/check-dep-ages.test.ts — the dependency release-age gate (cli#529).
 *
 * Pure-function cases use literal inputs. CLI cases spawn
 * `node scripts/check-dep-ages.mjs` with an explicit env. Missing script or lock
 * files and an unbound fixture registry throw before the CLI runs.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { assertNpmCiLockfilesRead, EXACT_LINE_ALLOWLIST, parseWorkflow } from "./helpers/npm-ci-workflow-guard";
import {
  auditExcludes,
  collectNpmLockDeps,
  collectResolvedDeps,
  evaluateAges,
  excludesFromInstallTable,
  isExactVersionPin,
  lockfilesFromFileList,
  MIN_RELEASE_AGE_SECONDS,
  parseBunLock,
  parseExceptions,
  thresholdFromInstallTable,
} from "../scripts/lib/check-dep-ages-collect.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI_SCRIPT = join(REPO, "scripts", "check-dep-ages.mjs");

function setupFailure(what: string): never {
  throw new Error(`test setup failed before the gate ran: ${what}`);
}

const NOW = Date.parse("2026-10-07T00:00:00Z");

/* ────────────────────────────── pure functions ───────────────────────────── */

describe("thresholdFromInstallTable", () => {
  const read = (text: string) => thresholdFromInstallTable(Bun.TOML.parse(text).install);

  it("reads the value CI installs with from this repo's bunfig.toml", () => {
    // 7 days, the value the fragment and docs cite
    expect(read(readFileSync(join(REPO, "bunfig.toml"), "utf8"))).toEqual({ seconds: 604800, error: null });
  });

  it("accepts a value at or above the 7-day floor and ignores the key in another section", () => {
    expect(read("[install]\nminimumReleaseAge = 1209600 # two weeks\n")).toEqual({ seconds: 1209600, error: null });
    expect(read("[test]\nminimumReleaseAge = 604800\n").error).toBe("the key is missing");
  });

  it("refuses a missing, non-numeric, negative or below-floor value", () => {
    expect(read('[test]\npreload = ["./x.ts"]\n')).toEqual({ seconds: null, error: "the key is missing" });
    expect(read('[install]\nminimumReleaseAge = "604800"\n').error).toContain("non-negative number");
    expect(read("[install]\nminimumReleaseAge = -1\n").error).toContain("non-negative number");
    expect(read("[install]\nminimumReleaseAge = 86400\n").error).toContain("below the 604800-second (7-day) floor");
    expect(MIN_RELEASE_AGE_SECONDS).toBe(604800);
  });
});

describe("excludesFromInstallTable", () => {
  const read = (text: string) => excludesFromInstallTable(Bun.TOML.parse(text).install);

  it("reads this repo's install-time exclude list, which is empty", () => {
    const { names, error } = read(readFileSync(join(REPO, "bunfig.toml"), "utf8"));
    expect(error).toBeNull();
    expect(names).toEqual([]);
  });

  it("reads an empty list, and an absent key, as no excludes", () => {
    expect(read('[install]\nminimumReleaseAgeExcludes = []\n')).toEqual({ names: [], error: null });
    expect(read('[install]\nminimumReleaseAge = 604800\n')).toEqual({ names: [], error: null });
  });

  it("reads a multi-line array and drops comments", () => {
    const { names, error } = read('[install]\nminimumReleaseAgeExcludes = [\n  "dep-a", # first\n  "dep-b",\n]\n');
    expect(error).toBeNull();
    expect(names).toEqual(["dep-a", "dep-b"]);
  });

  it("ignores the key in another section", () => {
    expect(read('[test]\nminimumReleaseAgeExcludes = ["dep-a"]\n')).toEqual({ names: [], error: null });
  });

  it("refuses a value that is not an array of strings instead of reading it as empty", () => {
    const notArray = read('[install]\nminimumReleaseAgeExcludes = "dep-a"\n');
    expect(notArray.names).toEqual([]);
    expect(notArray.error).not.toBeNull();
    const badEntry = read('[install]\nminimumReleaseAgeExcludes = ["dep-a", 3]\n');
    expect(badEntry.error).toContain("unparseable");
    const tableArray = read('[[install]]\nminimumReleaseAgeExcludes = ["dep-a"]\n');
    expect(tableArray).toMatchObject({ names: [], error: expect.stringContaining("not a table") });
  });
});

describe("isExactVersionPin", () => {
  it("accepts a bare version and refuses a range, tag or URL", () => {
    expect(isExactVersionPin("4.7.10")).toBe(true);
    expect(isExactVersionPin("1.0.0-rc.1")).toBe(true);
    for (const spec of [
      "^4.7.10",
      "~4.7.10",
      ">=4.7.10",
      "4.7.x",
      "4.x",
      "*",
      "latest",
      "workspace:*",
      "file:../dep",
      "npm:other@1.0.0",
      "1.2.3-..",
    ]) {
      expect(isExactVersionPin(spec)).toBe(false);
    }
  });
});

describe("parseBunLock / collectResolvedDeps", () => {
  it("parses bun.lock's trailing commas and collects external resolved versions", () => {
    const lock = parseBunLock(`{
      "lockfileVersion": 1,
      "packages": {
        "dep-a": ["dep-a@1.2.3", "", {}, "sha512-aa"],
        "@scope/dep-b": ["@scope/dep-b@4.5.6", "", {}, "sha512-bb"],
        "dep-a/nested": ["dep-a@1.2.3", "", {}, "sha512-aa"],
        "own": ["@tpsdev-ai/cli@workspace:packages/cli"],
        "internal": ["@tpsdev-ai/cli@0.8.0", "", {}, "sha512-cc"],
      },
    }`);
    expect(collectResolvedDeps(lock).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "@scope/dep-b", version: "4.5.6" },
      { name: "@tpsdev-ai/cli", version: "0.8.0" },
      { name: "dep-a", version: "1.2.3" },
    ]);
  });

  it("returns nothing for a lock with no packages map", () => {
    expect(collectResolvedDeps({ lockfileVersion: 1 })).toEqual([]);
    expect(collectResolvedDeps(null)).toEqual([]);
  });
});

/** An exceptions file with an intro (prose and a fenced example) and then entries. */
function exceptionsDoc(...entries: string[]): string {
  return [
    "# Dependency release-age exceptions",
    "",
    "Prose, and a format example that must NOT parse as an entry:",
    "",
    "```",
    "- name@version | expires:YYYY-MM-DD | reason: why",
    "```",
    "",
    "## Exceptions",
    ...entries,
    "",
  ].join("\n");
}

describe("parseExceptions", () => {
  it("reads an entry under the heading and ignores the prose above it", () => {
    const { entries, errors } = parseExceptions(
      exceptionsDoc("- dep-a@1.0.0 | expires:2026-12-01 | reason: backport pending"),
      NOW,
    );
    expect(errors).toEqual([]);
    expect(entries.get("dep-a@1.0.0")).toMatchObject({ expires: "2026-12-01" });
  });

  it("rejects a single-hash Exceptions heading", () => {
    const { entries, errors } = parseExceptions(
      "# Exceptions\n- dep-a@1.0.0 | expires:2026-12-01 | reason: urgent\n", NOW,
    );
    expect(entries.size).toBe(0);
    expect(errors[0]?.message).toContain("no `## Exceptions` heading");
  });

  it("validates a heading and an undated entry after a valid exception", () => {
    const { errors } = parseExceptions(exceptionsDoc(
      "- dep-a@1.0.0 | expires:2026-12-01 | reason: urgent",
      "### More", "- dep-b@1.0.0 | reason: undated",
    ), NOW);
    expect(errors.map((e) => e.text)).toEqual(["### More", "- dep-b@1.0.0 | reason: undated"]);
  });

  it("reads an empty section as no exceptions", () => {
    const { entries, errors } = parseExceptions(exceptionsDoc(), NOW);
    expect(errors).toEqual([]);
    expect(entries.size).toBe(0);
  });

  it("fails closed when the Exceptions heading is missing", () => {
    const { entries, errors } = parseExceptions("- dep-a@1.0.0 | expires:2026-12-01 | reason: x\n", NOW);
    expect(entries.size).toBe(0);
    expect(errors[0]?.message).toContain("Exceptions");
  });

  it("keeps an entry valid through the end of its expiry day", () => {
    const { entries, errors } = parseExceptions(
      exceptionsDoc("- dep-a@1.0.0 | expires:2026-10-07 | reason: shipped today, backport pending"),
      NOW,
    );
    expect(errors).toEqual([]);
    expect(entries.get("dep-a@1.0.0")).toMatchObject({ expires: "2026-10-07" });
  });

  it("rejects an undated entry", () => {
    const { entries, errors } = parseExceptions(exceptionsDoc("- dep-a@1.0.0 | reason: no date"), NOW);
    expect(entries.size).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it("rejects an expired entry", () => {
    const { entries, errors } = parseExceptions(
      exceptionsDoc("- dep-a@1.0.0 | expires:2020-01-01 | reason: stale"),
      NOW,
    );
    expect(entries.size).toBe(0);
    expect(errors[0]?.message).toContain("expired");
  });

  it("rejects an impossible calendar date", () => {
    const { entries, errors } = parseExceptions(
      exceptionsDoc("- dep-a@1.0.0 | expires:2026-02-30 | reason: not a real day"),
      NOW,
    );
    expect(entries.size).toBe(0);
    expect(errors[0]?.message).toContain("invalid expiry date");
  });

  it("rejects an entry with no reason", () => {
    const { errors } = parseExceptions(
      exceptionsDoc("- dep-a@1.0.0 | expires:2026-12-01 | reason:"),
      NOW,
    );
    expect(errors).toHaveLength(1);
  });
});

describe("auditExcludes", () => {
  const pkg = (json: object, path = "package.json") => ({ path, json });

  it("passes when the excluded name has an unexpired entry and an exact pin", () => {
    const { entries } = parseExceptions(
      exceptionsDoc("- dep-a@1.0.0 | expires:2026-12-01 | reason: urgent"),
      NOW,
    );
    expect(
      auditExcludes({
        excludes: ["dep-a"],
        exceptionEntries: entries,
        exceptionErrors: [],
        packageJsons: [pkg({ name: "fixture", dependencies: { "dep-a": "1.0.0" } })],
      }),
    ).toEqual([]);
  });

  it("reports an excluded name with no entry", () => {
    expect(
      auditExcludes({
        excludes: ["dep-a"],
        exceptionEntries: new Map(),
        exceptionErrors: [],
        packageJsons: [pkg({ dependencies: { "dep-a": "1.0.0" } })],
      }),
    ).toEqual([{ kind: "uncovered", name: "dep-a", error: null }]);
  });

  it("reports an excluded name whose entry has expired", () => {
    const { entries, errors } = parseExceptions(
      exceptionsDoc("- dep-a@1.0.0 | expires:2020-01-01 | reason: stale"),
      NOW,
    );
    const problems = auditExcludes({
      excludes: ["dep-a"],
      exceptionEntries: entries,
      exceptionErrors: errors,
      packageJsons: [pkg({ dependencies: { "dep-a": "1.0.0" } })],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "uncovered", name: "dep-a" });
    expect(problems[0].error?.message).toContain("expired");
  });

  it("reports the declaring package.json when the pin is a range", () => {
    const { entries } = parseExceptions(
      exceptionsDoc("- dep-a@1.0.0 | expires:2026-12-01 | reason: urgent"),
      NOW,
    );
    const problems = auditExcludes({
      excludes: ["dep-a"],
      exceptionEntries: entries,
      exceptionErrors: [],
      packageJsons: [
        pkg({ name: "a", dependencies: { "dep-a": "1.0.0" } }),
        pkg({ name: "b", devDependencies: { "dep-a": "^1.0.0" } }, "packages/b/package.json"),
      ],
    });
    expect(problems).toEqual([
      { kind: "range", name: "dep-a", path: "packages/b/package.json", spec: "^1.0.0" },
    ]);
  });
});

describe("evaluateAges", () => {
  const day = 24 * 60 * 60 * 1000;
  const gateSeconds = 7 * 24 * 60 * 60;
  const deps = [
    { name: "old", version: "1.0.0" },
    { name: "young", version: "2.0.0" },
    { name: "six-days", version: "1.0.0" },
    { name: "known-only", version: "3.0.0" },
  ];
  const publishTimes = new Map([
    ["old@1.0.0", NOW - 100 * day],
    ["young@2.0.0", NOW - 1 * day],
    ["six-days@1.0.0", NOW - 6 * day],
  ]);

  it("flags a young version with no exception and passes an older one", () => {
    const r = evaluateAges({
      deps,
      publishTimes,
      gateSeconds,
      nowMs: NOW,
      exceptionEntries: new Map(),
    });
    expect(r.uncovered.map((d) => `${d.name}@${d.version}`)).toEqual(["young@2.0.0", "six-days@1.0.0"]);
    expect(r.covered).toEqual([]);
    expect(r.missing.map((d) => d.name)).toEqual(["known-only"]);
  });

  it("moves a young version to covered when a valid exception names it", () => {
    const r = evaluateAges({
      deps,
      publishTimes,
      gateSeconds,
      nowMs: NOW,
      exceptionEntries: new Map([["young@2.0.0", { expires: "2026-12-01", reason: "fix now" }]]),
    });
    expect(r.uncovered.map((d) => d.name)).toEqual(["six-days"]);
    expect(r.covered.map((d) => `${d.name}@${d.version}`)).toEqual(["young@2.0.0"]);
  });

  it("treats a version exactly at the gate as old enough", () => {
    const r = evaluateAges({
      deps: [{ name: "edge", version: "1.0.0" }],
      publishTimes: new Map([["edge@1.0.0", NOW - 7 * day]]),
      gateSeconds,
      nowMs: NOW,
      exceptionEntries: new Map(),
    });
    expect(r.young).toEqual([]);
  });
});

/* ────────────────────────────── CLI cases ───────────────────────────────── */

let scratch = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "cli-dep-ages-"));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** A registry this process serves; unknown names answer with an empty time map. */
function fixtureRegistry(times: Record<string, Record<string, string>>) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const name = decodeURIComponent(path.slice(1));
      return Response.json({ time: times[name] ?? {} });
    },
  });
  if (!server.port) setupFailure("fixture registry did not bind a port");
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

const FIXTURE_LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "dep-a": ["dep-a@1.0.0", "", {}, "sha512-aa"],
    "@tpsdev-ai/cli": ["@tpsdev-ai/cli@workspace:packages/cli"],
  },
}`;

/** Write a fixture repo root. `minAge` null omits the [install] section. */
function writeFixtureRepo(
  root: string,
  opts: {
    minAge?: number | null;
    lock?: string;
    exceptions?: string;
    excludes?: string[];
    packages?: Record<string, unknown>;
    npmLocks?: Record<string, unknown>;
  } = {},
): string {
  mkdirSync(join(root, "docs"), { recursive: true });
  const minAge = opts.minAge === undefined ? 604800 : opts.minAge;
  const excludes = opts.excludes ?? [];
  let bunfig = minAge === null ? '[test]\npreload = ["./x.ts"]\n' : `[install]\nminimumReleaseAge = ${minAge}\n`;
  if (minAge !== null && excludes.length > 0) {
    bunfig += `minimumReleaseAgeExcludes = [${excludes.map((n) => `"${n}"`).join(", ")}]\n`;
  }
  writeFileSync(join(root, "bunfig.toml"), bunfig);
  writeFileSync(join(root, "bun.lock"), opts.lock ?? FIXTURE_LOCK);
  if (opts.exceptions !== undefined) {
    writeFileSync(join(root, "docs", "dep-age-exceptions.md"), opts.exceptions);
  }
  for (const [path, json] of Object.entries(opts.packages ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(json));
  }
  for (const [path, lock] of Object.entries(opts.npmLocks ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(lock));
  }
  if (!existsSync(join(root, "bun.lock"))) setupFailure(`fixture lock not written under ${root}`);
  return root;
}

async function runGate(env: Record<string, string>, args: string[] = []) {
  if (!existsSync(CLI_SCRIPT)) setupFailure(`gate script not found at ${CLI_SCRIPT}`);
  const proc = Bun.spawn(["node", CLI_SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const exitCode = await proc.exited;
  const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { exitCode, output };
}

const ISO_NOW = new Date().toISOString();
const OLD_ISO = "2020-01-01T00:00:00.000Z";
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** An npm v3 lockfile whose root entry carries no dependencies. */
function npmLock(entries: Record<string, unknown>): unknown {
  return { lockfileVersion: 3, packages: { "": { name: "fixture", version: "0.0.0" }, ...entries } };
}

function npmResolved(name: string, version: string): string {
  const short = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${short}-${version}.tgz`;
}

describe("CLI — a version younger than the gate fails", () => {
  it("exits 1 and names the fresh dep, with no exception", async () => {
    const root = writeFixtureRepo(join(scratch, "young"), { exceptions: "## Exceptions\n" });
    const registry = fixtureRegistry({ "dep-a": { "1.0.0": ISO_NOW } });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(output).toContain("younger than the 7-day release-age gate");
      expect(output).toContain("dep-a@1.0.0");
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 1 for a young registry-resolved @tpsdev-ai package", async () => {
    const root = writeFixtureRepo(join(scratch, "namespace"), {
      lock: '{"packages":{"pkg":["@tpsdev-ai/age-fixture@1.0.0"]}}',
      exceptions: "## Exceptions\n",
    });
    const registry = fixtureRegistry({ "@tpsdev-ai/age-fixture": { "1.0.0": ISO_NOW } });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root, TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(exitCode).toBe(1);
      expect(output).toContain("@tpsdev-ai/age-fixture@1.0.0");
      expect(registry.requests).toHaveLength(1);
    } finally { registry.stop(); }
  }, 30_000);

  it("exits 0 when a valid dated exception names that exact version", async () => {
    const root = writeFixtureRepo(join(scratch, "covered"), {
      exceptions: `## Exceptions\n- dep-a@1.0.0 | expires:${FUTURE} | reason: urgent fix, backport pending\n`,
    });
    const registry = fixtureRegistry({ "dep-a": { "1.0.0": ISO_NOW } });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(output).toContain("allowed by a dated exception");
      expect(exitCode).toBe(0);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits non-zero when the exception is expired", async () => {
    const root = writeFixtureRepo(join(scratch, "expired"), {
      exceptions: "## Exceptions\n- dep-a@1.0.0 | expires:2020-01-01 | reason: stale\n",
    });
    const registry = fixtureRegistry({ "dep-a": { "1.0.0": ISO_NOW } });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(output).toContain("expired on 2020-01-01");
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits non-zero when the exception is undated", async () => {
    const root = writeFixtureRepo(join(scratch, "undated"), {
      exceptions: "## Exceptions\n- dep-a@1.0.0 | reason: no date on this one\n",
    });
    const registry = fixtureRegistry({ "dep-a": { "1.0.0": ISO_NOW } });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(output).toContain("malformed exception");
      expect(exitCode).toBe(2);
    } finally {
      registry.stop();
    }
  }, 30_000);
});

describe("CLI — the current lockfiles pass", () => {
  it("exits 0 on this repo's bun.lock and tracked package-lock.json files when every resolved version is old enough", async () => {
    // Serve the real lockfiles' resolved versions with a fixed old publish
    // time, so the case is deterministic and offline yet still reads the real
    // files through the real collect path.
    const bunDeps = collectResolvedDeps(parseBunLock(readFileSync(join(REPO, "bun.lock"), "utf8")));
    if (bunDeps.length < 100) setupFailure(`expected the real bun.lock to resolve >100 packages, got ${bunDeps.length}`);
    const npmDeps = [];
    for (const lockfile of trackedLockfiles()) {
      const { deps, problems } = collectNpmLockDeps(
        JSON.parse(readFileSync(join(REPO, lockfile), "utf8")),
        lockfile,
      );
      expect(problems).toEqual([]);
      npmDeps.push(...deps);
    }
    if (npmDeps.length === 0) setupFailure("expected the tracked package-lock.json files to resolve at least one entry");
    const deps = [...bunDeps, ...npmDeps];
    const times: Record<string, Record<string, string>> = {};
    for (const d of deps) {
      times[d.name] = { ...(times[d.name] ?? {}), [d.version]: OLD_ISO };
    }
    const registry = fixtureRegistry(times);
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: REPO,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(output).toContain(`All ${deps.length} external resolved versions`);
      expect(exitCode).toBe(0);
    } finally {
      registry.stop();
    }
  }, 60_000);
});

describe("CLI — the production lockfile selection", () => {
  /** Every pair the real bun.lock and tracked package-lock.json files resolve, served old. */
  function realResolvedTimes(): Record<string, Record<string, string>> {
    const deps = collectResolvedDeps(parseBunLock(readFileSync(join(REPO, "bun.lock"), "utf8")));
    for (const lockfile of trackedLockfiles()) {
      const { deps: npmDeps } = collectNpmLockDeps(
        JSON.parse(readFileSync(join(REPO, lockfile), "utf8")),
        lockfile,
      );
      deps.push(...npmDeps);
    }
    const times: Record<string, Record<string, string>> = {};
    for (const d of deps) times[d.name] = { ...(times[d.name] ?? {}), [d.version]: OLD_ISO };
    return times;
  }

  it("reads every tracked package-lock.json with git ls-files, without a root override", async () => {
    const lockfiles = trackedLockfiles();
    expect(lockfiles.length).toBeGreaterThan(1);
    const registry = fixtureRegistry(realResolvedTimes());
    try {
      const { exitCode, output } = await runGate({ TPS_DEP_AGES_REGISTRY: registry.url });
      expect(exitCode).toBe(0);
      for (const lockfile of lockfiles) expect(output).toContain(`${lockfile}: `);
    } finally {
      registry.stop();
    }
  }, 120_000);
});

describe("CLI — pinned npm lockfiles under --ci", () => {
  const lockfile = "fixtures/pinned lock/package-lock.json";

  function fixture() {
    const root = writeFixtureRepo(mkdtempSync(join(scratch, "ci-pinned-")), {
      exceptions: "## Exceptions\n",
      npmLocks: { [lockfile]: npmLock({ "node_modules/pinned": { version: "1.0.0" } }) },
    });
    const home = mkdtempSync(join(scratch, "ci-home-"));
    const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
    mkdirSync(join(root, "scripts/lib"), { recursive: true });
    for (const path of ["scripts/check-dep-ages.mjs", "scripts/lib/check-dep-ages-collect.mjs", "scripts/lib/npm-ci-revision.sh"]) {
      writeFileSync(join(root, path), readFileSync(join(REPO, path)));
    }
    const preload = join(root, "publish-times.mjs");
    writeFileSync(preload, `globalThis.fetch = async (url) => {
      console.log("publish-time request: " + url);
      return Response.json({ time: { "1.0.0": ${JSON.stringify(OLD_ISO)}, "2.0.0": new Date().toISOString() } });
    };\n`);
    git("init", "-q");
    git("config", "user.name", "Fixture Author");
    git("config", "user.email", "fixture@example.test");
    const commit = (message: string) => {
      git("add", ".");
      const parent = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, env, encoding: "utf8" });
      const parents = parent.status === 0 ? ["-p", parent.stdout.trim()] : [];
      const sha = git("commit-tree", git("write-tree"), ...parents, "-m", message);
      git("update-ref", "HEAD", sha);
    };
    commit("pinned lock");
    const revision = git("rev-parse", "HEAD");
    const committed = readFileSync(join(root, lockfile));
    const run = (args = ["--ci"], extra: Record<string, string | undefined> = {}) => {
      const result = spawnSync("node", ["--import", preload, join(root, "scripts/check-dep-ages.mjs"), ...args], {
        cwd: root, env: { ...env, GITHUB_ACTIONS: "true", GITHUB_SHA: revision, ...extra },
        encoding: "utf8", timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      return { exitCode: result.status, output: result.stdout + result.stderr };
    };
    return { root, git, revision, committed, commit, run };
  }

  it("refuses a changed checkout lock, naming its path and pinned revision", () => {
    const h = fixture();
    writeFileSync(join(h.root, lockfile), JSON.stringify(npmLock({ "node_modules/replacement": { version: "1.0.0" } })));
    const result = h.run();
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(`${lockfile}: working file differs from ${h.revision}`);
    expect(result.output).not.toContain("publish-time request:");
  }, 30_000);

  it("selects an identical lock from GITHUB_SHA after HEAD and the index drop it", () => {
    const h = fixture();
    h.git("rm", lockfile);
    writeFileSync(join(h.root, "package-lock.json"), JSON.stringify(npmLock({ "node_modules/head": { version: "2.0.0" } })));
    h.commit("different HEAD lock");
    expect(h.git("rev-parse", "HEAD")).not.toBe(h.revision);
    mkdirSync(dirname(join(h.root, lockfile)), { recursive: true });
    writeFileSync(join(h.root, lockfile), h.committed);
    const result = h.run();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`${lockfile}: 1 npm entries`);
    expect(result.output).toContain("publish-time request: https://registry.npmjs.org/pinned");
    expect(result.output).not.toContain("publish-time request: https://registry.npmjs.org/head");
    expect(result.output).toContain("All 2 external resolved versions");
  }, 30_000);

  it("fails the age verdict for an identical young committed lock", () => {
    const h = fixture();
    writeFileSync(join(h.root, lockfile), JSON.stringify(npmLock({ "node_modules/pinned": { version: "2.0.0" } })));
    h.commit("young pinned lock");
    const result = h.run(["--ci"], { GITHUB_SHA: h.git("rev-parse", "HEAD") });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`${lockfile}: pinned@2.0.0`);
  }, 30_000);

  it("refuses a committed lock deleted from the checkout, naming its path and revision", () => {
    const h = fixture();
    rmSync(join(h.root, lockfile));
    const result = h.run();
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(`cannot compare ${lockfile} with ${h.revision}`);
    expect(result.output).not.toContain("publish-time request:");
  }, 30_000);

  it("uses HEAD outside Actions when GITHUB_SHA is unset or invalid", () => {
    const h = fixture();
    for (const sha of [undefined, "", "invalid"]) {
      const result = h.run(["--ci"], { GITHUB_ACTIONS: "", GITHUB_SHA: sha });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(`${lockfile}: 1 npm entries`);
    }
    writeFileSync(join(h.root, lockfile), "{}\n");
    const result = h.run(["--ci"], { GITHUB_ACTIONS: "", GITHUB_SHA: "" });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(`${lockfile}: working file differs from HEAD`);
  }, 30_000);

  it.each([undefined, "", "malformed", "a".repeat(39), "g".repeat(40)])(
    "refuses Actions with invalid GITHUB_SHA %j", (sha) => {
      const h = fixture();
      const result = h.run(["--ci"], { GITHUB_SHA: sha });
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain("GITHUB_SHA must be 40 hex characters under GitHub Actions");
    }, 30_000,
  );

  it("keeps reading the changed working lock outside --ci", () => {
    const h = fixture();
    writeFileSync(join(h.root, lockfile), JSON.stringify(npmLock({ "node_modules/working": { version: "2.0.0" } })));
    const result = h.run([], { GITHUB_SHA: "invalid" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`${lockfile}: working@2.0.0`);
    expect(result.output).not.toContain("differs");
  }, 30_000);
});

describe("CLI — npm lockfiles", () => {
  const bunOnlyTimes = { "dep-a": { "1.0.0": OLD_ISO } };

  it.each([
    ["encoded-scope", "@scope%2fpkg", "https://registry.npmjs.org/@scope%2fpkg/-/@scope%2fpkg-1.0.0.tgz"],
    ["encoded-basename", "pkg", "https://registry.npmjs.org/pkg/-/%70kg-1.0.0.tgz"],
  ])("exits 2 naming the lockfile, entry and URL for %s", async (label, name, resolved) => {
    const lock = npmLock({ "node_modules/alias": { name, version: "1.0.0", resolved } });
    const collected = collectNpmLockDeps(lock, "package-lock.json");
    expect(collected.deps).toEqual([]);
    expect(collected.problems).toEqual([{
      lockfile: "package-lock.json", entry: "node_modules/alias",
      message: `resolved URL has a percent-encoded path component: ${resolved}`,
    }]);
    const root = writeFixtureRepo(join(scratch, label), {
      exceptions: "## Exceptions\n", npmLocks: { "package-lock.json": lock },
    });
    const { exitCode, output } = await runGate({ TPS_DEP_AGES_ROOT: root, TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1" });
    expect(exitCode).toBe(2);
    expect(output).toContain("package-lock.json: entry node_modules/alias");
    expect(output).toContain(`resolved URL has a percent-encoded path component: ${resolved}`);
    expect(output).not.toContain("Checking");
  }, 30_000);

  it.each([
    ["query-name", "pkg?x", "1.0.0", "https://registry.npmjs.org/pkg?x/-/pkg?x-1.0.0.tgz"],
    ["fragment-name", "pkg#x", "1.0.0", "https://registry.npmjs.org/pkg#x/-/pkg#x-1.0.0.tgz"],
    ["query-basename", "pkg", "1.0.0?x", "https://registry.npmjs.org/pkg/-/pkg-1.0.0?x.tgz"],
    ["fragment-basename", "pkg", "1.0.0#x", "https://registry.npmjs.org/pkg/-/pkg-1.0.0#x.tgz"],
  ])("exits 2 naming the lockfile, entry and URL for %s", async (label, name, version, resolved) => {
    const lock = npmLock({ "node_modules/alias": { name, version, resolved } });
    const message = `resolved URL has a query or fragment delimiter: ${resolved}`;
    expect(collectNpmLockDeps(lock, "package-lock.json")).toEqual({
      deps: [], problems: [{ lockfile: "package-lock.json", entry: "node_modules/alias", message }],
    });
    const root = writeFixtureRepo(join(scratch, label), {
      exceptions: "## Exceptions\n", npmLocks: { "package-lock.json": lock },
    });
    const { exitCode, output } = await runGate({ TPS_DEP_AGES_ROOT: root, TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1" });
    expect(exitCode).toBe(2);
    expect(output).toContain("package-lock.json: entry node_modules/alias");
    expect(output).toContain(message);
    expect(output).not.toContain("Checking");
  }, 30_000);

  it.each([["missing", undefined], ["1", 1], ["4", 4]] as const)("exits 2 naming lockfileVersion %s", async (_label, version) => {
    const lock = { lockfileVersion: version, packages: { "node_modules/pkg": { version: "1.0.0" } } };
    const message = `a v2 or v3 lockfile is required; lockfileVersion found: ${version ?? "missing"}`;
    expect(collectNpmLockDeps(lock, "package-lock.json")).toEqual({
      deps: [], problems: [{ lockfile: "package-lock.json", entry: "", message }],
    });
    const root = writeFixtureRepo(join(scratch, `npm-format-${version ?? "missing"}`), {
      exceptions: "## Exceptions\n", npmLocks: { "package-lock.json": lock },
    });
    const { exitCode, output } = await runGate({ TPS_DEP_AGES_ROOT: root, TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1" });
    expect(exitCode).toBe(2);
    expect(output).toContain("package-lock.json:");
    expect(output).toContain(message);
    expect(output).not.toContain("Checking");
  }, 30_000);

  it("exits 1 naming the lockfile, package and version of a too-young entry", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-young"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "plugins/example/package-lock.json": npmLock({
          "node_modules/fresh-dep": { version: "2.0.0", resolved: npmResolved("fresh-dep", "2.0.0") },
        }),
      },
    });
    const registry = fixtureRegistry({ ...bunOnlyTimes, "fresh-dep": { "2.0.0": ISO_NOW } });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(exitCode).toBe(1);
      expect(output).toContain("plugins/example/package-lock.json: fresh-dep@2.0.0");
      expect(output).toContain("plugins/example/package-lock.json: 1 npm entries");
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 0 when a dated exception covers the npm entry", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-covered"), {
      exceptions: `## Exceptions\n- fresh-dep@2.0.0 | expires:${FUTURE} | reason: fixture exception\n`,
      npmLocks: {
        "package-lock.json": npmLock({
          "node_modules/fresh-dep": { version: "2.0.0", resolved: npmResolved("fresh-dep", "2.0.0") },
        }),
      },
    });
    const registry = fixtureRegistry({ ...bunOnlyTimes, "fresh-dep": { "2.0.0": ISO_NOW } });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(exitCode).toBe(0);
      expect(output).toContain("allowed by a dated exception");
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("ignores the root entry, link entries and local file:/workspace: entries", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-local"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "package-lock.json": npmLock({
          "node_modules/linked": { resolved: "../linked", link: true },
          "node_modules/local": { version: "1.0.0", resolved: "file:../local" },
          "node_modules/local-workspace": { version: "1.0.0", resolved: "workspace:*" },
        }),
      },
    });
    const registry = fixtureRegistry(bunOnlyTimes);
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(exitCode).toBe(0);
      expect(output).toContain("package-lock.json: 0 npm entries");
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 2 naming a git: resolved entry before fetching", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-git-local"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "package-lock.json": npmLock({
          "node_modules/local-git": { version: "1.0.0", resolved: "git:../local-git" },
        }),
      },
    });
    const { exitCode, output } = await runGate({
      TPS_DEP_AGES_ROOT: root,
      TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1",
    });
    expect(exitCode).toBe(2);
    expect(output).toContain("package-lock.json: entry node_modules/local-git");
    expect(output).toContain("resolved URL is a git dependency, which has no publish time: git:../local-git");
    expect(output).not.toContain("Checking");
  }, 30_000);

  it("exits 2 naming a git+https resolved entry before fetching", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-git-remote"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "package-lock.json": npmLock({
          "node_modules/remote-dep": {
            version: "1.0.0",
            resolved: "git+https://github.com/example/remote-dep.git#0123456",
          },
        }),
      },
    });
    const { exitCode, output } = await runGate({
      TPS_DEP_AGES_ROOT: root,
      TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1",
    });
    expect(exitCode).toBe(2);
    expect(output).toContain("package-lock.json: entry node_modules/remote-dep");
    expect(output).toContain("git+https://github.com/example/remote-dep.git#0123456");
    expect(output).not.toContain("Checking");
  }, 30_000);

  it("parses a scoped package's name from its node_modules path", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-scoped"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "package-lock.json": npmLock({
          "node_modules/@scope/pkg": { version: "1.2.3", resolved: npmResolved("@scope/pkg", "1.2.3") },
        }),
      },
    });
    const registry = fixtureRegistry({ ...bunOnlyTimes, "@scope/pkg": { "1.2.3": ISO_NOW } });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(exitCode).toBe(1);
      expect(output).toContain("package-lock.json: @scope/pkg@1.2.3");
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("uses a recorded name for an aliased install", async () => {
    // npm's lockfile records the real registry package in `name`; the install
    // path is the alias. The lookup must use the former.
    const root = writeFixtureRepo(join(scratch, "npm-alias"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "package-lock.json": npmLock({
          "node_modules/aliased": {
            name: "@scope/real-dep",
            version: "1.5.0",
            resolved: npmResolved("@scope/real-dep", "1.5.0"),
          },
        }),
      },
    });
    const registry = fixtureRegistry({ ...bunOnlyTimes, "@scope/real-dep": { "1.5.0": OLD_ISO } });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(exitCode).toBe(0);
      expect(registry.requests.map((path) => decodeURIComponent(path))).toContain("/@scope/real-dep");
      expect(output).toContain("package-lock.json: 1 npm entries");
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("exits 2 naming an npm entry with no publish time", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-no-time"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "package-lock.json": npmLock({
          "node_modules/no-time": { version: "1.0.0", resolved: npmResolved("no-time", "1.0.0") },
        }),
      },
    });
    const registry = fixtureRegistry(bunOnlyTimes);
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(exitCode).toBe(2);
      expect(output).toContain("package-lock.json: no-time@1.0.0: no publish time");
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("refuses a resolved tarball URL that names a different package", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-name-mismatch"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "package-lock.json": npmLock({
          "node_modules/recorded-dep": {
            name: "recorded-dep",
            version: "1.0.0",
            resolved: npmResolved("other-dep", "9.9.9"),
          },
        }),
      },
    });
    const { exitCode, output } = await runGate({
      TPS_DEP_AGES_ROOT: root,
      TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1",
    });
    expect(exitCode).toBe(2);
    expect(output).toContain("package-lock.json: entry node_modules/recorded-dep");
    expect(output).toContain("resolved URL identifies other-dep, but the entry records recorded-dep");
    expect(output).not.toContain("Checking");
  }, 30_000);

  it("refuses a resolved tarball URL whose version differs from the recorded version", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-version-mismatch"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "package-lock.json": npmLock({
          "node_modules/recorded-dep": {
            version: "1.0.0",
            resolved: npmResolved("recorded-dep", "9.9.9"),
          },
        }),
      },
    });
    const { exitCode, output } = await runGate({
      TPS_DEP_AGES_ROOT: root,
      TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1",
    });
    expect(exitCode).toBe(2);
    expect(output).toContain("package-lock.json: entry node_modules/recorded-dep");
    expect(output).toContain(
      "resolved URL identifies recorded-dep@9.9.9, but the entry records version 1.0.0",
    );
    expect(output).not.toContain("Checking");
  }, 30_000);

  it("ages an entry with no resolved URL by its recorded name and version", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-no-resolved"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "package-lock.json": npmLock({
          "node_modules/unresolved-young": { version: "2.0.0" },
        }),
      },
    });
    const registry = fixtureRegistry({ ...bunOnlyTimes, "unresolved-young": { "2.0.0": ISO_NOW } });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(exitCode).toBe(1);
      expect(output).toContain("package-lock.json: unresolved-young@2.0.0");
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("collects no-resolved entries despite inBundle flags on the entry or parent", () => {
    const lock = npmLock({
      "node_modules/bundled-dep": { version: "1.0.0", inBundle: true },
      "node_modules/bundled-parent": { version: "1.0.0", inBundle: true },
      "node_modules/bundled-parent/node_modules/nested": { version: "1.0.0" },
    });
    const { deps, problems } = collectNpmLockDeps(lock, "package-lock.json");
    expect(problems).toEqual([]);
    expect(deps).toEqual([
      { name: "bundled-dep", version: "1.0.0", lockfile: "package-lock.json" },
      { name: "bundled-parent", version: "1.0.0", lockfile: "package-lock.json" },
      { name: "nested", version: "1.0.0", lockfile: "package-lock.json" },
    ]);
  }, 30_000);

  it("ages no-resolved entries marked inBundle and nested under an inBundle parent", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-bundled"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "package-lock.json": npmLock({
          "node_modules/bundled-dep": { version: "1.0.0", inBundle: true },
          "node_modules/bundled-parent": { version: "1.0.0", inBundle: true },
          "node_modules/bundled-parent/node_modules/nested": { version: "1.0.0" },
        }),
      },
    });
    const registry = fixtureRegistry({
      ...bunOnlyTimes,
      "bundled-dep": { "1.0.0": ISO_NOW },
      "bundled-parent": { "1.0.0": ISO_NOW },
      nested: { "1.0.0": ISO_NOW },
    });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(exitCode).toBe(1);
      for (const name of ["bundled-dep", "bundled-parent", "nested"]) {
        expect(output).toContain(`package-lock.json: ${name}@1.0.0`);
      }
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("refuses an entry with no resolved URL and no version", async () => {
    const root = writeFixtureRepo(join(scratch, "npm-versionless"), {
      exceptions: "## Exceptions\n",
      npmLocks: {
        "package-lock.json": npmLock({ "node_modules/versionless": { inBundle: true } }),
      },
    });
    const { exitCode, output } = await runGate({
      TPS_DEP_AGES_ROOT: root,
      TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1",
    });
    expect(exitCode).toBe(2);
    expect(output).toContain("package-lock.json: entry node_modules/versionless");
    expect(output).toContain("entry with no `resolved` URL has no version");
    expect(output).not.toContain("Checking");
  }, 30_000);

  it("collects the real aliased entry under the recorded package name", () => {
    const lockfile = "plugins/openclaw-tps-mail/package-lock.json";
    const lock = JSON.parse(readFileSync(join(REPO, lockfile), "utf8"));
    const aliasPath = "node_modules/openclaw/node_modules/node-domexception";
    expect(lock.packages[aliasPath].name).toBe("@nolyfill/domexception");
    const { deps, problems } = collectNpmLockDeps(lock, lockfile);
    expect(problems).toEqual([]);
    expect(deps).toContainEqual({
      name: lock.packages[aliasPath].name,
      version: lock.packages[aliasPath].version,
      lockfile,
    });
  });
});

describe("CLI — the threshold is the value Bun parses", () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  it.each([
    ["multi-line-string", '[install]\nnote = """\nminimumReleaseAge = 1\n"""\nminimumReleaseAge = 604800\n'],
    ["escaped-dotted-key", 'install."minimumReleaseAg\\u0065" = 604800\n'],
    ["inline-table", "install = { minimumReleaseAge = 604800 }\n"],
  ])("checks a 3-day-old version against Bun's 7 days (%s)", async (label, bunfig) => {
    expect(Bun.TOML.parse(bunfig).install.minimumReleaseAge).toBe(604800);
    const root = writeFixtureRepo(join(scratch, `bun-threshold-${label}`), { exceptions: "## Exceptions\n" });
    writeFileSync(join(root, "bunfig.toml"), bunfig);
    const registry = fixtureRegistry({ "dep-a": { "1.0.0": threeDaysAgo } });
    try {
      const { exitCode, output } = await runGate({ TPS_DEP_AGES_ROOT: root, TPS_DEP_AGES_REGISTRY: registry.url });
      expect(output).toContain("younger than the 7-day release-age gate");
      expect(output).toContain("dep-a@1.0.0");
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);
});

describe("CLI — refusals and fail-closed", () => {
  it("exits 2 when a publish time cannot be fetched", async () => {
    const root = writeFixtureRepo(join(scratch, "dead"), { exceptions: "## Exceptions\n" });
    const { exitCode, output } = await runGate({
      TPS_DEP_AGES_ROOT: root,
      TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1",
    });
    expect(output).toContain("Failed to fetch publish times");
    expect(exitCode).toBe(2);
  }, 30_000);

  it("exits 2 when bunfig.toml has no [install] minimumReleaseAge", async () => {
    const root = writeFixtureRepo(join(scratch, "no-gate"), { minAge: null, exceptions: "## Exceptions\n" });
    const { exitCode, output } = await runGate({ TPS_DEP_AGES_ROOT: root });
    expect(output).toContain("no valid [install] minimumReleaseAge: the key is missing");
    expect(exitCode).toBe(2);
  }, 30_000);

  it.each([
    ["non-numeric", 'minimumReleaseAge = "604800"', "expected a non-negative number of seconds"],
    ["negative", "minimumReleaseAge = -1", "expected a non-negative number of seconds"],
    ["below-floor", "minimumReleaseAge = 86400", "86400 is below the 604800-second (7-day) floor"],
  ])("exits 2 when minimumReleaseAge is %s", async (label, line, diagnostic) => {
    const root = writeFixtureRepo(join(scratch, `threshold-${label}`), { exceptions: "## Exceptions\n" });
    writeFileSync(join(root, "bunfig.toml"), `[install]\n${line}\n`);
    const { exitCode, output } = await runGate({ TPS_DEP_AGES_ROOT: root, TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1" });
    expect(output).toContain(`no valid [install] minimumReleaseAge: ${diagnostic}`);
    expect(output).not.toContain("Checking");
    expect(exitCode).toBe(2);
  }, 30_000);

  it("exits 2 when the exception file is missing", async () => {
    const root = writeFixtureRepo(join(scratch, "no-exceptions"));
    const { exitCode, output } = await runGate({ TPS_DEP_AGES_ROOT: root });
    expect(output).toContain("dep-age-exceptions.md");
    expect(exitCode).toBe(2);
  }, 30_000);

  it("rejects both exception-heading bypasses before fetching", async () => {
    for (const [index, exceptions, diagnostic] of [
      [0, `# Exceptions\n- dep-a@1.0.0 | expires:${FUTURE} | reason: urgent\n`, "no `## Exceptions` heading"],
      [1, `## Exceptions\n- dep-a@1.0.0 | expires:${FUTURE} | reason: urgent\n### More\n- dep-b@1.0.0 | reason: undated\n`, "malformed exception"],
    ] as const) {
      const root = writeFixtureRepo(join(scratch, `heading-${index}`), { exceptions });
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root, TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1",
      });
      expect(exitCode).toBe(2);
      expect(output).toContain(diagnostic);
      expect(output).not.toContain("Checking");
    }
  }, 30_000);

  it("refuses the fixture-root override under the CI flag", async () => {
    const root = writeFixtureRepo(join(scratch, "ci"), { exceptions: "## Exceptions\n" });
    const { exitCode, output } = await runGate(
      { TPS_DEP_AGES_ROOT: root, TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1" },
      ["--ci"],
    );
    expect(output).toContain("TPS_DEP_AGES_ROOT");
    expect(exitCode).toBe(2);
  }, 30_000);

  it("refuses the publish-time registry override under --ci, including empty values", async () => {
    for (const value of ["http://127.0.0.1:1", ""]) {
      const { exitCode, output } = await runGate({ TPS_DEP_AGES_REGISTRY: value }, ["--ci"]);
      expect(exitCode).toBe(2);
      expect(output).toContain("TPS_DEP_AGES_REGISTRY");
      expect(output).toContain("Refusing");
    }
  }, 30_000);

  it("names alternate registry overrides refused under --ci", async () => {
    for (const name of ["npm_config_registry", "NPM_CONFIG_REGISTRY", "BUN_CONFIG_DEFAULT_REGISTRY", "BUN_CONFIG_REGISTRY"]) {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1", [name]: "",
      }, ["--ci"]);
      expect(exitCode).toBe(2);
      expect(output).toContain(name);
      expect(output).toContain("Refusing");
    }
  }, 30_000);

  it("refuses an unknown argument before scanning", async () => {
    const { exitCode, output } = await runGate({}, ["--c1"]);
    expect(output).toContain("--c1");
    expect(output).toContain("--ci");
    expect(exitCode).toBe(2);
  }, 30_000);
});


describe("CLI — exception resolutions", () => {
  it.each([
    ["nonexistent@1.0.0", "unused exception: nonexistent@1.0.0"],
    ["dep-a@not-a-version", "invalid semver: dep-a@not-a-version"],
    ["dep-a@2.0.0", "unused exception: dep-a@2.0.0"],
  ])("rejects %s before fetching", async (key, diagnostic) => {
    for (const lock of [FIXTURE_LOCK, '{"packages":{"local":["local@workspace:packages/local"]}}']) {
      const root = writeFixtureRepo(join(scratch, key.replaceAll("@", "-")), {
        lock,
        exceptions: `## Exceptions\n- ${key} | expires:${FUTURE} | reason: urgent\n`,
      });
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1",
      });
      expect(exitCode).toBe(2);
      expect(output).toContain(diagnostic);
      expect(output).not.toContain("Checking");
    }
  }, 30_000);
});

describe("exception version syntax", () => {
  it.each(["not-a-version", "1.0", "01.0.0", "1.0.0-01", "v1.0.0", "1.0.0+"])(
    "rejects invalid semver %s",
    (version) => {
      const { entries, errors } = parseExceptions(
        exceptionsDoc(`- dep-a@${version} | expires:2026-12-01 | reason: urgent`), NOW,
      );
      expect(entries.size).toBe(0);
      expect(errors[0]?.message).toContain(`invalid semver: dep-a@${version}`);
    },
  );
});

it("exits 2 for a missing publish time alongside an uncovered young version", async () => {
  const root = writeFixtureRepo(join(scratch, "mixed-publish-times"), {
    lock: '{"packages":{"young":["young@1.0.0"],"missing":["missing@2.0.0"]}}',
    exceptions: "## Exceptions\n",
  });
  const timeMap = encodeURIComponent(JSON.stringify({ time: { "1.0.0": ISO_NOW } }));
  const { exitCode, output } = await runGate({
    TPS_DEP_AGES_ROOT: root,
    TPS_DEP_AGES_REGISTRY: `data:application/json,${timeMap}#`,
  });
  expect(exitCode).toBe(2);
  expect(output).toContain("missing@2.0.0: no publish time");
}, 30_000);

/* ──────────────────── install-time excludes vs exceptions ───────────────── */

describe("CLI — an excluded name needs an unexpired exception and exact declarations", () => {
  const PINNED = { name: "fixture", dependencies: { "dep-a": "1.0.0" } };

  it("passes when the exclude has a dated entry and an exact pin", async () => {
    const root = writeFixtureRepo(join(scratch, "excl-pass"), {
      excludes: ["dep-a"],
      exceptions: `## Exceptions\n- dep-a@1.0.0 | expires:${FUTURE} | reason: urgent fix, backport pending\n`,
      packages: { "package.json": PINNED },
    });
    const registry = fixtureRegistry({ "dep-a": { "1.0.0": ISO_NOW } });
    try {
      const { exitCode, output } = await runGate({
        TPS_DEP_AGES_ROOT: root,
        TPS_DEP_AGES_REGISTRY: registry.url,
      });
      expect(exitCode).toBe(0);
      expect(output).toContain("allowed by a dated exception");
    } finally {
      registry.stop();
    }
  }, 30_000);

  it.each([
    [
      "missing",
      "## Exceptions\n",
      "dep-a: no dated entry under",
    ],
    [
      "expired",
      "## Exceptions\n- dep-a@1.0.0 | expires:2020-01-01 | reason: stale\n",
      "dep-a: its dated entry is invalid: exception expired on 2020-01-01",
    ],
  ])("fails, naming the remedy, when the exclusion's entry is %s", async (_label, exceptions, diagnostic) => {
    const root = writeFixtureRepo(join(scratch, `excl-${_label}`), {
      excludes: ["dep-a"],
      exceptions,
      packages: { "package.json": PINNED },
    });
    // The registry is dead on purpose: the check must refuse before it fetches.
    const { exitCode, output } = await runGate({
      TPS_DEP_AGES_ROOT: root,
      TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1",
    });
    expect(exitCode).toBe(2);
    expect(output).toContain("minimumReleaseAgeExcludes is not covered");
    expect(output).toContain(diagnostic);
    expect(output).toContain("Remedy:");
    expect(output).not.toContain("Checking");
  }, 30_000);

  it("fails, naming the remedy, when a declaring package.json pins a range", async () => {
    const root = writeFixtureRepo(join(scratch, "excl-range"), {
      excludes: ["dep-a"],
      exceptions: `## Exceptions\n- dep-a@1.0.0 | expires:${FUTURE} | reason: urgent fix, backport pending\n`,
      packages: {
        "package.json": { name: "fixture", dependencies: { "dep-a": "1.0.0" } },
        "packages/b/package.json": { name: "fixture-b", dependencies: { "dep-a": "^1.0.0" } },
      },
    });
    const { exitCode, output } = await runGate({
      TPS_DEP_AGES_ROOT: root,
      TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1",
    });
    expect(exitCode).toBe(2);
    expect(output).toContain("minimumReleaseAgeExcludes is not covered");
    expect(output).toContain("packages/b/package.json: `dep-a` is declared as `^1.0.0`");
    expect(output).toContain("Remedy:");
    expect(output).not.toContain("Checking");
  }, 30_000);
});

function assertInstallGates(source: string) {
  const workflow = load(source) as {
    jobs: Record<string, { steps: { run?: string; uses?: string }[] }>;
  };
  let installs = 0;
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    const gate = job.steps.findIndex((step) =>
      step.run?.split("\n").some((line) => line.trim() === "node scripts/check-dep-ages.mjs --ci"),
    );
    for (const [index, step] of job.steps.entries()) {
      if (!step.run?.split("\n").some((line) =>
        !line.trimStart().startsWith("#") && /\b(?:bun install|npm (?:ci|install)|bash scripts\/npm-ci-tracked-lock\.sh)\b/.test(line),
      )) continue;
      installs++;
      expect(checkout).toBeGreaterThanOrEqual(0);
      expect(gate).toBeGreaterThan(checkout);
      expect(gate).toBeLessThan(index);
    }
  }
  expect(installs).toBeGreaterThan(0);
}

it("runs the lock gate before literal bun install, npm ci, npm install command words and helper calls in the CI workflow", () => {
  assertInstallGates(readFileSync(join(REPO, ".github", "workflows", "test.yml"), "utf8"));
});

it("rejects a workflow gate whose run line is only a YAML comment", () => {
  const workflow = readFileSync(join(REPO, ".github", "workflows", "test.yml"), "utf8");
  const commented = workflow.replace(
    "        run: node scripts/check-dep-ages.mjs --ci",
    "        # run: node scripts/check-dep-ages.mjs --ci",
  );
  expect(commented).not.toBe(workflow);
  expect(() => assertInstallGates(commented)).toThrow();
});

/* Run-step lines containing `npm` must match an approved whole-line shape. */

function trackedLockfiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" });
  const files = listed.split("\0").filter(Boolean);
  if (files.length === 0) setupFailure("git ls-files listed no files");
  const lockfiles = lockfilesFromFileList(files);
  if (lockfiles.length === 0) setupFailure("git ls-files listed no package-lock.json");
  return lockfiles;
}

it("checks workflow run steps against the npm line whitelist", () => {
  const tracked = new Set(trackedLockfiles());
  const workflowsDir = join(REPO, ".github", "workflows");
  const workflows = readdirSync(workflowsDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  expect(workflows.length).toBeGreaterThan(0);
  let installs = 0;
  for (const name of workflows) {
    installs += assertNpmCiLockfilesRead(readFileSync(join(workflowsDir, name), "utf8"), tracked, name);
  }
  expect(installs).toBeGreaterThan(0);
});

/** One job, one step, with `run` as a YAML block scalar. */
function workflowStep(run: string, workdir = "plugins/read"): string {
  const body = run.split("\n").map((line) => `          ${line}`).join("\n");
  return `jobs:\n  build:\n    steps:\n      - working-directory: ${workdir}\n        run: |\n${body}\n`;
}

const READ_TRACKED = new Set(["plugins/read/package-lock.json", "plugins/good/package-lock.json"]);

describe("the workflow guard checks lines containing npm and helper calls", () => {
  it.each(["npm ci", "sfw npm ci --ignore-scripts --no-audit --no-fund"])("refuses a literal npm ci command word outside the helper: %s", (run) => {
    expect(() => assertNpmCiLockfilesRead(workflowStep(run), READ_TRACKED)).toThrow(
      `job build step 1: cannot establish the npm ci directory: a run line containing npm is refused unless the whole line is an exact allowlist entry in test/helpers/npm-ci-workflow-guard.ts (add one with its reason), a tracked-lock helper call, or the bounded global tool install: ${run}`,
    );
  }, 5_000);

  it("accepts the helper's literal tracked fixture with a variable prefix", () => {
    expect(assertNpmCiLockfilesRead(workflowStep(
      'prefix="$RUNNER_TEMP/install"\nbash scripts/npm-ci-tracked-lock.sh --via sfw plugins/good "$prefix" --ignore-scripts', ".",
    ), READ_TRACKED)).toBe(1);
  });

  it.each([
    'bash scripts/npm-ci-tracked-lock.sh --in-place plugins/good',
    'bash scripts/npm-ci-tracked-lock.sh --via "$installer" --in-place plugins/good',
    'bash scripts/npm-ci-tracked-lock.sh --via other --in-place plugins/good',
    'bash scripts/npm-ci-tracked-lock.sh --via npm --in-place "$fixture"',
    'bash scripts/npm-ci-tracked-lock.sh --via npm --in-place plugins/good "prefix"',
    'bash scripts/npm-ci-tracked-lock.sh --via sfw "$fixture" "$prefix"',
    'bash scripts/npm-ci-tracked-lock.sh --via sfw ${fixture} "$prefix"',
    'bash scripts/npm-ci-tracked-lock.sh --via sfw /absolute "$prefix"',
    'bash scripts/npm-ci-tracked-lock.sh --via sfw plugins/unread "$prefix"',
  ])("refuses a helper fixture outside its literal tracked contract: %s", (run) => {
    expect(() => assertNpmCiLockfilesRead(workflowStep(run, "."), READ_TRACKED)).toThrow(/job build step 1.*(?:literal relative|not a tracked lockfile|run line containing npm)/);
  }, 30_000);

  it.each([
    "npm run prepare-lock", "PATH=./fakebin", 'PATH="./fakebin"', 'TZ="UTC"',
    'NODE_OPTIONS="--require=./prepare.cjs"', 'npm_config_userconfig="./npmrc"',
    'GIT_CONFIG_GLOBAL="./gitconfig"', 'GITHUB_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    'GITHUB_ACTIONS="false"', 'github_sha="ignored"',
    'pin="$(node scripts/change-head.mjs --pin)"', "export prefix=elsewhere", "source ./prepare.sh",
    ". ./prepare.sh", "eval true", "prepare() { true; }", "echo unexpected",
    'prefix="$unassigned/install"', 'prefix="$(pwd)"', 'prefix=unquoted',
    'pin="$(node scripts/pin.mjs --pin); npm run prepare-lock"',
    'echo "RESULT=$(npm run prepare-lock)" >> "$GITHUB_ENV"',
  ])("refuses a helper-step line: %s", (line) => {
    const run = `prefix="$RUNNER_TEMP/install"\n${line}\nbash scripts/npm-ci-tracked-lock.sh --via sfw plugins/good "$prefix"`;
    let error: unknown;
    try { assertNpmCiLockfilesRead(workflowStep(run, "."), READ_TRACKED); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("job build step 1");
    expect((error as Error).message).toContain(line);
  }, 30_000);

  it("refuses the unrelated-copy and raw-prefix probe", () => {
    expect(() => assertNpmCiLockfilesRead(workflowStep(
      "cp ../good/package-lock.json /tmp/dummy/package-lock.json\nnpm ci --prefix ../unread",
    ), READ_TRACKED)).toThrow(/job build step 1.*run line containing npm is refused unless/);
  });

  it.each([
    "npm ci --prefix ../good",
    "npm --prefix ../good ci",
    'npm "ci" --prefix ../good',
    "npm \\\nci --prefix ../good",
    "sfw npm ci --prefix=../good",
    "npm ci -C ../good",
    "npm ci --pref ../good",
    "source ../move.sh\nnpm ci",
    ". ../move.sh\nnpm ci",
    "npm run prepare-lock\nnpm ci",
    "cp ../good/package-lock.json package-lock.json\nnpm ci",
    "mv ../good/package-lock.json package-lock.json\nnpm ci",
    "ln ../good/package-lock.json package-lock.json\nnpm ci",
    "install ../good/package-lock.json package-lock.json\nnpm ci",
    "tee package-lock.json\nnpm ci",
    "echo replacement > package-lock.json\nnpm ci",
    "npm ci\necho replacement >> npm-shrinkwrap.json",
  ])("refuses literal npm ci command words outside the helper: %s", (run) => {
    expect(() => assertNpmCiLockfilesRead(workflowStep(run), READ_TRACKED)).toThrow(/job build step 1: cannot establish the npm ci directory:/);
  }, 30_000);

  it("uses workflow and job defaults with step working-directory taking precedence", () => {
    const run = "bash scripts/npm-ci-tracked-lock.sh --via npm --in-place plugins/good";
    const withoutStepDir = workflowStep(run).replace(
      "      - working-directory: plugins/read\n        run: |", "      - run: |",
    );
    expect(assertNpmCiLockfilesRead(
      `defaults:\n  run:\n    working-directory: .\n${withoutStepDir}`, READ_TRACKED,
    )).toBe(1);
    const jobDefault = withoutStepDir.replace(
      "    steps:", "    defaults:\n      run:\n        working-directory: .\n    steps:",
    );
    expect(assertNpmCiLockfilesRead(
      `defaults:\n  run:\n    working-directory: plugins/unread\n${jobDefault}`, READ_TRACKED,
    )).toBe(1);
    const stepOverride = workflowStep(run, ".").replace(
      "    steps:", "    defaults:\n      run:\n        working-directory: plugins/unread\n    steps:",
    );
    expect(assertNpmCiLockfilesRead(stepOverride, READ_TRACKED)).toBe(1);
  }, 30_000);

  it.each(["cd ../good && npm ci", "cd plugins/x && npm ci", "cd ../unread && npm ci"])(
    "refuses a leading cd before literal npm ci command words: %s", (run) => {
      expect(() => assertNpmCiLockfilesRead(workflowStep(run), READ_TRACKED)).toThrow(/run line containing npm is refused unless/);
    }, 5_000,
  );

  it.each([
    'cd "$DIR" && npm ci',
    "cd $(pwd) && npm ci",
    "pushd ../good\nnpm ci",
    "popd\nnpm ci",
    "(cd ../good && npm ci)",
    "{ cd ../good && npm ci; }",
    "if true; then npm ci; fi",
    "case x in x) npm ci;; esac",
    "cd ../../../outside && npm ci",
    "cd ../good\nnpm ci",
    "cd a && cd b && npm ci",
    "cd ../good && npm ci\nnpm ci",
    "cd ../good && npm ci\ncd ../read && npm ci",
    "cd - && npm ci",
    "cd 'a # b' && npm ci",
    "cd a; cd b && npm ci",
    "cd ../unread || cd ../good && npm ci",
  ])("refuses an unestablished npm ci directory: %s", (run) => {
    expect(() => assertNpmCiLockfilesRead(workflowStep(run), READ_TRACKED)).toThrow(
      /job build step 1: cannot establish the npm ci directory/,
    );
  }, 30_000);
});

describe("the workflow guard checks physical lines containing npm", () => {
  const WORKFLOW = "workflow-a";
  it.each(["npm c\\i", "'npm' ci", '"npm" ci'])(
    "refuses the escaped or quoted raw npm ci spelling: %s", (run) => {
      expect(() => assertNpmCiLockfilesRead(workflowStep(run), READ_TRACKED, WORKFLOW)).toThrow(
        `workflow ${WORKFLOW} job build step 1: cannot establish the npm ci directory: a run line containing npm is refused unless the whole line is an exact allowlist entry in test/helpers/npm-ci-workflow-guard.ts (add one with its reason), a tracked-lock helper call, or the bounded global tool install: ${run} (physical line 1)`,
      );
    }, 5_000,
  );

  it.each(["$(which npm) ci", "env npm ci"])(
    "refuses an unresolvable command word: %s", (run) => {
      let error: unknown;
      try { assertNpmCiLockfilesRead(workflowStep(run), READ_TRACKED, WORKFLOW); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(`workflow ${WORKFLOW} job build step 1`);
      expect(message).toContain("line 1");
      expect(message).toContain(run);
    }, 5_000,
  );

  it("accepts a line without the characters npm", () => {
    expect(assertNpmCiLockfilesRead(workflowStep('"$TOOL" ci'), READ_TRACKED, WORKFLOW)).toBe(0);
    expect(assertNpmCiLockfilesRead(workflowStep('"$TOOL" "$SUB"'), READ_TRACKED, WORKFLOW)).toBe(0);
  }, 5_000);
});

describe("the workflow guard refuses conservative install-like spellings", () => {
  const WORKFLOW = "workflow-b";
  it.each([
    "{npm,} ci",
    "$'npm' $'ci'",
    'npm "$SUB"',
    'printf "%s" "$(npm ci)"',
    "out=$(npm ci)",
    "bash -c 'npm ci'",
    "npm </dev/null ci",
    "printf \"%s\" \"x\\\" # y\"; 'npm' ci",
    "printf '%s\\n' 'starts here\n'npm' ci",
    "$(case x in x) printf npm;; esac) ci",
    'printf \'%s\' "\\`$(npm ci)\\`"',
    "printf '%s' '\\`'; npm ci",
    "printf '%s' '\\`' ; npm `printf i`",
    "npm install -g tool@1.2.3 --registry=https://a/$REG",
  ])("refuses the install-like spelling: %s", (run) => {
    expect(() => assertNpmCiLockfilesRead(workflowStep(run), READ_TRACKED, WORKFLOW)).toThrow(
      new RegExp(`workflow ${WORKFLOW} job build step 1: cannot establish the npm ci directory`),
    );
  }, 5_000);

  it("shows real bash runs the brace, ANSI-C, redirection and substitution spellings through npm", () => {
    const stubDir = mkdtempSync(join(tmpdir(), "npm-stub-"));
    try {
      const argvFile = join(stubDir, "argv");
      writeFileSync(join(stubDir, "npm"), '#!/bin/sh\nprintf "%s" "$*" > "$STUB_ARGV"\n', { mode: 0o755 });
      for (const [line, expected] of [
        ["{npm,} ci", "ci"],
        ["$'npm' $'ci'", "ci"],
        ["npm </dev/null ci", "ci"],
        ['printf "%s" "$(npm ci)"', "ci"],
        ['printf \'%s\' "\\`$(npm ci)\\`"', "ci"],
        ["printf '%s' '\\`'; npm ci", "ci"],
        ["printf '%s' '\\`' ; npm `printf i`", "i"],
      ] as const) {
        rmSync(argvFile, { force: true });
        const result = spawnSync("bash", ["-c", line], {
          env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}`, STUB_ARGV: argvFile },
          encoding: "utf8",
          timeout: 5_000,
        });
        expect(result.status).toBe(0);
        expect(readFileSync(argvFile, "utf8")).toBe(expected);
      }
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("shows real bash splits a registry expansion into separate npm options", () => {
    const stubDir = mkdtempSync(join(tmpdir(), "npm-stub-"));
    try {
      const argvFile = join(stubDir, "argv");
      writeFileSync(join(stubDir, "npm"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$STUB_ARGV"\n', { mode: 0o755 });
      const result = spawnSync("bash", ["-c", "npm install -g tool@1.2.3 --registry=https://a/$REG"], {
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH ?? ""}`,
          STUB_ARGV: argvFile,
          REG: "x --global=false --prefix=plugins/unread tool@latest",
        },
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.status).toBe(0);
      expect(readFileSync(argvFile, "utf8").trim().split("\n")).toEqual([
        "install", "-g", "tool@1.2.3", "--registry=https://a/x",
        "--global=false", "--prefix=plugins/unread", "tool@latest",
      ]);
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  }, 15_000);

  it.each([
    "npm install -g npm@11.21.1 --registry=https://registry.npmjs.org",
    "npm install --global @scope/tool@1.2.3",
  ])("accepts an exact global tool install: %s", (run) => {
    expect(assertNpmCiLockfilesRead(workflowStep(run), READ_TRACKED, WORKFLOW)).toBe(0);
  }, 5_000);

  it.each([
    "npm install -g npm",
    "npm install -g npm@^11.21.1",
    "npm install -g npm@latest",
    "npm install -g npm@11.21.1 --registry=https://registry.npmjs.org extra",
    "npm install -g tool@1.2.3-..",
  ])("refuses a global install outside the exact pinned shape: %s", (run) => {
    expect(() => assertNpmCiLockfilesRead(workflowStep(run), READ_TRACKED, WORKFLOW)).toThrow(/run line containing npm is refused unless/);
  }, 5_000);
});

const npmRequire = createRequire(import.meta.url);
const npmAvailable = Bun.which("npm") !== null;

it("validates TPS_TEST_REQUIRE_NPM and requires npm on PATH when set", () => {
  const value = process.env.TPS_TEST_REQUIRE_NPM;
  if (value !== undefined && value !== "1") {
    throw new Error(`invalid TPS_TEST_REQUIRE_NPM=${JSON.stringify(value)}; expected unset or 1`);
  }
  if (value === "1" && !npmAvailable) {
    throw new Error("TPS_TEST_REQUIRE_NPM=1 requires executable npm on PATH");
  }
});

/** Locate a module npm itself bundles, preferring npm's global root. */
function npmBundledModule(name: string): string {
  const candidates: string[] = [];
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).trim();
  if (root !== "") candidates.push(join(root, "npm", "node_modules", name));
  const npmBin = execFileSync("which", ["npm"], { encoding: "utf8", timeout: 10_000 }).trim();
  if (npmBin !== "") {
    const real = realpathSync(npmBin);
    candidates.push(join(dirname(real), "..", "node_modules", name));
    candidates.push(join(dirname(real), "..", "..", "node_modules", name));
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`npm's bundled ${name} was not found; looked under: ${candidates.join(", ")}`);
}

/** Run a shell line with a stub npm that records its argv. */
function runWithStubNpm(script: string, extraEnv: Record<string, string> = {}): string[] {
  const stubDir = mkdtempSync(join(tmpdir(), "npm-stub-"));
  try {
    const argvFile = join(stubDir, "argv");
    writeFileSync(join(stubDir, "npm"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$STUB_ARGV"\n', { mode: 0o755 });
    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}`, STUB_ARGV: argvFile, ...extraEnv },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.status).toBe(0);
    return readFileSync(argvFile, "utf8").trim().split("\n");
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

describe("the physical-line whitelist refuses folded and quoted comment spellings", () => {
  const WORKFLOW = "workflow-c";

  it("refuses both comment counterexamples and shows real bash runs npm in each", () => {
    const commentContinuation = "# comment \\\nnpm ci";
    const quotedComment = 'echo "\n# $(npm ci)\n"';
    let error: unknown;
    try { assertNpmCiLockfilesRead(workflowStep(commentContinuation), READ_TRACKED, WORKFLOW); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`workflow ${WORKFLOW} job build step 1`);
    expect((error as Error).message).toContain("npm ci (physical line 2)");
    expect(() => assertNpmCiLockfilesRead(workflowStep(quotedComment), READ_TRACKED, WORKFLOW)).toThrow(
      /physical line 2/,
    );
    for (const line of [commentContinuation, quotedComment]) {
      expect(runWithStubNpm(line)).toEqual(["ci"]);
    }
  }, 15_000);
});

it.each([
  ['SUB=ci; echo npm; npm "$SUB"', "ci"],
  ["echo npm; npm i", "i"],
  ["{npm,} i", "i"],
  ["npm ci # npm-ci-tracked-lock.sh", "ci"],
])("refuses a physical line and verifies Bash invokes npm: %s", (run, argument) => {
  expect(() => assertNpmCiLockfilesRead(workflowStep(`echo ready\n${run}`), READ_TRACKED, "workflow-r6")).toThrow(
    /workflow workflow-r6 job build step 1.*physical line 2/,
  );
  expect(runWithStubNpm(run).at(-1)).toBe(argument);
}, 15_000);

describe("the workflow guard bounds global tool versions", () => {
  const WORKFLOW = "workflow-v";
  const refused = [
    "npm install -g tool@9007199254740992.2.3",
    "npm install -g tool@1.2.3-rc.1",
    "npm install -g tool@1.2.3+b",
    "npm install -g tool@01.2.3",
    "npm install -g tool@1.2.3-..",
    "npm install -g tool@1.2.3 --registry=https://:",
  ];

  it.each(refused)("refuses a global install outside the bounded exact shape: %s", (run) => {
    expect(() => assertNpmCiLockfilesRead(workflowStep(run), READ_TRACKED, WORKFLOW)).toThrow(/run line containing npm is refused unless/);
  }, 5_000);

  it.skipIf(!npmAvailable)("accepts tool@1.2.3 and checks every refused spec against npm's own parser (needs npm on PATH)", () => {
    expect(assertNpmCiLockfilesRead(workflowStep("npm install -g tool@1.2.3"), READ_TRACKED, WORKFLOW)).toBe(0);
    const npa = npmRequire(npmBundledModule("npm-package-arg")) as {
      resolve: (name: string, spec: string) => { type: string };
    };
    const bounded = (spec: string): boolean =>
      /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/.test(spec);
    expect(npa.resolve("tool", "1.2.3").type).toBe("version");
    for (const run of refused) {
      const spec = run.slice(run.lastIndexOf("@") + 1);
      const parsed = npa.resolve("tool", spec);
      expect(parsed.type !== "version" || !bounded(spec)).toBe(true);
    }
  }, 15_000);
});

describe("the test checks guard refusals against npm's bundled nopt", () => {
  it.skipIf(!npmAvailable)("shows the expanded registry arguments change global and prefix (needs npm on PATH)", () => {
    const expanded = runWithStubNpm("npm install -g tool@1.2.3 --registry=https://a/$REG", {
      REG: "x --global=false --prefix=plugins/unread tool@latest",
    });
    expect(expanded).toEqual([
      "install", "-g", "tool@1.2.3", "--registry=https://a/x",
      "--global=false", "--prefix=plugins/unread", "tool@latest",
    ]);
    const nopt = npmRequire(npmBundledModule("nopt")) as (
      types: Record<string, unknown>,
      shorthands: Record<string, string[]>,
      args: string[],
      slice: number,
    ) => Record<string, unknown>;
    const types = { global: [Boolean, false], prefix: [String, ""], registry: [String, ""] };
    const shorthands = { g: ["--global"] };
    const base = nopt(types, shorthands, ["install", "-g", "tool@1.2.3", "--registry=https://a/x"], 0);
    const parsed = nopt(types, shorthands, expanded, 0);
    expect(base.global).toBe(true);
    expect(base.prefix).not.toBe("plugins/unread");
    expect(parsed.global).toBe(false);
    expect(parsed.prefix).toBe("plugins/unread");
  }, 15_000);
});

describe("the exact-line allowlist", () => {
  it("matches every entry to a real workflow line", () => {
    const workflowLines: string[] = [];
    const workflowsDir = join(REPO, ".github", "workflows");
    for (const name of readdirSync(workflowsDir).filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))) {
      const workflow = parseWorkflow(readFileSync(join(workflowsDir, name), "utf8"));
      for (const job of Object.values(workflow.jobs ?? {})) {
        for (const step of job.steps) {
          if (step.run === undefined) continue;
          for (const line of step.run.split(/\r?\n/)) {
            const text = line.trim();
            if (text !== "") workflowLines.push(text);
          }
        }
      }
    }
    expect(EXACT_LINE_ALLOWLIST.length).toBeGreaterThan(0);
    for (const entry of EXACT_LINE_ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(workflowLines.filter((line) => line === entry.text).length).toBeGreaterThan(0);
    }
  }, 30_000);
});
