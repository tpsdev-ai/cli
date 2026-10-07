/**
 * test/check-dep-ages.test.ts — the dependency release-age gate (cli#529).
 *
 * Pure-function cases run against literal inputs. The CLI cases spawn
 * `node scripts/check-dep-ages.mjs` with an explicit env, pointed at a fixture
 * repo and (where the gate gets past parsing) a fixture registry served from
 * this process, so no case touches the real npm registry. The script path is
 * derived from this file's location, never the working directory, and a broken
 * setup throws before the CLI runs — it can never pass as the exit a case
 * expects.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectResolvedDeps,
  evaluateAges,
  parseBunLock,
  parseExceptions,
  parseMinReleaseAgeSeconds,
} from "../scripts/lib/check-dep-ages-collect.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI_SCRIPT = join(REPO, "scripts", "check-dep-ages.mjs");

/** A broken test setup fails as itself, never as the CLI exit a case expects. */
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

describe("evaluateAges", () => {
  const day = 24 * 60 * 60 * 1000;
  const gateSeconds = 7 * 24 * 60 * 60;
  const deps = [
    { name: "old", version: "1.0.0" },
    { name: "young", version: "2.0.0" },
    { name: "known-only", version: "3.0.0" },
  ];
  const publishTimes = new Map([
    ["old@1.0.0", NOW - 100 * day],
    ["young@2.0.0", NOW - 1 * day],
  ]);

  it("flags a young version with no exception and passes an older one", () => {
    const r = evaluateAges({
      deps,
      publishTimes,
      gateSeconds,
      nowMs: NOW,
      exceptionEntries: new Map(),
    });
    expect(r.uncovered.map((d) => `${d.name}@${d.version}`)).toEqual(["young@2.0.0"]);
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
    expect(r.uncovered).toEqual([]);
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
  opts: { minAge?: number | null; lock?: string; exceptions?: string } = {},
): string {
  mkdirSync(join(root, "docs"), { recursive: true });
  const minAge = opts.minAge === undefined ? 604800 : opts.minAge;
  writeFileSync(
    join(root, "bunfig.toml"),
    minAge === null ? '[test]\npreload = ["./x.ts"]\n' : `[install]\nminimumReleaseAge = ${minAge}\n`,
  );
  writeFileSync(join(root, "bun.lock"), opts.lock ?? FIXTURE_LOCK);
  if (opts.exceptions !== undefined) {
    writeFileSync(join(root, "docs", "dep-age-exceptions.md"), opts.exceptions);
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

const ISO_NOW = new Date(NOW).toISOString();
const FUTURE = new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

  it("refuses the fixture-root override under the CI flag", async () => {
    const root = writeFixtureRepo(join(scratch, "ci"), { exceptions: "## Exceptions\n" });
    const { exitCode, output } = await runGate(
      { TPS_DEP_AGES_ROOT: root, TPS_DEP_AGES_REGISTRY: "http://127.0.0.1:1" },
      ["--ci"],
    );
    expect(output).toContain("TPS_DEP_AGES_ROOT");
    expect(exitCode).toBe(2);
  }, 30_000);

  it("refuses an unknown argument before scanning", async () => {
    const { exitCode, output } = await runGate({}, ["--c1"]);
    expect(output).toContain("--c1");
    expect(output).toContain("--ci");
    expect(exitCode).toBe(2);
  }, 30_000);
});
