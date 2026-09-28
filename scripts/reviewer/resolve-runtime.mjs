/**
 * resolve-runtime.mjs — resolve a reviewed commit's runtime requirements to ONE
 * explicit entry in the trusted runtime matrix, or refuse by name.
 *
 * Requirements are read from the reviewed commit's own declarations
 * (`packageManager`, `engines`, and the applicable runtime-version files) and
 * reconciled with its CI lanes. Ranges are resolved against the trusted table
 * only; the reviewed checkout cannot extend the table or pick a download source.
 *
 * Refusal kinds (all named, all fail closed):
 *   - ambiguous      two or more requirements, or two or more matrix entries,
 *                    leave more than one supported runtime.
 *   - conflicting    requirements individually resolvable but mutually
 *                    unsatisfiable.
 *   - out-of-matrix  a requirement matches no entry in the table; the message
 *                    names the missing image.
 */

/** A version as a numeric triple; a partial version (e.g. "22") leaves the
 *  unspecified parts as null to mean "any". */
function parseVersion(text) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(String(text).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? null : Number(m[2]),
    patch: m[3] === undefined ? null : Number(m[3]),
  };
}

function cmp(a, b) {
  // Compare full triples; -1/0/1.
  for (const k of ["major", "minor", "patch"]) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function bumpMajor(v) {
  return { major: v.major + 1, minor: 0, patch: 0 };
}

function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  const r = String(range).trim();
  if (r === "" || r === "*" || r === "x" || r === "latest") return true;
  return r.split("||").some((part) =>
    part
      .trim()
      .split(/\s+/)
      .filter((t) => t !== "")
      .every((tok) => satisfiesToken(v, tok)),
  );
}

function satisfiesToken(v, tok) {
  if (tok === "*" || tok === "x") return true;
  let op = "";
  let rest = tok;
  for (const candidate of [">=", "<=", ">", "<", "=", "^", "~"]) {
    if (tok.startsWith(candidate)) {
      op = candidate;
      rest = tok.slice(candidate.length);
      break;
    }
  }
  const p = parseVersion(rest);
  if (!p) {
    // A non-version token (e.g. "lts/*", a tag) cannot be resolved explicitly.
    return false;
  }
  switch (op) {
    case "":
    case "=": {
      if (p.minor === null) return v.major === p.major;
      if (p.patch === null) return v.major === p.major && v.minor === p.minor;
      return cmp(v, p) === 0;
    }
    case ">":
      return cmp(v, p) > 0;
    case ">=":
      return cmp(v, p) >= 0;
    case "<":
      return cmp(v, p) < 0;
    case "<=":
      return cmp(v, p) <= 0;
    case "^": {
      if (p.minor === null) return v.major === p.major;
      return cmp(v, p) >= 0 && v.major === p.major;
    }
    case "~": {
      if (p.minor === null) return v.major === p.major;
      return cmp(v, p) >= 0 && v.major === p.major && v.minor === p.minor;
    }
    default:
      return false;
  }
}

/** Split "name@range" (a packageManager field) into its parts. */
function parsePackageManager(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const at = value.lastIndexOf("@");
  if (at <= 0) return { tool: value.trim(), range: "*" };
  return { tool: value.slice(0, at).trim(), range: value.slice(at + 1).trim() || "*" };
}

/** The tools the matrix can provide. Anything else is a named refusal. */
const SUPPORTED_TOOLS = new Set(["node", "bun"]);

function collectConstraints(input) {
  const constraints = [];
  const notes = [];
  const manifest = input.manifest ?? {};
  const pm = parsePackageManager(manifest.packageManager);
  if (pm) constraints.push({ tool: pm.tool, range: pm.range, source: "packageManager" });
  const engines = manifest.engines ?? {};
  for (const [tool, range] of Object.entries(engines)) {
    if (typeof range !== "string") continue;
    if (tool === "node" || tool === "bun") constraints.push({ tool, range, source: `engines.${tool}` });
    else notes.push(`${tool}@${range}`);
  }
  const files = input.runtimeFiles ?? {};
  for (const [name, value] of Object.entries(files)) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text === "") continue;
    if (name === ".nvmrc" || name === ".node-version") {
      if (/^lts(\/.*)?$/i.test(text)) {
        constraints.push({ tool: "node", range: "lts/*", source: name, unresolvable: true });
      } else {
        constraints.push({ tool: "node", range: text.replace(/^v/, ""), source: name });
      }
    } else if (name === ".bun-version") {
      constraints.push({ tool: "bun", range: text, source: name });
    } else if (name === ".tool-versions") {
      for (const line of text.split(/\r?\n/)) {
        const m = /^(\S+)\s+(\S+)$/.exec(line.trim());
        if (!m) continue;
        const tool = m[1] === "nodejs" ? "node" : m[1];
        constraints.push({ tool, range: m[2], source: ".tool-versions" });
      }
    }
  }
  if (Array.isArray(input.ciConstraints)) {
    for (const c of input.ciConstraints) {
      if (c && typeof c.tool === "string" && typeof c.range === "string") {
        constraints.push({ tool: c.tool, range: c.range, source: c.source ?? "ci" });
      }
    }
  }
  return { constraints, notes };
}

function imageList(table) {
  return Array.isArray(table.images) ? table.images : [];
}

function availableImages(table) {
  return imageList(table)
    .map((i) => `${i.id} (node ${i.node}, bun ${i.bun})`)
    .join(", ");
}

function resolveTool(tool, constraints, table) {
  const versions = Object.keys((table.artifacts ?? {})[tool] ?? {});
  if (versions.length === 0) {
    return {
      ok: false,
      refusal: {
        kind: "out-of-matrix",
        message: `runtime "${tool}" is not in the trusted matrix; no image provides it. Available images: ${availableImages(table)}`,
      },
    };
  }
  // Each constraint must individually resolve (else the pin is outside the matrix).
  const perConstraint = [];
  for (const c of constraints) {
    if (c.unresolvable) {
      return {
        ok: false,
        refusal: {
          kind: "ambiguous",
          message: `requirement "${c.range}" from ${c.source} is not an explicit version; no image can be selected. Available images: ${availableImages(table)}`,
        },
      };
    }
    const matching = versions.filter((v) => satisfiesRange(v, c.range));
    if (matching.length === 0) {
      return {
        ok: false,
        refusal: {
          kind: "out-of-matrix",
          message: `no trusted image provides ${tool} ${c.range} (required by ${c.source}); the missing image is named. Available images: ${availableImages(table)}`,
        },
      };
    }
    perConstraint.push(matching);
  }
  const all = versions.filter((v) => perConstraint.every((set) => set.includes(v)));
  if (all.length === 0) {
    return {
      ok: false,
      refusal: {
        kind: "conflicting",
        message: `conflicting ${tool} requirements (${constraints.map((c) => `${c.source}=${c.range}`).join(", ")}); no single trusted version satisfies all. Available images: ${availableImages(table)}`,
      },
    };
  }
  if (all.length > 1) {
    return {
      ok: false,
      refusal: {
        kind: "ambiguous",
        message: `the ${tool} requirement set resolves to more than one trusted version (${all.join(", ")}); pin one explicitly. Available images: ${availableImages(table)}`,
      },
    };
  }
  return { ok: true, version: all[0] };
}

/**
 * Resolve requirements to exactly one matrix image.
 * @returns {{ok:true, image:object, node:string, bun:string, notes:string[]}
 *          | {ok:false, refusal:{kind:string, message:string}}}
 */
export function resolveRuntime(input) {
  const table = input.table;
  const { constraints, notes } = collectConstraints(input);

  // A packageManager naming a tool the matrix cannot provide is a refusal.
  const unsupported = constraints.find((c) => !SUPPORTED_TOOLS.has(c.tool));
  if (unsupported) {
    return {
      ok: false,
      refusal: {
        kind: "out-of-matrix",
        message: `runtime "${unsupported.tool}" (from ${unsupported.source}) is outside the trusted matrix; no image provides it. Available images: ${availableImages(table)}`,
      },
    };
  }

  const nodeConstraints = constraints.filter((c) => c.tool === "node");
  const bunConstraints = constraints.filter((c) => c.tool === "bun");

  let node = null;
  let bun = null;
  if (nodeConstraints.length > 0) {
    const r = resolveTool("node", nodeConstraints, table);
    if (!r.ok) return { ok: false, refusal: r.refusal };
    node = r.version;
  }
  if (bunConstraints.length > 0) {
    const r = resolveTool("bun", bunConstraints, table);
    if (!r.ok) return { ok: false, refusal: r.refusal };
    bun = r.version;
  }

  if (node === null && bun === null) {
    return {
      ok: false,
      refusal: {
        kind: "ambiguous",
        message: `the reviewed commit declares no runtime requirement; no image can be selected. Available images: ${availableImages(table)}`,
      },
    };
  }

  const candidates = imageList(table).filter(
    (img) => (node === null || img.node === node) && (bun === null || img.bun === bun),
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      refusal: {
        kind: "out-of-matrix",
        message: `no trusted image matches the resolved runtime (${node ? `node ${node}` : ""}${node && bun ? ", " : ""}${bun ? `bun ${bun}` : ""}); the missing image is named. Available images: ${availableImages(table)}`,
      },
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      refusal: {
        kind: "ambiguous",
        message: `the resolved runtime matches more than one image (${candidates.map((c) => c.id).join(", ")}); pin the runtime explicitly. Available images: ${availableImages(table)}`,
      },
    };
  }
  const image = candidates[0];
  return { ok: true, image, node: image.node, bun: image.bun, notes };
}

/** Parse the runtime-version pins out of CI lane YAML text (setup-node /
 *  setup-bun `*-version:` inputs). Kept deliberately narrow: only explicit
 *  versions and simple ranges are read; anything else is ignored here and
 *  surfaces through the manifest constraints. */
export function ciConstraintsFromLanes(lanes) {
  const out = [];
  for (const lane of lanes ?? []) {
    const text = typeof lane === "string" ? lane : lane?.text ?? "";
    const file = typeof lane === "string" ? "lane" : lane?.file ?? "lane";
    for (const m of text.matchAll(/\bnode-version:\s*["']?([^"'\n]+)["']?/g)) {
      out.push({ tool: "node", range: m[1].trim(), source: `${file}:node-version` });
    }
    for (const m of text.matchAll(/\bbun-version:\s*["']?([^"'\n]+)["']?/g)) {
      out.push({ tool: "bun", range: m[1].trim(), source: `${file}:bun-version` });
    }
  }
  return out;
}

export { satisfiesRange };
