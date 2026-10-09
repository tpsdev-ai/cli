#!/usr/bin/env node
/**
 * check-dep-ages.mjs — dependency release-age gate (cli#529).
 *
 * Reads bunfig.toml's install table with Bun's TOML parser. Checks every external
 * version in bun.lock against its minimumReleaseAge (at least 7 days), and that
 * every minimumReleaseAgeExcludes name has an unexpired entry in
 * docs/dep-age-exceptions.md and at least one exact declaration; every
 * declaration must be exact, an override must be in the root package.json, and
 * a resolutions key of `name` or `**\/name` is refused.
 * TPS_DEP_AGES_ROOT and TPS_DEP_AGES_REGISTRY select fixture inputs outside --ci.
 * --ci refuses root and registry overrides.
 *
 * Exit codes:
 *   0 — every external resolved version is at least the gate old (or a valid
 *       exception covers it), and every excluded name Bun reads has an unexpired entry,
 *       exact declarations, no override in a nested package.json, and no resolutions key naming it
 *   1 — all required publish times are available and an uncovered version is too fresh
 *   2 — missing publish times, unreadable or unparseable required files, Bun not
 *       runnable or rejecting bunfig.toml, a missing, non-numeric or negative threshold
 *       or one below 7 days, invalid or unused exceptions, an excluded name without an
 *       unexpired exception or without exact declarations, an excluded name in a nested
 *       package.json's overrides or as a resolutions key, no external resolutions, refused
 *       CI overrides, unexpected arguments, or registry fetch failures
 *
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditExcludes,
  collectResolvedDeps,
  evaluateAges,
  excludesFromInstallTable,
  parseBunLock,
  parseExceptions,
  thresholdFromInstallTable,
} from "./lib/check-dep-ages-collect.mjs";

const ARGS = process.argv.slice(2);
const IS_CI_GATE = ARGS.length === 1 && ARGS[0] === "--ci";
if (ARGS.length > 0 && !IS_CI_GATE) {
  console.error(`check-dep-ages: unexpected argument(s): ${ARGS.join(" ")}`);
  console.error("Accepted: no arguments, or exactly --ci (the CI gate's own flag).");
  process.exit(2);
}

const ROOT_OVERRIDE = process.env.TPS_DEP_AGES_ROOT;
// A PRESENCE test, not a truthiness test: an empty value would otherwise slip
// through and resolve the root to "". The CI gate scans the checked-out tree.
if (IS_CI_GATE && ROOT_OVERRIDE !== undefined) {
  console.error(
    "TPS_DEP_AGES_ROOT is present, but the CI gate must scan the checked-out repository.",
  );
  console.error(
    "Refusing to run. Unset TPS_DEP_AGES_ROOT: it is for tests, which point the gate at a fixture repository and do not pass --ci.",
  );
  process.exit(2);
}
const REGISTRY_OVERRIDES = [
  "TPS_DEP_AGES_REGISTRY",
  "npm_config_registry",
  "NPM_CONFIG_REGISTRY",
  "BUN_CONFIG_DEFAULT_REGISTRY",
  "BUN_CONFIG_REGISTRY",
];
if (IS_CI_GATE) {
  const present = REGISTRY_OVERRIDES.filter((name) => process.env[name] !== undefined);
  if (present.length > 0) {
    console.error(`check-dep-ages: Refusing ${present.join(", ")} under --ci; unset registry overrides.`);
    process.exit(2);
  }
}
const ROOT = ROOT_OVERRIDE ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = process.env.TPS_DEP_AGES_REGISTRY ?? "https://registry.npmjs.org";
const EXCEPTIONS_PATH = join(ROOT, "docs", "dep-age-exceptions.md");

function readOrExit(path, what) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    console.error(`check-dep-ages: cannot read ${what} (${path}): ${err?.code ?? err?.message ?? err}`);
    process.exit(2);
  }
}

// Bun parses the text from stdin in an empty directory with only PATH set, so the
// repository's bunfig.toml, and any preload it names, is not loaded by the parser.
const BUN_READ_INSTALL = `
let parsed;
try {
  parsed = Bun.TOML.parse(await Bun.stdin.text());
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(3);
}
process.stdout.write(JSON.stringify({ install: parsed.install ?? null }));
`;

/** bunfig's \`install\` table as Bun's TOML parser reads it; exits 2 when Bun cannot read it. */
function readInstallTableWithBun(text) {
  let cwd;
  let run;
  let detail = null;
  try {
    cwd = mkdtempSync(join(tmpdir(), "check-dep-ages-"));
    run = spawnSync("bun", ["-e", BUN_READ_INSTALL], {
      cwd,
      input: text,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    detail = `cannot run bun: ${err?.message ?? err}`;
  } finally {
    try {
      if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
    } catch (err) {
      detail ??= `cannot remove ${cwd}: ${err?.message ?? err}`;
    }
  }
  let out;
  if (detail === null) {
    if (run.error) {
      detail = `cannot run bun: ${run.error.code ?? run.error.message ?? run.error}`;
    } else if (run.status === 3) {
      detail = `the parser rejected it: ${String(run.stderr).trim()}`;
    } else if (run.status !== 0) {
      detail = `bun exited ${run.status ?? run.signal}: ${String(run.stderr).trim()}`;
    } else {
      try {
        out = JSON.parse(run.stdout);
      } catch {
        out = undefined;
      }
      if (out === null || typeof out !== "object" || !Object.hasOwn(out, "install")) {
        detail = "bun printed no parsed table";
      }
    }
  }
  if (detail !== null) {
    console.error(`check-dep-ages: cannot read bunfig.toml with Bun's TOML parser: ${detail}`);
    console.error(
      "Refusing, because the threshold and the exclusion list are read with Bun's parser. Put bun on PATH, or fix bunfig.toml.",
    );
    process.exit(2);
  }
  return out.install;
}

// The limit counts parsed package.json files, not directories or directory entries.
const MAX_PACKAGE_JSON = 2000;

/** Read manifests through in-root links; refuse unreadable or outside-root paths. */
function collectPackageJsons(root) {
  const out = [];
  const pending = [""];
  const visited = new Set();
  const realRoot = realpathSync(root);
  function inspect(path) {
    try {
      const real = realpathSync(join(root, path));
      const rel = relative(realRoot, real);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error("symlink resolves outside repository root");
      }
      return { real, stat: statSync(real) };
    } catch (err) {
      console.error(`check-dep-ages: cannot inspect ${path || root}: ${err?.message ?? err}`);
      process.exit(2);
    }
  }
  while (pending.length > 0) {
    const dir = pending.pop();
    const { real } = inspect(dir);
    if (visited.has(real)) continue;
    visited.add(real);
    let entries;
    try {
      entries = readdirSync(real, { withFileTypes: true });
    } catch (err) {
      console.error(`check-dep-ages: cannot list ${join(root, dir)}: ${err?.code ?? err?.message ?? err}`);
      process.exit(2);
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = dir ? `${dir}${sep}${entry.name}` : entry.name;
      const { stat } = inspect(path);
      if (stat.isDirectory()) {
        pending.push(path);
      } else if (stat.isFile() && entry.name === "package.json") {
        let json;
        try {
          json = JSON.parse(readFileSync(join(root, path), "utf8"));
        } catch (err) {
          console.error(`check-dep-ages: cannot parse ${path}: ${err?.message ?? err}`);
          process.exit(2);
        }
        out.push({ path, json });
        if (out.length > MAX_PACKAGE_JSON) {
          console.error(`check-dep-ages: more than ${MAX_PACKAGE_JSON} package.json files under the repository root — refusing.`);
          process.exit(2);
        }
      }
    }
  }
  return out;
}

// ── Gate value, as Bun's TOML parser reads bunfig.toml ──────────────────────
const installTable = readInstallTableWithBun(readOrExit(join(ROOT, "bunfig.toml"), "bunfig.toml"));
const { seconds: gateSeconds, error: thresholdError } = thresholdFromInstallTable(installTable);
if (thresholdError !== null) {
  console.error(`check-dep-ages: bunfig.toml has no valid [install] minimumReleaseAge: ${thresholdError}.`);
  console.error("Refusing, because the gate enforces the threshold Bun reads, and at least 7 days.");
  process.exit(2);
}
const gateDays = gateSeconds / (24 * 60 * 60);

// ── Install-time excludes, from the same parsed table ───────────────────────
const { names: excludeNames, error: excludeParseError } = excludesFromInstallTable(installTable);
if (excludeParseError !== null) {
  console.error(`check-dep-ages: bunfig.toml [install] minimumReleaseAgeExcludes is malformed: ${excludeParseError}`);
  console.error("Refusing, because an unreadable exclude list must not read as an empty one.");
  process.exit(2);
}

// ── Exceptions ─────────────────────────────────────────────────────────────
const { entries: exceptionEntries, errors: exceptionErrors } = parseExceptions(
  readOrExit(EXCEPTIONS_PATH, "docs/dep-age-exceptions.md"),
);

// ── Every name Bun excludes needs an unexpired exception and exact declarations ──
// Bun excludes by package name; the dated entry bounds how long CI accepts it.
if (excludeNames.length > 0) {
  const packageJsons = collectPackageJsons(ROOT);
  const problems = auditExcludes({
    excludes: excludeNames,
    exceptionEntries,
    exceptionErrors,
    packageJsons,
  });
  if (problems.length > 0) {
    console.error(
      "check-dep-ages: bunfig.toml [install] minimumReleaseAgeExcludes is not covered by docs/dep-age-exceptions.md and exact pins:",
    );
    console.error("");
    for (const problem of problems) {
      if (problem.kind === "uncovered") {
        const why = problem.error
          ? `its dated entry is invalid: ${problem.error.message}`
          : "no dated entry under `## Exceptions` names it";
        console.error(`    ${problem.name}: ${why}`);
        console.error(
          `        Remedy: add a valid \`- ${problem.name}@<resolved-version> | expires:YYYY-MM-DD | reason: ...\` line to docs/dep-age-exceptions.md, or remove \`${problem.name}\` from minimumReleaseAgeExcludes in bunfig.toml.`,
        );
      } else if (problem.kind === "nested-override") {
        console.error(
          `    ${problem.path}: \`${problem.name}\` is in overrides, which Bun applies from the root package.json, not from this file.`,
        );
        console.error(
          `        Remedy: move the override to the root package.json, or remove \`${problem.name}\` from minimumReleaseAgeExcludes in bunfig.toml.`,
        );
      } else if (problem.kind === "resolution") {
        console.error(
          `    ${problem.path}: \`${problem.name}\` is in resolutions (key \`${problem.key}\`); an excluded package is pinned with the root package.json's overrides.`,
        );
        console.error(
          `        Remedy: move the pin to the root package.json's overrides, or remove \`${problem.name}\` from minimumReleaseAgeExcludes in bunfig.toml.`,
        );
      } else if (problem.kind === "unpinned") {
        console.error(
          `    ${problem.name}: excluded but not pinned: declare it exactly, e.g. via overrides, or remove the exclude`,
        );
      } else {
        console.error(
          `    ${problem.path}: \`${problem.name}\` is declared as \`${problem.spec}\` — an excluded package must be pinned exactly (a bare version such as \`1.0.0\`).`,
        );
        console.error(
          `        Remedy: pin \`${problem.name}\` exactly in ${problem.path}, or remove \`${problem.name}\` from minimumReleaseAgeExcludes in bunfig.toml.`,
        );
      }
    }
    process.exit(2);
  }
}

if (exceptionErrors.length > 0) {
  console.error("check-dep-ages: docs/dep-age-exceptions.md has invalid entries:");
  for (const e of exceptionErrors) {
    const where = e.line ? `    line ${e.line}: ` : "    ";
    console.error(`${where}${e.message}`);
    if (e.text) console.error(`        ${e.text}`);
  }
  console.error("");
  console.error("An exception must carry a YYYY-MM-DD expiry that has not passed, and a reason.");
  process.exit(2);
}

// ── The resolved dependency set ─────────────────────────────────────────────
let lock;
try {
  lock = parseBunLock(readOrExit(join(ROOT, "bun.lock"), "bun.lock"));
} catch (err) {
  console.error(`check-dep-ages: bun.lock is not parseable: ${err?.message ?? err}`);
  process.exit(2);
}
const deps = collectResolvedDeps(lock);
const resolutions = new Set(deps.map(({ name, version }) => `${name}@${version}`));
const unusedExceptions = [...exceptionEntries].filter(([key]) => !resolutions.has(key));
if (unusedExceptions.length > 0) {
  for (const [key, entry] of unusedExceptions) {
    console.error(`check-dep-ages: line ${entry.line}: unused exception: ${key} — no resolution in bun.lock`);
  }
  process.exit(2);
}

if (deps.length === 0) {
  console.error("check-dep-ages: bun.lock resolves no external packages — refusing (a broken read must not read as a pass).");
  process.exit(2);
}

console.log(
  `Checking ${deps.length} external resolved versions against the ${gateDays}-day release-age gate...`,
);

// ── Publish times ───────────────────────────────────────────────────────────
function isRetryable(err) {
  const msg = String(err?.message ?? err);
  if (msg.startsWith("no publish time") || msg.startsWith("unparseable publish time")) return false;
  if (/^HTTP 4\d\d/.test(msg) && !/^HTTP 408/.test(msg) && !/^HTTP 429/.test(msg)) return false;
  return true;
}

async function fetchTimeMapOnce(name) {
  const url = `${REGISTRY}/${encodeURIComponent(name).replace(/^%40/, "@")}`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const time = body?.time;
  if (!time || typeof time !== "object") throw new Error("no time map");
  return time;
}

async function fetchTimeMap(name) {
  const attempts = 3;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetchTimeMapOnce(name);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts) break;
      await new Promise((r) => setTimeout(r, 200 * 2 ** (i - 1)));
    }
  }
  throw lastErr;
}

const nowMs = Date.now();
const publishTimes = new Map();
const fetchFails = [];
const names = [...new Set(deps.map((d) => d.name))];
const cursor = { i: 0 };
async function runFetches() {
  const workers = Array.from({ length: 10 }, async () => {
    while (cursor.i < names.length) {
      const name = names[cursor.i++];
      try {
        const time = await fetchTimeMap(name);
        for (const dep of deps) {
          if (dep.name !== name) continue;
          const iso = time[dep.version];
          if (typeof iso !== "string") continue; // falls through to "missing"
          const ms = Date.parse(iso);
          if (Number.isNaN(ms)) {
            fetchFails.push({ name, version: dep.version, error: `unparseable publish time: ${JSON.stringify(iso)}` });
            continue;
          }
          publishTimes.set(`${name}@${dep.version}`, ms);
        }
      } catch (err) {
        fetchFails.push({ name, error: String(err?.message ?? err) });
      }
    }
  });
  await Promise.all(workers);
}
await runFetches();

const { young, uncovered, covered, missing } = evaluateAges({
  deps,
  publishTimes,
  gateSeconds,
  nowMs,
  exceptionEntries,
});

// ── Report ──────────────────────────────────────────────────────────────────
if (fetchFails.length > 0 || missing.length > 0) {
  console.error("Failed to fetch publish times:");
  for (const f of fetchFails) console.error(`    ${f.name}${f.version ? `@${f.version}` : ""}: ${f.error}`);
  for (const d of missing) {
    if (!fetchFails.some((f) => f.name === d.name)) console.error(`    ${d.name}@${d.version}: no publish time in the registry response`);
  }
  console.error("");
  console.error("Treating as fail (closed). If the registry is genuinely down, retry; do not bypass.");
  process.exit(2);
}

if (uncovered.length > 0) {
  console.error(`External packages younger than the ${gateDays}-day release-age gate:`);
  console.error("");
  for (const f of uncovered.sort((a, b) => b.publishedAt - a.publishedAt)) {
    console.error(`    ${f.name}@${f.version}    — published ${f.ageDays.toFixed(1)} days ago (gate: >=${gateDays} days)`);
  }
  console.error("");
  console.error("To let one through: pin an older version, or add a dated entry to");
  console.error("docs/dep-age-exceptions.md naming that exact version and why.");
  process.exit(1);
}

if (covered.length === 0) {
  console.log(`All ${deps.length} external resolved versions are at least ${gateDays} days old.`);
} else {
  console.log(
    `${deps.length} external resolved versions checked; ${covered.length} younger than ${gateDays} days, allowed by a dated exception:`,
  );
  for (const c of covered.sort((a, b) => b.publishedAt - a.publishedAt)) {
    console.log(`    ${c.name}@${c.version} — until ${c.exception.expires}: ${c.exception.reason}`);
  }
}
