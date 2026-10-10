/**
 * check-dep-ages-collect.mjs — pure logic for the dependency release-age gate.
 *
 * Exported for scripts/check-dep-ages.mjs (the CLI, run by CI) and for
 * test/check-dep-ages.test.ts. Nothing here touches the filesystem or the
 * network, so its logic is exercised by tests over literal inputs.
 *
 */

/** The lowest threshold the gate accepts: cli#529 set a 7-day gate. */
export const MIN_RELEASE_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * `minimumReleaseAge` (seconds) from bunfig's `install` table as Bun's TOML
 * parser returned it (scripts/check-dep-ages.mjs gets the table from `Bun.TOML.parse`).
 *
 * @returns {{ seconds: number | null, error: string | null }}
 */
export function thresholdFromInstallTable(install) {
  const table = install !== null && typeof install === "object" && !Array.isArray(install) ? install : {};
  const value = table.minimumReleaseAge;
  if (value === undefined) return { seconds: null, error: "the key is missing" };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { seconds: null, error: `expected a non-negative number of seconds, got ${JSON.stringify(value)}` };
  }
  if (value < MIN_RELEASE_AGE_SECONDS) {
    return { seconds: null, error: `${value} is below the ${MIN_RELEASE_AGE_SECONDS}-second (7-day) floor` };
  }
  return { seconds: value, error: null };
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

/**
 * The exclusion list from bunfig's `install` table as Bun's TOML parser returned
 * it (scripts/check-dep-ages.mjs gets the table from `Bun.TOML.parse`).
 *
 * @returns {{ names: string[], error: string | null }}
 */
export function excludesFromInstallTable(install) {
  const refuse = (detail) => ({
    names: [], error: `unparseable minimumReleaseAgeExcludes: ${detail}`,
  });
  if (install === null || install === undefined) return { names: [], error: null };
  if (typeof install !== "object" || Array.isArray(install)) return refuse("install is not a table");
  const names = install.minimumReleaseAgeExcludes;
  if (names === undefined) return { names: [], error: null };
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
    return refuse("expected an array of strings");
  }
  return { names, error: null };
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

/** Split a relative path into its non-empty, non-`.` segments. */
function pathSegments(path) {
  return String(path)
    .split(/[\\/]/)
    .filter((segment) => segment !== "" && segment !== ".");
}

/**
 * Bun's `detect_glob_syntax`: a pattern is a glob when it is `!`-prefixed or
 * carries an unescaped `*`, `{`, `[` or `?`.
 */
function isGlobPattern(pattern) {
  if (pattern.startsWith("!")) return true;
  return /[*{[?]/.test(pattern);
}

/** Strip every leading `!`; an odd count is a negation. */
function stripNegation(pattern) {
  let i = 0;
  while (i < pattern.length && pattern[i] === "!") i++;
  return { inner: pattern.slice(i), negated: i % 2 === 1 };
}

/** Split a brace body on its top-level commas (a comma inside `{...}` or `[...]` is a member). */
function splitBraceAlternatives(body) {
  const alternatives = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (!inClass && ch === "{") depth++;
    else if (!inClass && ch === "}") depth--;
    else if (!inClass && depth === 0 && ch === ",") {
      alternatives.push(body.slice(start, i));
      start = i + 1;
    }
  }
  alternatives.push(body.slice(start));
  return alternatives;
}

/**
 * Expand `{a,b}` into its alternatives (Bun matches one comma-separated branch;
 * branches nest). A branch that spans a separator is not a form Bun's directory
 * walk expands, so the whole pattern matches nothing — `null` reports that.
 */
function expandBraces(pattern) {
  const expanded = [];
  const recurse = (current) => {
    const open = current.indexOf("{");
    if (open === -1) {
      expanded.push(current);
      return true;
    }
    let depth = 0;
    let close = -1;
    for (let i = open; i < current.length; i++) {
      if (current[i] === "{") depth++;
      else if (current[i] === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) return false;
    const body = current.slice(open + 1, close);
    if (body.includes("/")) return false;
    for (const alternative of splitBraceAlternatives(body)) {
      if (!recurse(current.slice(0, open) + alternative + current.slice(close + 1))) return false;
    }
    return true;
  };
  return recurse(pattern) ? expanded : null;
}

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

/**
 * Whether one glob segment matches one path segment: `*` and `?` stay inside the
 * segment, `[...]` is a character class (`[!...]`/`[^...]` negate it, `a-z` is a
 * range) and `\` escapes the next character.
 */
function matchGlobSegment(value, pattern) {
  let source = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      source += "[^/]*";
      i++;
    } else if (ch === "?") {
      source += "[^/]";
      i++;
    } else if (ch === "[") {
      let end = i + 1;
      if (pattern[end] === "!" || pattern[end] === "^") end++;
      if (pattern[end] === "]") end++;
      while (end < pattern.length && pattern[end] !== "]") end++;
      if (end >= pattern.length) {
        source += "\\[";
        i++;
        continue;
      }
      const body = pattern.slice(i + 1, end);
      const negated = body.startsWith("!") || body.startsWith("^");
      const members = negated ? body.slice(1) : body;
      source += `[${negated ? "^" : ""}${members.replace(/\\/g, "\\\\")}]`;
      i = end + 1;
    } else if (ch === "\\" && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      source += REGEX_SPECIAL.test(next) ? `\\${next}` : next;
      i += 2;
    } else {
      source += REGEX_SPECIAL.test(ch) ? `\\${ch}` : ch;
      i++;
    }
  }
  return new RegExp(`${source}$`).test(value);
}

/** Whether the path segments match the (brace-expanded) glob segments; `**` spans segments. */
function matchSegments(value, glob) {
  function match(i, j) {
    if (j === glob.length) return i === value.length;
    if (glob[j] === "**") {
      for (let k = i; k <= value.length; k++) if (match(k, j + 1)) return true;
      return false;
    }
    return i < value.length && matchGlobSegment(value[i], glob[j]) && match(i + 1, j + 1);
  }
  return match(0, 0);
}

/** Whether a workspace glob matches a manifest's directory. */
function matchGlobDir(dir, pattern) {
  const expanded = expandBraces(pattern);
  if (expanded === null) return false;
  const value = pathSegments(dir);
  // Bun's glob walk skips dot-directories; only a pattern without glob syntax reaches one.
  if (isGlobPattern(pattern) && value.some((segment) => segment.startsWith("."))) return false;
  for (const candidate of expanded) {
    if (matchSegments(value, pathSegments(candidate))) return true;
  }
  return false;
}

/**
 * The workspace patterns a root manifest declares, in Bun's two accepted shapes:
 * an array of strings, or an object whose `packages` key is an array of strings.
 * Any other shape is refused with a named error, because a shape the audit
 * misreads would hide the manifests Bun applies.
 *
 * @returns {{ patterns: string[], error: string | null }}
 */
export function workspacePatterns(workspaces) {
  if (workspaces === undefined) return { patterns: [], error: null };
  if (Array.isArray(workspaces)) {
    if (workspaces.some((pattern) => typeof pattern !== "string")) {
      return { patterns: [], error: "`workspaces` is an array, but not every entry is a string" };
    }
    return { patterns: workspaces, error: null };
  }
  if (workspaces !== null && typeof workspaces === "object") {
    const packages = workspaces.packages;
    if (!Array.isArray(packages) || packages.some((pattern) => typeof pattern !== "string")) {
      return {
        patterns: [],
        error: "`workspaces` is an object, but `workspaces.packages` is not an array of strings",
      };
    }
    return { patterns: packages, error: null };
  }
  return {
    patterns: [],
    error: "`workspaces` is neither an array of strings nor an object with a `packages` array",
  };
}

/**
 * The manifests Bun applies when it installs: the root manifest, and the
 * manifests of the directories the root manifest's `workspaces` patterns name.
 * A pattern without glob syntax is a literal directory; a glob one is walked with
 * `*`, `?`, `**`, `[...]` and `{a,b}`. A `!`-negated pattern removes an earlier
 * glob match it matches; a literal directory is never removed.
 *
 * @returns {{ applied: Set<string>, error: string | null }} `error` names a
 *   `workspaces` shape the audit cannot read, and `applied` then holds only the root.
 */
export function appliedManifestPaths(manifests) {
  const applied = new Set(["package.json"]);
  const root = manifests.find((pj) => pj.path === "package.json");
  const { patterns, error } = workspacePatterns(root?.json?.workspaces);
  if (error !== null) return { applied, error };
  const literals = [];
  const globs = [];
  for (const raw of patterns) {
    if (raw === "" || raw === "." || raw === "./" || raw === ".\\") continue;
    if (isGlobPattern(raw)) globs.push(raw);
    else literals.push(raw);
  }
  const byDir = new Map();
  for (const pj of manifests) {
    if (pj.path === "package.json") continue;
    byDir.set(pathSegments(pj.path).slice(0, -1).join("/"), pj.path);
  }
  for (const literal of literals) {
    const path = byDir.get(pathSegments(literal).join("/"));
    if (path !== undefined) applied.add(path);
  }
  for (let i = 0; i < globs.length; i++) {
    const { inner, negated } = stripNegation(globs[i]);
    if (negated) continue; // a negated pattern removes an earlier glob match, and adds none of its own
    for (const [dir, path] of byDir) {
      if (!matchGlobDir(dir, inner)) continue;
      const excluded = globs.slice(i + 1).some((later) => {
        const removed = stripNegation(later);
        return removed.negated && matchGlobDir(dir, removed.inner);
      });
      if (!excluded) applied.add(path);
    }
  }
  return { applied, error: null };
}

/**
 * Check bunfig's install-time excludes against the dated exceptions and the
 * exact pins Bun applies. Only a declaration Bun applies counts: an exact entry
 * in a dependency section of the root manifest (`package.json`) or of a manifest
 * a root `workspaces` pattern names, and in the root manifest's `overrides`. Bun
 * applies `overrides` from the root manifest, not from a nested one, so an
 * excluded name in a nested `overrides` is refused. A name pinned exactly only in
 * a manifest Bun does not apply is reported with that manifest's path. Bun 1.3.10
 * applies root `resolutions` (key `name` or `**\/name`) over a direct pin, and
 * ignores them while the root has an `overrides` key, so a resolutions key naming
 * an excluded package is refused in any manifest.
 *
 * @param {{ excludes: string[], exceptionEntries: Map<string, object>,
 *           exceptionErrors: Array<{key: string | null, message: string}>,
 *           packageJsons: Array<{path: string, json: object}> }}
 * @returns Array<{kind: "uncovered", name: string,
 *                 error: {message: string} | null}
 *             | {kind: "range", name: string, path: string, spec: string}
 *             | {kind: "nested-override", name: string, path: string}
 *             | {kind: "resolution", name: string, path: string, key: string}
 *             | {kind: "unused-manifest", name: string, path: string}
 *             | {kind: "unpinned", name: string}
 *             | {kind: "workspaces", message: string}>
 */
export function auditExcludes({ excludes, exceptionEntries, exceptionErrors, packageJsons }) {
  const problems = [];
  const manifests = packageJsons ?? [];
  const { applied, error: workspacesError } = appliedManifestPaths(manifests);
  if (workspacesError !== null) return [{ kind: "workspaces", message: workspacesError }];
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
    let declared = false;
    const unappliedExact = [];
    for (const pj of manifests) {
      const isApplied = applied.has(pj.path);
      const resolutions = pj.json?.resolutions;
      if (resolutions && typeof resolutions === "object") {
        for (const key of Object.keys(resolutions)) {
          if ((key.startsWith("**/") ? key.slice(3) : key) === name) {
            problems.push({ kind: "resolution", name, path: pj.path, key });
          }
        }
      }
      for (const field of DEP_FIELDS) {
        const deps = pj.json?.[field];
        if (!deps || typeof deps !== "object" || !Object.hasOwn(deps, name)) continue;
        if (field === "overrides" && pj.path !== "package.json") {
          problems.push({ kind: "nested-override", name, path: pj.path });
          continue;
        }
        const spec = deps[name];
        if (isApplied) declared = true;
        if (!isExactVersionPin(spec)) {
          problems.push({ kind: "range", name, path: pj.path, spec });
        } else if (!isApplied) {
          unappliedExact.push(pj.path);
        }
      }
    }
    if (!declared) {
      if (unappliedExact.length > 0) {
        for (const path of unappliedExact) problems.push({ kind: "unused-manifest", name, path });
      } else {
        problems.push({ kind: "unpinned", name });
      }
    }
  }
  return problems;
}
