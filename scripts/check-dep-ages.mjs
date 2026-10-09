#!/usr/bin/env node
/**
 * check-dep-ages.mjs — dependency release-age gate (cli#529).
 *
 * Checks every external version in bun.lock against bunfig.toml's minimumReleaseAge,
 * and that every minimumReleaseAgeExcludes name has an unexpired entry in
 * docs/dep-age-exceptions.md and is pinned exactly wherever a package.json
 * declares it.
 * TPS_DEP_AGES_ROOT and TPS_DEP_AGES_REGISTRY select fixture inputs outside --ci.
 * --ci refuses root and registry overrides.
 *
 * Exit codes:
 *   0 — every external resolved version is at least the gate old (or a valid
 *       exception covers it), and every install-time exclude is covered
 *   1 — all required publish times are available and an uncovered version is too fresh
 *   2 — missing publish times, unreadable or unparseable required files,
 *       missing or invalid threshold, invalid or unused exceptions, an excluded
 *       name without an unexpired exception or without an exact pin, no external
 *       resolutions, refused CI overrides, unexpected arguments, or registry fetch failures
 *
 */

import { readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditExcludes,
  collectResolvedDeps,
  evaluateAges,
  parseBunLock,
  parseExceptions,
  parseMinReleaseAgeExcludes,
  parseMinReleaseAgeSeconds,
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

// Bound the walk so a malformed tree cannot scan without limit. The repository
// has a handful of package.json files; a symlinked directory is skipped (it is
// never a directory entry) so a link cycle cannot keep the walk going.
const MAX_PACKAGE_JSON = 2000;

/**
 * Every package.json under `root` (skipping node_modules and .git), read and
 * parsed. A file that cannot be read or parsed refuses with exit 2: a manifest
 * this check cannot inspect must not read as "declares nothing".
 */
function collectPackageJsons(root) {
  const out = [];
  const pending = [""];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch (err) {
      console.error(`check-dep-ages: cannot list ${join(root, dir)}: ${err?.code ?? err?.message ?? err}`);
      process.exit(2);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        pending.push(dir ? `${dir}${sep}${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name === "package.json") {
        const path = dir ? `${dir}${sep}${entry.name}` : entry.name;
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

// ── Gate value, from the same bunfig.toml the install-time gate uses ────────
const bunfigText = readOrExit(join(ROOT, "bunfig.toml"), "bunfig.toml");
const gateSeconds = parseMinReleaseAgeSeconds(bunfigText);
if (gateSeconds === null || !Number.isFinite(gateSeconds) || gateSeconds < 0) {
  console.error(
    "check-dep-ages: bunfig.toml has no valid [install] minimumReleaseAge — refusing, because the gate has no threshold to enforce.",
  );
  process.exit(2);
}
const gateDays = gateSeconds / (24 * 60 * 60);

// ── Install-time excludes, from the same array the install-time gate uses ────
const { names: excludeNames, error: excludeParseError } = parseMinReleaseAgeExcludes(bunfigText);
if (excludeParseError !== null) {
  console.error(`check-dep-ages: bunfig.toml [install] minimumReleaseAgeExcludes is malformed: ${excludeParseError}`);
  console.error("Refusing, because an unreadable exclude list must not read as an empty one.");
  process.exit(2);
}

// ── Exceptions ─────────────────────────────────────────────────────────────
const { entries: exceptionEntries, errors: exceptionErrors } = parseExceptions(
  readOrExit(EXCEPTIONS_PATH, "docs/dep-age-exceptions.md"),
);

// ── Every exclude must have an unexpired exception and an exact pin ──────────
// An exclusion admits one fresh version past the install-time gate; the dated
// entry in docs/dep-age-exceptions.md is what bounds it. Without the entry the
// exclusion has no expiry, and with a range instead of an exact pin it would
// keep admitting later versions after the exception lapses.
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
