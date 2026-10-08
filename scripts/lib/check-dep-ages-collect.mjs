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
 * Parse entries after `## Exceptions`; validate every subsequent nonblank line.
 * Expiry dates include their UTC day.
 *
 * @returns {{ entries: Map<string, {expires: string, reason: string, line: number}>,
 *             errors: Array<{line: number, text: string, message: string}> }}
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
        message:
          "malformed exception: expected `- name@version | expires:YYYY-MM-DD | reason: ...`",
      });
      continue;
    }
    const [, key, date, reason] = m;
    // `Date.parse` accepts rollovers (2026-02-30 → 2026-03-02), so round-trip
    // the date to reject one that is not a real calendar day.
    const parsed = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
      errors.push({ line, text: t, message: `invalid expiry date: ${date}` });
      continue;
    }
    if (date < today) {
      errors.push({ line, text: t, message: `exception expired on ${date}` });
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
