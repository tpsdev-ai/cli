/**
 * check-dep-ages-collect.mjs — pure logic for the dependency release-age gate.
 *
 * Exported for scripts/check-dep-ages.mjs (the CLI, run by CI) and for
 * test/check-dep-ages.test.ts. Nothing here touches the filesystem or the
 * network, so its logic is exercised by tests over literal inputs.
 *
 */

/**
 * Read `[install] minimumReleaseAge` (seconds) from a bunfig.toml body.
 *
 * @returns the number of seconds, or null when the key is absent (the caller
 *   refuses rather than assume a threshold).
 */
export function parseMinReleaseAgeSeconds(tomlText) {
  let section = "";
  for (const raw of String(tomlText).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== "install") continue;
    const m = line.match(/^minimumReleaseAge\s*=\s*"?(\d+)"?\s*$/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Parse bun.lock. It is JSON with trailing commas (bun writes JSONC), which
 * JSON.parse rejects, so drop a comma that is followed only by whitespace and
 * a closing brace/bracket — a comma inside a string is left alone.
 */
export function parseBunLock(text) {
  let cleaned = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      cleaned += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue; // trailing comma
    }
    cleaned += ch;
  }
  return JSON.parse(cleaned);
}

/**
 * The external, resolved (name, version) pairs in a parsed bun.lock.
 *
 * A `packages` entry is `["name@version", …]`; its key is the bare name at the
 * root or `parent/name` for a nested copy, so the spec in the value is the
 * one to split. Deduplicated by `name@version` — several keys can carry the
 * same resolution.
 *
 * @returns Array<{name: string, version: string}>
 */
export function collectResolvedDeps(lock) {
  const out = new Map();
  const packages = lock && typeof lock === "object" ? lock.packages : null;
  if (!packages || typeof packages !== "object") return [];
  for (const value of Object.values(packages)) {
    if (!Array.isArray(value) || typeof value[0] !== "string") continue;
    const spec = value[0];
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    if (!name || !version) continue;
    if (version.startsWith("workspace:")) continue; // local workspace link
    out.set(`${name}@${version}`, { name, version });
  }
  return [...out.values()];
}

/**
 * The semver grammar the exception gate accepts, shared with the exact-pin
 * check so both read a version the same way.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * Parse entries after `## Exceptions`; validate every subsequent nonblank line.
 * Expiry dates include their UTC day.
 *
 * @returns {{ entries: Map<string, {expires: string, reason: string, line: number}>,
 *             errors: Array<{line: number, text: string, message: string, key: string | null}> }}
 *   A rejected line that still carried a `name@version` token reports it as
 *   `key`, so a caller can tell which package an expired or invalid entry named.
 */
export function parseExceptions(text, nowMs = Date.now()) {
  const entries = new Map();
  const errors = [];
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const lines = String(text).split(/\r?\n/);
  const HEADING = /^## Exceptions$/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (HEADING.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    return {
      entries,
      errors: [
        {
          line: 0,
          text: "",
          message: "no `## Exceptions` heading — the exception list could not be located",
        },
      ],
    };
  }
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const line = i + 1;
    const m = t.match(
      /^-\s+(\S+@\S+)\s*\|\s*expires:(\d{4}-\d{2}-\d{2})\s*\|\s*reason:\s*(\S.*)$/,
    );
    if (!m) {
      errors.push({
        line,
        text: t,
        key: null,
        message:
          "malformed exception: expected `- name@version | expires:YYYY-MM-DD | reason: ...`",
      });
      continue;
    }
    const [, key, date, reason] = m;
    const version = key.slice(key.lastIndexOf("@") + 1);
    if (!SEMVER_RE.test(version)) {
      errors.push({ line, text: t, key, message: `invalid semver: ${key}` });
      continue;
    }
    // `Date.parse` accepts rollovers (2026-02-30 → 2026-03-02), so round-trip
    // the date to reject one that is not a real calendar day.
    const parsed = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
      errors.push({ line, text: t, key, message: `invalid expiry date: ${date}` });
      continue;
    }
    if (date < today) {
      errors.push({ line, text: t, key, message: `exception expired on ${date}` });
      continue;
    }
    entries.set(key, { expires: date, reason: reason.trim(), line });
  }
  return { entries, errors };
}

/**
 * Split the resolved deps into: young (published within the gate), uncovered
 * young (young with no valid exception — what fails the gate), covered young,
 * and missing (no publish time was available for the pair).
 *
 * A pair is young when its publish time is strictly after `now - gateSeconds`.
 * A pair exactly at the threshold is old enough.
 *
 * @param deps Array<{name, version}>
 * @param publishTimes Map<"name@version", epoch-ms>
 * @param exceptionEntries Map<"name@version", {expires, reason}>
 * @returns {{ young, uncovered, covered, missing }}
 */
export function evaluateAges({ deps, publishTimes, gateSeconds, nowMs, exceptionEntries }) {
  const cutoff = nowMs - gateSeconds * 1000;
  const young = [];
  const covered = [];
  const uncovered = [];
  const missing = [];
  for (const dep of deps) {
    const key = `${dep.name}@${dep.version}`;
    const publishedAt = publishTimes.get(key);
    if (publishedAt === undefined) {
      missing.push(dep);
      continue;
    }
    if (publishedAt <= cutoff) continue;
    const exception = exceptionEntries.get(key) ?? null;
    const row = {
      ...dep,
      publishedAt,
      ageDays: (nowMs - publishedAt) / (24 * 60 * 60 * 1000),
      exception,
    };
    young.push(row);
    (exception ? covered : uncovered).push(row);
  }
  return { young, uncovered, covered, missing };
}

/** Read install exclusions with Bun's parser, or a restricted single-line fallback. */
export function parseMinReleaseAgeExcludes(tomlText) {
  const text = String(tomlText);
  const refuse = (detail) => ({
    names: [], error: `unparseable minimumReleaseAgeExcludes: ${detail}`,
  });
  if (globalThis.Bun?.TOML?.parse) {
    try {
      const names = globalThis.Bun.TOML.parse(text).install?.minimumReleaseAgeExcludes;
      if (names === undefined) return { names: [], error: null };
      if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
        return refuse("expected an array of strings");
      }
      return { names, error: null };
    } catch (err) {
      return refuse(err?.message ?? String(err));
    }
  }

  let section = "";
  let names;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      section = header[1].trim();
      if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(section)) {
        return refuse("unsupported table syntax without Bun.TOML.parse");
      }
      continue;
    }
    if (!line.includes("minimumReleaseAgeExcludes")) {
      if (/^["']/.test(line) || /^(?:install|["']install["'])\s*=/.test(line)) {
        return refuse("unsupported key or install table syntax without Bun.TOML.parse");
      }
      continue;
    }
    if (section !== "install") {
      if (section === "test" && /^minimumReleaseAgeExcludes\s*=/.test(line)) continue;
      return refuse("unsupported key or install table syntax without Bun.TOML.parse");
    }
    const match = line.match(/^minimumReleaseAgeExcludes\s*=\s*\[\s*((?:"[A-Za-z0-9@/_.-]*"\s*(?:,\s*"[A-Za-z0-9@/_.-]*"\s*)*,?\s*)?)\]\s*(?:#.*)?$/);
    if (!match || names !== undefined) {
      return refuse("unsupported or duplicate declaration without Bun.TOML.parse");
    }
    names = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  }
  return { names: names ?? [], error: null };
}

/** A bare version such as `4.7.10`; a range, tag or URL is not an exact pin. */
export function isExactVersionPin(spec) {
  return typeof spec === "string" && SEMVER_RE.test(spec.trim());
}

/** The package name in an `name@version` key (`@scope/pkg@1.2.3` keeps its scope). */
function exceptionName(key) {
  return key.slice(0, key.lastIndexOf("@"));
}

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"];

/**
 * Check bunfig's install-time excludes against the dated exceptions and the
 * exact pins in the repository's package.json files.
 *
 * @param {{ excludes: string[], exceptionEntries: Map<string, object>,
 *           exceptionErrors: Array<{key: string | null, message: string}>,
 *           packageJsons: Array<{path: string, json: object}> }}
 * @returns Array<{kind: "uncovered", name: string,
 *                 error: {message: string} | null}
 *             | {kind: "range", name: string, path: string, spec: string}>
 */
export function auditExcludes({ excludes, exceptionEntries, exceptionErrors, packageJsons }) {
  const problems = [];
  for (const name of excludes ?? []) {
    let covered = false;
    for (const key of (exceptionEntries ?? new Map()).keys()) {
      if (exceptionName(key) === name) {
        covered = true;
        break;
      }
    }
    if (!covered) {
      const error =
        (exceptionErrors ?? []).find(
          (e) => typeof e?.key === "string" && exceptionName(e.key) === name,
        ) ?? null;
      problems.push({ kind: "uncovered", name, error });
    }
    for (const pj of packageJsons ?? []) {
      for (const field of DEP_FIELDS) {
        const deps = pj.json?.[field];
        if (!deps || typeof deps !== "object" || !Object.hasOwn(deps, name)) continue;
        const spec = deps[name];
        if (!isExactVersionPin(spec)) problems.push({ kind: "range", name, path: pj.path, spec });
      }
    }
  }
  return problems;
}
