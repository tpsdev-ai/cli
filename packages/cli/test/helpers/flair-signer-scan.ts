/**
 * flair-signer-scan.ts — locate the production code that SIGNS a Flair request.
 *
 * cli#554: a Flair stub that answers a caller whose TPS-Ed25519 credentials it
 * never verified lets a test keep passing after the production client's request
 * signing breaks. The narrowed fix pins each production signing path to a test
 * that drives it against `helpers/stub-flair.ts`, which verifies the caller.
 *
 * A "signer" here is a production function that EMITS the authorization header
 * the Flair client sends:
 *
 *   Authorization: TPS-Ed25519 <agentId>:<timestamp>:<nonce>:<signature>
 *
 * The header is built in a template literal beginning `TPS-Ed25519 `. A verifier
 * reads the same prefix from a plain string literal (`startsWith("TPS-Ed25519 ")`),
 * so scanning only template literals separates producers from consumers. The
 * scan covers every package's `src/` — the cli's signed client commands and the
 * agent's Flair context provider.
 *
 * Each site is keyed `<repo-relative path>#<Class.>function`, stable across line
 * edits, so an inventory test can map each site to a test file (or an explicit
 * exclusion) and fail when a new signing site appears or a mapped one
 * disappears.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** The fixed prefix of the Flair authorization header. */
const HEADER_PREFIX = "TPS-Ed25519 ";

export interface SignerSite {
  /** `<repo-relative path>#<Class.>function` — the stable identity of a signer. */
  key: string;
  /** Repo-relative POSIX path of the source file. */
  file: string;
  /** 1-based line of the header template. */
  line: number;
}

/** The nearest enclosing function/class name for a node, as `Class.fn` or `fn`. */
function enclosingSymbol(node: ts.Node): string {
  let className: string | null = null;
  let fnName: string | null = null;
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (fnName === null) {
      if (ts.isFunctionDeclaration(n) && n.name) fnName = n.name.text;
      else if (ts.isMethodDeclaration(n) && n.name && ts.isIdentifier(n.name)) fnName = n.name.text;
      else if (ts.isFunctionExpression(n) && n.name) fnName = n.name.text;
      else if (
        (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
        ts.isVariableDeclaration(n.parent) &&
        ts.isIdentifier(n.parent.name)
      )
        fnName = n.parent.name.text;
      else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) fnName = n.name.text;
    }
    if (ts.isClassDeclaration(n) && n.name) className = n.name.text;
  }
  return className ? `${className}.${fnName ?? "<anonymous>"}` : (fnName ?? "<anonymous>");
}

/** Every signer site in one source file. `file` is repo-relative (POSIX). */
export function analyzeSignerSource(file: string, source: string): SignerSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: SignerSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node) && node.head.text.startsWith(HEADER_PREFIX)) {
      sites.push({
        key: `${file}#${enclosingSymbol(node)}`,
        file,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function walkTypeScript(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      found.push(...walkTypeScript(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(full);
    }
  }
  return found;
}

/** Every signer site in the packages' src trees under `repoRoot`, sorted by key. */
export function findSignerSites(repoRoot: string): SignerSite[] {
  const packagesDir = join(repoRoot, "packages");
  const sites: SignerSite[] = [];
  let packages: string[];
  try {
    packages = readdirSync(packagesDir);
  } catch {
    return sites;
  }
  for (const pkg of packages) {
    const srcDir = join(packagesDir, pkg, "src");
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of walkTypeScript(srcDir)) {
      const rel = relative(repoRoot, file).split(sep).join("/");
      sites.push(...analyzeSignerSource(rel, readFileSync(file, "utf8")));
    }
  }
  return sites.sort((a, b) => a.key.localeCompare(b.key));
}

/** A signer the inventory deliberately does not map, with the reason. */
export interface SignerExclusion {
  reason: string;
}

export interface InventoryCheck {
  /** Sites with neither an inventory entry nor an exclusion — a new signer. */
  unmapped: string[];
  /** Inventory entries whose site no longer exists — a removed signer. */
  stale: string[];
  /** Exclusions whose site no longer exists — a stale exclusion. */
  staleExclusions: string[];
}

/**
 * Compare the signer sites a scan found against the inventory table and the
 * exclusion table. A site that is neither mapped nor excluded, an inventory
 * entry with no site, and an exclusion with no site are each a failure.
 */
export function checkSignerInventory(
  sites: readonly SignerSite[],
  inventory: Readonly<Record<string, string>>,
  excluded: Readonly<Record<string, SignerExclusion>>,
): InventoryCheck {
  const keys = new Set(sites.map((s) => s.key));
  const mapped = new Set(Object.keys(inventory));
  const excused = new Set(Object.keys(excluded));
  return {
    unmapped: [...keys].filter((k) => !mapped.has(k) && !excused.has(k)).sort(),
    stale: [...mapped].filter((k) => !keys.has(k)).sort(),
    staleExclusions: [...excused].filter((k) => !keys.has(k)).sort(),
  };
}
