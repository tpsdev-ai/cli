/**
 * test/check-dep-ages.test.ts — the dependency release-age gate (cli#529).
 *
 * Pure-function cases use literal inputs. CLI cases spawn
 * `node scripts/check-dep-ages.mjs` with an explicit env. Missing script or lock
 * files and an unbound fixture registry throw before the CLI runs.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import {
  auditExcludes,
  collectResolvedDeps,
  evaluateAges,
  excludesFromInstallTable,
  isExactVersionPin,
  parseBunLock,
  parseExceptions,
  parseMinReleaseAgeSeconds,
} from "../scripts/lib/check-dep-ages-collect.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI_SCRIPT = join(REPO, "scripts", "check-dep-ages.mjs");

function setupFailure(what: string): never {
  throw new Error(`test setup failed before the gate ran: ${what}`);
}

const NOW = Date.parse("2026-10-07T00:00:00Z");

/* ────────────────────────────── pure functions ───────────────────────────── */

describe("parseMinReleaseAgeSeconds", () => {
  it("reads the value CI installs with from this repo's bunfig.toml", () => {
    const value = parseMinReleaseAgeSeconds(readFileSync(join(REPO, "bunfig.toml"), "utf8"));
    expect(value).toBe(604800); // 7 days, the value the fragment and docs cite
  });

  it("ignores the key in another section and handles spacing, quotes and comments", () => {
    expect(parseMinReleaseAgeSeconds('[install]\nminimumReleaseAge = 259200\n')).toBe(259200);
    expect(parseMinReleaseAgeSeconds('[install]\nminimumReleaseAge="86400" # one day\n')).toBe(86400);
    expect(parseMinReleaseAgeSeconds('[test]\nminimumReleaseAge = 1\n')).toBeNull();
  });

  it("returns null when the key is absent", () => {
    expect(parseMinReleaseAgeSeconds('[test]\npreload = ["./x.ts"]\n')).toBeNull();
    expect(parseMinReleaseAgeSeconds("")).toBeNull();
  });
});

describe("excludesFromInstallTable", () => {
  const read = (text: string) => excludesFromInstallTable(Bun.TOML.parse(text).install);

  it("reads this repo's install-time exclude list", () => {
    const { names, error } = read(readFileSync(join(REPO, "bunfig.toml"), "utf8"));
    expect(error).toBeNull();
    expect(names).toEqual(["handlebars"]);
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
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

describe("CLI — the current lockfile passes", () => {
  it("exits 0 on this repo's bun.lock when every resolved version is old enough", async () => {
    // Serve the real lockfile's resolved versions with a fixed old publish
    // time, so the case is deterministic and offline yet still reads the real
    // bun.lock through the real collect path.
    const lock = parseBunLock(readFileSync(join(REPO, "bun.lock"), "utf8"));
    const deps = collectResolvedDeps(lock);
    if (deps.length < 100) setupFailure(`expected the real lockfile to resolve >100 packages, got ${deps.length}`);
    const times: Record<string, Record<string, string>> = {};
    for (const d of deps) {
      times[d.name] = { ...(times[d.name] ?? {}), [d.version]: "2020-01-01T00:00:00.000Z" };
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
    expect(output).toContain("no valid [install] minimumReleaseAge");
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
        !line.trimStart().startsWith("#") && /\b(?:bun install|npm (?:ci|install))\b/.test(line),
      )) continue;
      installs++;
      expect(checkout).toBeGreaterThanOrEqual(0);
      expect(gate).toBeGreaterThan(checkout);
      expect(gate).toBeLessThan(index);
    }
  }
  expect(installs).toBeGreaterThan(0);
}

it("runs the lock gate before every install step in the CI workflow", () => {
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
