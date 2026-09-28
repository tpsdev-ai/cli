/**
 * resolve-runtime.mjs — resolve a reviewed commit's runtime requirements to ONE
 * explicit entry in the trusted runtime matrix, or refuse by name.
 *
 * Requirements are read from the reviewed commit's own declarations
 * (`packageManager`, `engines`, and the runtime-version files `.nvmrc`,
 * `.node-version`, `.bun-version`, `.tool-versions`) and reconciled with the
 * pins of the CI job the host names (see ci-job.mjs). Ranges are resolved
 * against the trusted table only; the reviewed checkout cannot extend the table
 * or pick a download source.
 *
 * Ranges follow npm semver (node-semver's grammar and desugaring, with
 * includePrerelease off): partial comparators are widened the way npm widens
 * them (`>22` is `>=23.0.0`, `<=24` is `<25.0.0-0`), and x-ranges, hyphen,
 * tilde, caret and `||` sets are supported. A requirement this parser cannot
 * read (`latest`, `lts/*`, `node`, a malformed range) is never matched: it is
 * refused as ambiguous.
 *
 * Refusal kinds (all named, all fail closed):
 *   - invalid-declaration  a declaration has the wrong shape (a non-string
 *                          engines.node, a packageManager that is not a string,
 *                          a tool line with no version).
 *   - ambiguous            a requirement is not an explicit version or semver
 *                          range, a version file lists more than one version,
 *                          or the requirement set leaves more than one trusted
 *                          version or image.
 *   - conflicting          requirements individually resolvable but mutually
 *                          unsatisfiable.
 *   - out-of-matrix        no trusted image provides a requirement. The message
 *                          names the missing image by its requirements, e.g.
 *                          `missing image: node >=25 with bun 1.3.10`.
 */

// ─── npm-semver ranges ──────────────────────────────────────────────────────

const NUM = "0|[1-9]\\d*";
const XR = `[xX*]|${NUM}`;
const PRE_ID = `${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*`;
const PRERELEASE = `(?:${PRE_ID})(?:\\.(?:${PRE_ID}))*`;
const BUILD = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
// A partial version as a range operand: "22", "22.x", "22.22.1-rc.1+b".
const PARTIAL_RE = new RegExp(`^v?(${XR})(?:\\.(${XR})(?:\\.(${XR})(?:-(${PRERELEASE}))?(?:\\+${BUILD})?)?)?$`);
// A tested version: always a full release (matrix entries and actual runtimes).
const RELEASE_RE = new RegExp(`^v?(${NUM})\\.(${NUM})\\.(${NUM})(?:\\+${BUILD})?$`);

const isX = (part) => part === undefined || part === "x" || part === "X" || part === "*";

function parsePartial(text) {
  const m = PARTIAL_RE.exec(text);
  if (!m) return null;
  const [, major, minor, patch, pre] = m;
  // A qualifier only exists on a full version.
  if (pre !== undefined && (isX(major) || isX(minor) || isX(patch))) return null;
  return { major, minor, patch, pre };
}

function version(major, minor, patch, pre) {
  const preIds = pre === undefined || pre === "" ? [] : String(pre).split(".");
  return { major: Number(major), minor: Number(minor), patch: Number(patch), pre: preIds };
}

const ANY = [];
const NOTHING = [{ op: "<", v: version(0, 0, 0, "0") }];
const cmpOp = (op, v) => [{ op, v }];

/** Desugar a tilde operand, as node-semver's replaceTilde does. */
function tilde(p) {
  if (isX(p.major)) return ANY;
  const M = Number(p.major);
  if (isX(p.minor)) return [{ op: ">=", v: version(M, 0, 0) }, { op: "<", v: version(M + 1, 0, 0, "0") }];
  const m = Number(p.minor);
  if (isX(p.patch)) return [{ op: ">=", v: version(M, m, 0) }, { op: "<", v: version(M, m + 1, 0, "0") }];
  return [{ op: ">=", v: version(M, m, p.patch, p.pre) }, { op: "<", v: version(M, m + 1, 0, "0") }];
}

/** Desugar a caret operand, as node-semver's replaceCaret does. */
function caret(p) {
  if (isX(p.major)) return ANY;
  const M = Number(p.major);
  if (isX(p.minor)) return [{ op: ">=", v: version(M, 0, 0) }, { op: "<", v: version(M + 1, 0, 0, "0") }];
  const m = Number(p.minor);
  if (isX(p.patch)) {
    const upper = M === 0 ? version(0, m + 1, 0, "0") : version(M + 1, 0, 0, "0");
    return [{ op: ">=", v: version(M, m, 0) }, { op: "<", v: upper }];
  }
  const pt = Number(p.patch);
  let upper;
  if (M !== 0) upper = version(M + 1, 0, 0, "0");
  else if (m !== 0) upper = version(0, m + 1, 0, "0");
  else upper = version(0, 0, pt + 1, "0");
  return [{ op: ">=", v: version(M, m, pt, p.pre) }, { op: "<", v: upper }];
}

/** Desugar a primitive or bare x-range, as node-semver's replaceXRange does. */
function xrange(op, p) {
  const xM = isX(p.major);
  const xm = xM || isX(p.minor);
  const xp = xm || isX(p.patch);
  let gtlt = op === "=" && xp ? "" : op;
  if (xM) return gtlt === ">" || gtlt === "<" ? NOTHING : ANY;
  let M = Number(p.major);
  let m = xm ? 0 : Number(p.minor);
  let pt = xp ? 0 : Number(p.patch);
  if (gtlt && xp) {
    if (gtlt === ">") {
      gtlt = ">=";
      if (xm) {
        M += 1;
        m = 0;
      } else {
        m += 1;
      }
      pt = 0;
    } else if (gtlt === "<=") {
      gtlt = "<";
      if (xm) M += 1;
      else m += 1;
    }
    return cmpOp(gtlt, version(M, m, pt, gtlt === "<" ? "0" : undefined));
  }
  if (xm) return [{ op: ">=", v: version(M, 0, 0) }, { op: "<", v: version(M + 1, 0, 0, "0") }];
  if (xp) return [{ op: ">=", v: version(M, m, 0) }, { op: "<", v: version(M, m + 1, 0, "0") }];
  return cmpOp(gtlt === "" ? "=" : gtlt, version(M, m, pt, p.pre));
}

/** Desugar a hyphen range "A - B", as node-semver's hyphenReplace does. */
function hyphen(from, to) {
  const out = [];
  if (!isX(from.major)) {
    if (isX(from.minor)) out.push({ op: ">=", v: version(from.major, 0, 0) });
    else if (isX(from.patch)) out.push({ op: ">=", v: version(from.major, from.minor, 0) });
    else out.push({ op: ">=", v: version(from.major, from.minor, from.patch, from.pre) });
  }
  if (!isX(to.major)) {
    if (isX(to.minor)) out.push({ op: "<", v: version(Number(to.major) + 1, 0, 0, "0") });
    else if (isX(to.patch)) out.push({ op: "<", v: version(to.major, Number(to.minor) + 1, 0, "0") });
    else out.push({ op: "<=", v: version(to.major, to.minor, to.patch, to.pre) });
  }
  return out;
}

function parseToken(token) {
  let m = /^\^(.*)$/.exec(token);
  if (m) {
    const p = parsePartial(m[1]);
    return p ? caret(p) : null;
  }
  m = /^~>?(.*)$/.exec(token);
  if (m) {
    const p = parsePartial(m[1]);
    return p ? tilde(p) : null;
  }
  m = /^(<=|>=|<|>|=)?=?(.*)$/.exec(token);
  const p = parsePartial(m[2]);
  return p ? xrange(m[1] ?? "", p) : null;
}

/**
 * Parse a range into its comparator sets (an OR of ANDs), or null when the text
 * is not a semver range. An empty set matches every release.
 */
function parseRange(range) {
  if (typeof range !== "string") return null;
  const text = range.trim();
  if (text === "") return [ANY];
  const sets = [];
  for (const rawPart of text.split(/\s*\|\|\s*/)) {
    const part = rawPart.trim();
    if (part === "") return null; // an empty alternative: refused rather than read as "*"
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(part);
    if (hy) {
      const from = parsePartial(hy[1]);
      const to = parsePartial(hy[2]);
      if (!from || !to) return null;
      sets.push(hyphen(from, to));
      continue;
    }
    // "> = 1.2" / "^ 1.2" / "~> 1.2" are one comparator with inner spaces.
    const joined = part.replace(/(<=|>=|<|>|=|\^|~>?)\s+/g, "$1");
    const set = [];
    for (const token of joined.split(/\s+/)) {
      const comps = parseToken(token);
      if (!comps) return null;
      set.push(...comps);
    }
    sets.push(set);
  }
  return sets;
}

function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release sorts after its prereleases
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    // PRE_ID admits numeric identifiers only without leading zeros.
    const an = String(Number(a[i])) === a[i];
    const bn = String(Number(b[i])) === b[i];
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

function compare(a, b) {
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return comparePre(a.pre, b.pre);
}

function testComparator(v, { op, v: c }) {
  const d = compare(v, c);
  switch (op) {
    case ">=":
      return d >= 0;
    case ">":
      return d > 0;
    case "<":
      return d < 0;
    case "<=":
      return d <= 0;
    default:
      return d === 0;
  }
}

/**
 * Does the release `version` satisfy the npm-semver `range`? False for a range
 * that is not semver (never a guess) and for a tested version that is not a
 * full release.
 */
export function satisfiesRange(versionText, range) {
  const m = RELEASE_RE.exec(String(versionText).trim());
  if (!m) return false;
  const v = version(m[1], m[2], m[3]);
  const sets = parseRange(range);
  if (!sets) return false;
  return sets.some((set) => set.every((comp) => testComparator(v, comp)));
}

/** Is `range` a semver range this resolver can read? */
export function isSemverRange(range) {
  return parseRange(range) !== null;
}

// ─── declarations ───────────────────────────────────────────────────────────

/** The tools the matrix can provide. Anything else is a named refusal. */
const SUPPORTED_TOOLS = new Set(["node", "bun"]);
/** asdf/mise tool names for the supported runtimes. */
const TOOL_ALIASES = { nodejs: "node", node: "node", bun: "bun" };

const refuse = (kind, message) => ({ ok: false, refusal: { kind, message } });

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Lines of a version file with `#` comments and blank lines removed. */
function meaningfulLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line !== "");
}

/** A single-version file (.nvmrc, .node-version, .bun-version). */
function singleVersion(name, text) {
  const tokens = meaningfulLines(text).flatMap((line) => line.split(/\s+/));
  if (tokens.length === 0) return { ok: true, range: null };
  if (tokens.length > 1) {
    return refuse(
      "ambiguous",
      `${name} lists more than one version (${tokens.join(" ")}); pin exactly one`,
    );
  }
  return { ok: true, range: tokens[0] };
}

function collectConstraints(input) {
  const constraints = [];
  const notes = [];
  const manifest = input.manifest ?? {};

  const pm = manifest.packageManager;
  if (pm !== undefined && pm !== null) {
    if (typeof pm !== "string" || pm.trim() === "") {
      return refuse(
        "invalid-declaration",
        `package.json packageManager must be a "name@version" string (got ${typeName(pm)})`,
      );
    }
    const at = pm.lastIndexOf("@");
    const tool = (at > 0 ? pm.slice(0, at) : pm).trim();
    const range = at > 0 ? pm.slice(at + 1).trim() : "*";
    constraints.push({ tool, range: range || "*", source: "packageManager" });
  }

  const engines = manifest.engines;
  if (engines !== undefined && engines !== null) {
    if (typeof engines !== "object" || Array.isArray(engines)) {
      return refuse("invalid-declaration", `package.json engines must be an object (got ${typeName(engines)})`);
    }
    for (const [tool, range] of Object.entries(engines)) {
      if (!SUPPORTED_TOOLS.has(tool)) {
        notes.push(`engines.${tool} is not a runtime the matrix selects; ignored`);
        continue;
      }
      if (typeof range !== "string") {
        return refuse(
          "invalid-declaration",
          `package.json engines.${tool} must be a semver range string (got ${typeName(range)} ${JSON.stringify(range)})`,
        );
      }
      constraints.push({ tool, range, source: `engines.${tool}` });
    }
  }

  const files = input.runtimeFiles ?? {};
  for (const name of [".nvmrc", ".node-version", ".bun-version"]) {
    if (files[name] == null) continue;
    const r = singleVersion(name, files[name]);
    if (!r.ok) return r;
    if (r.range !== null) constraints.push({ tool: name === ".bun-version" ? "bun" : "node", range: r.range, source: name });
  }
  if (files[".tool-versions"] != null) {
    for (const line of meaningfulLines(files[".tool-versions"])) {
      const [rawTool, ...versions] = line.split(/\s+/);
      if (versions.length === 0) {
        return refuse("invalid-declaration", `.tool-versions line "${line}" names ${rawTool} with no version`);
      }
      if (versions.length > 1) {
        return refuse(
          "ambiguous",
          `.tool-versions line "${line}" lists more than one ${rawTool} version (an asdf fallback list); pin exactly one`,
        );
      }
      constraints.push({ tool: TOOL_ALIASES[rawTool] ?? rawTool, range: versions[0], source: ".tool-versions" });
    }
  }

  if (Array.isArray(input.ciConstraints)) {
    for (const c of input.ciConstraints) {
      if (c && typeof c.tool === "string" && typeof c.range === "string") {
        constraints.push({ tool: c.tool, range: c.range, source: c.source ?? "ci" });
      }
    }
  }
  return { ok: true, constraints, notes };
}

// ─── resolution ─────────────────────────────────────────────────────────────

function imageList(table) {
  return Array.isArray(table?.images) ? table.images : [];
}

function availableImages(table) {
  const list = imageList(table).map((i) => `${i.id} (node ${i.node}, bun ${i.bun})`);
  return list.length > 0 ? list.join(", ") : "none";
}

/** Resolve one tool's constraints against the table's versions of that tool. */
function resolveTool(tool, constraints, table) {
  if (constraints.length === 0) return { status: "unconstrained" };
  const versions = Object.keys(table?.artifacts?.[tool] ?? {});
  const perConstraint = [];
  for (const c of constraints) {
    const matching = versions.filter((v) => satisfiesRange(v, c.range));
    if (matching.length === 0) return { status: "out", constraint: c };
    perConstraint.push(matching);
  }
  const all = versions.filter((v) => perConstraint.every((set) => set.includes(v)));
  if (all.length === 0) return { status: "conflict", constraints };
  if (all.length > 1) return { status: "ambiguous", constraints, versions: all };
  return { status: "resolved", version: all[0] };
}

/** "node >=25" / "bun 1.3.10" — how the missing image names one tool. */
function describeTool(tool, result, constraints) {
  if (result.status === "unconstrained") return null;
  if (result.status === "resolved") return `${tool} ${result.version}`;
  if (result.status === "out") return `${tool} ${result.constraint.range}`;
  return `${tool} ${constraints.map((c) => c.range).join(" ")}`;
}

/**
 * Resolve requirements to exactly one matrix image.
 * @returns {{ok:true, image:object, node:string, bun:string,
 *            requirements:{tool:string, range:string, source:string}[], notes:string[]}
 *          | {ok:false, refusal:{kind:string, message:string}}}
 */
export function resolveRuntime(input) {
  const table = input.table;
  const collected = collectConstraints(input);
  if (!collected.ok) return collected;
  const { constraints, notes } = collected;
  const provides = `The trusted matrix provides: ${availableImages(table)}`;

  // A requirement the resolver cannot read is never guessed at.
  const unreadable = constraints.find((c) => !isSemverRange(c.range));
  if (unreadable) {
    return refuse(
      "ambiguous",
      `requirement "${unreadable.range}" for ${unreadable.tool} (from ${unreadable.source}) is not an explicit version or semver range; an alias or dist-tag floats, so no image can be selected. ${provides}`,
    );
  }

  // A tool the matrix cannot provide at all is a missing image.
  const unsupported = constraints.find((c) => !SUPPORTED_TOOLS.has(c.tool));
  if (unsupported) {
    return refuse(
      "out-of-matrix",
      `missing image: ${unsupported.tool} ${unsupported.range} (required by ${unsupported.source}); no reviewer image provides ${unsupported.tool}. ${provides}`,
    );
  }

  const byTool = {
    node: constraints.filter((c) => c.tool === "node"),
    bun: constraints.filter((c) => c.tool === "bun"),
  };
  const result = { node: resolveTool("node", byTool.node, table), bun: resolveTool("bun", byTool.bun, table) };
  const describe = (tool) => describeTool(tool, result[tool], byTool[tool]);
  const missingImage = () => ["node", "bun"].map(describe).filter((d) => d !== null).join(" with ");

  for (const tool of ["node", "bun"]) {
    const r = result[tool];
    if (r.status === "out") {
      return refuse(
        "out-of-matrix",
        `missing image: ${missingImage()} (${tool} ${r.constraint.range} is required by ${r.constraint.source}). ${provides}`,
      );
    }
  }
  for (const tool of ["node", "bun"]) {
    const r = result[tool];
    if (r.status === "conflict") {
      return refuse(
        "conflicting",
        `conflicting ${tool} requirements (${r.constraints.map((c) => `${c.source}=${c.range}`).join(", ")}); no single trusted version satisfies all. ${provides}`,
      );
    }
    if (r.status === "ambiguous") {
      return refuse(
        "ambiguous",
        `the ${tool} requirements (${r.constraints.map((c) => `${c.source}=${c.range}`).join(", ")}) match more than one trusted version (${r.versions.join(", ")}); pin one explicitly. ${provides}`,
      );
    }
  }

  const node = result.node.status === "resolved" ? result.node.version : null;
  const bun = result.bun.status === "resolved" ? result.bun.version : null;
  if (node === null && bun === null) {
    return refuse(
      "ambiguous",
      `the reviewed commit declares no node or bun requirement; no image can be selected. ${provides}`,
    );
  }

  const candidates = imageList(table).filter(
    (img) => (node === null || img.node === node) && (bun === null || img.bun === bun),
  );
  if (candidates.length === 0) {
    return refuse("out-of-matrix", `missing image: ${missingImage()}. ${provides}`);
  }
  if (candidates.length > 1) {
    return refuse(
      "ambiguous",
      `the resolved runtime (${missingImage()}) matches more than one image (${candidates.map((c) => c.id).join(", ")}); declare the other runtime explicitly. ${provides}`,
    );
  }
  const image = candidates[0];
  return { ok: true, image, node: image.node, bun: image.bun, requirements: [...byTool.node, ...byTool.bun], notes };
}
