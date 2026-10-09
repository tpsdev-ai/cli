/**
 * flair-signer-scan.ts — enumerate every use of the Flair authorization scheme
 * literal in the packages' src trees.
 *
 * cli#554: a Flair stub that answers a caller whose TPS-Ed25519 credentials it
 * never verified lets a test keep passing after the production client's request
 * signing breaks. The scan is a whitelist over the LITERAL, not over one syntax:
 * it lists
 *
 *   - every occurrence of the string `TPS-Ed25519` in a string literal, a
 *     no-substitution template, or any part of a template expression (so a
 *     concatenation operand or a `.join` element counts too), and
 *   - every reference to a binding whose initializer contains such an
 *     occurrence, following const aliases and re-exports through the type
 *     checker.
 *
 * A reference the scan cannot resolve (a destructuring pattern, a class field,
 * an identifier the checker has no symbol for) is reported in `unresolved`.
 *
 * Each site is keyed `<repo-relative path>#<Class.>function` (a module-level
 * binding is keyed by its name), stable across line edits, so an inventory test
 * can classify each site as a signer mapped to a test or as an explicit
 * non-signer, and fail on an unclassified or stale entry.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** The scheme literal whose every occurrence is enumerated. */
const SCHEME = "TPS-Ed25519";

/** Virtual root the in-memory program is built under. */
const ROOT = "/repo";

export interface SignerSite {
  /** `<repo-relative path>#<Class.>function` — the stable identity of a site. */
  key: string;
  /** Repo-relative POSIX path of the source file. */
  file: string;
  /** 1-based line of the first occurrence or reference for this key. */
  line: number;
}

export interface SignerScan {
  /** One site per key, sorted by key. */
  sites: SignerSite[];
  /** Occurrences or references the scan could not resolve; each is a failure. */
  unresolved: string[];
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
    }
    if (ts.isClassDeclaration(n) && n.name) className = n.name.text;
  }
  return className ? `${className}.${fnName ?? "<anonymous>"}` : (fnName ?? "<anonymous>");
}

/** True for a node that carries literal text containing the scheme. */
function carriesScheme(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.includes(SCHEME);
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
    return node.text.includes(SCHEME);
  return false;
}

/**
 * The binding a node's value flows into without crossing a function boundary:
 * the variable declaration whose initializer contains it, `null` when it flows
 * nowhere nameable, or `"unresolved"` for a pattern or class field.
 */
function owningBinding(node: ts.Node): ts.VariableDeclaration | null | "unresolved" {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) || ts.isSourceFile(n)) return null;
    if (ts.isPropertyDeclaration(n)) return "unresolved";
    if (ts.isVariableDeclaration(n)) return ts.isIdentifier(n.name) ? n : "unresolved";
  }
  return null;
}

function isModuleLevel(decl: ts.VariableDeclaration): boolean {
  return ts.isSourceFile(decl.parent.parent.parent);
}

function siteKey(file: string, node: ts.Node): string {
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) && isModuleLevel(node.parent))
    return `${file}#${node.parent.name.text}`;
  return `${file}#${enclosingSymbol(node)}`;
}

function inImport(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) if (ts.isImportDeclaration(n)) return true;
  return false;
}

/** Scan an in-memory source tree (repo-relative POSIX path -> text). */
export function scanSources(sources: Readonly<Record<string, string>>): SignerScan {
  const files = new Map<string, ts.SourceFile>();
  for (const [rel, text] of Object.entries(sources)) {
    const abs = `${ROOT}/${rel}`;
    files.set(abs, ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  }
  const options: ts.CompilerOptions = {
    noLib: true,
    types: [],
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name) => files.get(name),
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name)?.text,
    directoryExists: (dir) => [...files.keys()].some((f) => f.startsWith(`${dir}/`)),
    getDirectories: () => [],
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();

  const byKey = new Map<string, SignerSite>();
  const unresolved: string[] = [];
  const rel = (sf: ts.SourceFile) => sf.fileName.slice(ROOT.length + 1);
  const add = (sf: ts.SourceFile, node: ts.Node, key: string) => {
    if (byKey.has(key)) return;
    byKey.set(key, { key, file: rel(sf), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };

  const resolve = (sym: ts.Symbol | undefined): ts.Symbol | undefined => {
    let s = sym;
    for (let i = 0; s && s.flags & ts.SymbolFlags.Alias && i < 20; i++) {
      try {
        s = checker.getAliasedSymbol(s);
      } catch {
        return undefined;
      }
    }
    return s;
  };

  const sources_ = program.getSourceFiles().filter((sf) => files.has(sf.fileName));
  const tracked = new Set<ts.Symbol>();
  const trackedNames = new Set<string>();

  const track = (sf: ts.SourceFile, at: ts.Node, binding: ts.VariableDeclaration) => {
    const sym = checker.getSymbolAtLocation(binding.name);
    if (!sym) {
      unresolved.push(`${rel(sf)}:${sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1} (no symbol)`);
      return;
    }
    tracked.add(sym);
    trackedNames.add((binding.name as ts.Identifier).text);
  };

  // Pass 1: every literal occurrence.
  for (const sf of sources_) {
    const visit = (node: ts.Node): void => {
      if (carriesScheme(node)) {
        add(sf, node, siteKey(sf.fileName.slice(ROOT.length + 1), node));
        const owner = owningBinding(node);
        const at = `${rel(sf)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
        if (owner === "unresolved") unresolved.push(`${at} (pattern or class field)`);
        else if (owner) {
          add(sf, node, siteKey(rel(sf), owner.name));
          track(sf, node, owner);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Pass 2: references to tracked bindings, to a fixpoint (a reference inside
  // another binding's initializer tracks that binding too).
  for (let changed = true; changed; ) {
    changed = false;
    for (const sf of sources_) {
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && !inImport(node)) {
          const decl = node.parent;
          const isDeclName = ts.isVariableDeclaration(decl) && decl.name === node;
          if (!isDeclName) {
            let sym: ts.Symbol | undefined;
            if (ts.isShorthandPropertyAssignment(decl)) sym = checker.getShorthandAssignmentValueSymbol(decl);
            else if (ts.isExportSpecifier(decl) && !decl.parent.parent.moduleSpecifier)
              sym = checker.getExportSpecifierLocalTargetSymbol(decl);
            else sym = checker.getSymbolAtLocation(node);
            const target = resolve(sym);
            const at = `${rel(sf)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
            if (!target) {
              if (trackedNames.has(node.text) && (!ts.isPropertyAccessExpression(decl) || decl.expression === node))
                unresolved.push(`${at} (${node.text}: no symbol)`);
            } else if (tracked.has(target)) {
              add(sf, node, ts.isExportSpecifier(decl) ? `${rel(sf)}#export:${node.text}` : siteKey(rel(sf), node));
              const owner = owningBinding(node);
              if (owner === "unresolved") unresolved.push(`${at} (${node.text}: pattern or class field)`);
              else if (owner && owner.name !== node) {
                const own = checker.getSymbolAtLocation(owner.name);
                if (own && !tracked.has(own)) {
                  track(sf, node, owner);
                  changed = true;
                }
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  return {
    sites: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
    unresolved: [...new Set(unresolved)].sort(),
  };
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

/** The source text of every `packages/*\/src` TypeScript file under `repoRoot`. */
export function readSources(repoRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  const packagesDir = join(repoRoot, "packages");
  let packages: string[];
  try {
    packages = readdirSync(packagesDir);
  } catch {
    return out;
  }
  for (const pkg of packages) {
    const srcDir = join(packagesDir, pkg, "src");
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of walkTypeScript(srcDir)) {
      out[relative(repoRoot, file).split(sep).join("/")] = readFileSync(file, "utf8");
    }
  }
  return out;
}

/** Scan the packages' src trees under `repoRoot`. */
export function findSignerSites(repoRoot: string): SignerScan {
  return scanSources(readSources(repoRoot));
}

/** A site the inventory deliberately does not map to a stub-backed test, with the reason. */
export interface SignerExclusion {
  reason: string;
}

export interface InventoryCheck {
  /** Sites in neither the inventory nor the exclusions. */
  unmapped: string[];
  /** Inventory entries whose site no longer exists. */
  stale: string[];
  /** Exclusions whose site no longer exists. */
  staleExclusions: string[];
}

/**
 * Compare the sites a scan found against the inventory and exclusion tables. A
 * site in neither, an inventory entry with no site, and an exclusion with no
 * site are each a failure.
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
