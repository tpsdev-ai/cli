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
import { extname, join, relative, sep } from "node:path";
import ts from "typescript";

/** The scheme literal whose every occurrence is enumerated. */
const SCHEME = "TPS-Ed25519";

/** Virtual root the in-memory program is built under. */
const ROOT = "/repo";

/**
 * The source extensions these packages compile, each mapped to the ScriptKind
 * that parses it. `.js`/`.jsx`/`.mjs`/`.cjs` compile only in a package whose
 * tsconfig sets `allowJs`.
 */
const SOURCE_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};

/** Extensions only an `allowJs: true` package compiles. */
const JS_KINDS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

/** The ScriptKind for a path's extension; `TS` for anything unrecognised. */
function scriptKindOf(path: string): ts.ScriptKind {
  return SOURCE_KINDS[extname(path).toLowerCase()] ?? ts.ScriptKind.TS;
}

/** True when the package's tsconfig compiles JavaScript sources. */
function allowsJs(pkgDir: string): boolean {
  try {
    const config = ts.readConfigFile(join(pkgDir, "tsconfig.json"), ts.sys.readFile);
    return config.config?.compilerOptions?.allowJs === true;
  } catch {
    return false;
  }
}

/**
 * Resolve a test file's import specifier against `testDir` to a repo-relative
 * path, mapping the emitted `.js` extension back to its source extension.
 */
function resolveSpecifier(testDir: readonly string[], spec: string): string {
  const parts = spec.startsWith(".") ? [...testDir] : [];
  for (const part of spec.replace(/\.js$/, ".ts").split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

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
    files.set(abs, ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKindOf(rel)));
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

function walkSources(dir: string, allowJs: boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      found.push(...walkSources(full, allowJs));
    } else if (entry.isFile() && !entry.name.endsWith(".d.ts")) {
      const ext = extname(entry.name).toLowerCase();
      if (!(ext in SOURCE_KINDS)) continue;
      if (JS_KINDS.has(ext) && !allowJs) continue;
      found.push(full);
    }
  }
  return found;
}

/** The source text of the files under each `packages/*\/src` whose extension its package compiles. */
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
    const pkgDir = join(packagesDir, pkg);
    const srcDir = join(pkgDir, "src");
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of walkSources(srcDir, allowsJs(pkgDir))) {
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
  inventory: Readonly<Record<string, unknown>>,
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

const STUB_FLAIR = "packages/cli/test/helpers/stub-flair.ts";
const VERIFYING_HELPERS = new Set(["startStubFlair", "installStubFlairFetch", "stubFlairHandler"]);
const REFUSAL_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual", "toContain", "toMatch", "toMatchObject", "toThrow", "toHaveProperty"]);
const TEST_ROOTS = new Set(["test", "it", "describe"]);
const RUNNING_MODIFIERS = new Set(["only", "concurrent", "serial"]);

/** Property names along a call chain, outermost first, with the root identifier and the modifier calls. */
function chainOf(start: ts.Expression): { root: string; names: string[]; mods: ts.CallExpression[] } {
  const names: string[] = [];
  const mods: ts.CallExpression[] = [];
  let e = start;
  while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) {
    if (ts.isPropertyAccessExpression(e)) names.unshift(e.name.text);
    else mods.unshift(e);
    e = e.expression;
  }
  return { root: ts.isIdentifier(e) ? e.text : "", names, mods };
}

/** A test or describe call Bun will not run (skip, todo, x-prefixed, a false condition), or whose modifiers are not recognised. */
function notRun(call: ts.CallExpression): boolean {
  const { root, names, mods } = chainOf(call.expression);
  if (/^x(test|it|describe)$/.test(root)) return true;
  if (!TEST_ROOTS.has(root)) return false;
  let cond = 0;
  for (const name of names) {
    if (RUNNING_MODIFIERS.has(name)) continue;
    const arg = name === "skipIf" || name === "if" ? mods[cond++]?.arguments[0] : undefined;
    const runs = (name === "skipIf" && arg?.kind === ts.SyntaxKind.FalseKeyword) || (name === "if" && arg?.kind === ts.SyntaxKind.TrueKeyword);
    if (!runs) return true;
  }
  return false;
}

/**
 * Why `source` (the file at repo-relative `testFile`) does not drive a signer
 * through the verifying stub, or `null`: it must import a verifying helper
 * from `stub-flair.ts` (the specifier is resolved), call it, and have an
 * `expect(...)` that names a 401, a 403 or AccessViolation.
 */
export function verifyingStubProblem(testFile: string, source: string): string | null {
  const sf = ts.createSourceFile(testFile, source, ts.ScriptTarget.Latest, true);
  const dir = testFile.split("/").slice(0, -1);
  const locals = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (resolveSpecifier(dir, stmt.moduleSpecifier.text) !== STUB_FLAIR) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (VERIFYING_HELPERS.has((el.propertyName ?? el.name).text)) locals.add(el.name.text);
    }
  }
  if (locals.size === 0) return `${testFile} imports no verifying helper from ${STUB_FLAIR}`;
  let called = false;
  let refusal = false;
  /** True for `expect(...)` and for any matcher chain rooted at it, e.g. `expect(x).rejects.toThrow(...)`. */
  const rootedAtExpect = (call: ts.CallExpression): boolean => {
    let e: ts.Expression = call.expression;
    while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
    return ts.isIdentifier(e) && e.text === "expect";
  };
  /** Inside an expect whose matcher is a listed one and whose chain has no `.not`. */
  const positiveRefusal = (node: ts.Node): boolean => {
    let matched = false;
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      if (!ts.isCallExpression(n) || !rootedAtExpect(n)) continue;
      const { names } = chainOf(n.expression);
      if (names.includes("not")) return false;
      if (names.some((name) => REFUSAL_MATCHERS.has(name))) matched = true;
    }
    return matched;
  };
  let skipped = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && notRun(node)) {
      skipped = true;
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && locals.has(node.expression.text)) called = true;
    const refusalText =
      (ts.isNumericLiteral(node) && /^(401|403)$/.test(node.text)) ||
      ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && /\b(401|403)\b|AccessViolation/.test(node.text));
    if (refusalText && positiveRefusal(node)) refusal = true;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const why = skipped ? " outside skipped or unclassifiable tests" : "";
  if (!called) return `${testFile} imports a verifying helper but never calls it${why}`;
  if (!refusal) return `${testFile} has no refusal assertion (an expect naming 401, 403 or AccessViolation)${why}`;
  return null;
}

/**
 * A production signer's mapping: the test file that drives it against the
 * verifying stub, and the runtime entry point through which that test reaches
 * the signer.
 */
export interface SignerMapping {
  /** Repo-relative path of the test file. */
  test: string;
  /**
   * `<repo-relative module>#<export>` for an exported function the test calls,
   * or `<repo-relative module>#<ExportedClass>.<method>` for a method the test
   * calls on an instance of an exported class.
   */
  entry: string;
}

/** Parsed source files, shared by every program built over the same sources object. */
const parsed = new WeakMap<object, Map<string, ts.SourceFile>>();

/** A type-checked program rooted at one test file, over the scanned sources. */
function testProgram(sources: Readonly<Record<string, string>>, testFile: string, testSource: string) {
  let cache = parsed.get(sources);
  if (!cache) parsed.set(sources, (cache = new Map()));
  const testAbs = `${ROOT}/${testFile}`;
  const testSf = ts.createSourceFile(testAbs, testSource, ts.ScriptTarget.Latest, true, scriptKindOf(testFile));
  const dirs = new Set<string>();
  for (const rel of [...Object.keys(sources), testFile]) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${ROOT}/${parts.slice(0, i).join("/")}`);
  }
  const textOf = (abs: string): string | undefined =>
    abs === testAbs ? testSource : abs.startsWith(`${ROOT}/`) ? sources[abs.slice(ROOT.length + 1)] : undefined;
  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      if (name === testAbs) return testSf;
      const text = textOf(name);
      if (text === undefined) return undefined;
      let sf = cache.get(name);
      if (!sf || sf.text !== text) {
        sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, scriptKindOf(name));
        cache.set(name, sf);
      }
      return sf;
    },
    fileExists: (name) => textOf(name) !== undefined,
    readFile: textOf,
    directoryExists: (dir) => dirs.has(dir),
    getDirectories: () => [],
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const options: ts.CompilerOptions = {
    noLib: true,
    types: [],
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const program = ts.createProgram([testAbs], options, host);
  return { program, checker: program.getTypeChecker(), testSf: program.getSourceFile(testAbs) ?? testSf };
}

/** True when an import binding (specifier, default name or namespace) is erased at runtime. */
function typeOnlyImport(decl: ts.Declaration): boolean {
  if (ts.isImportSpecifier(decl)) return decl.isTypeOnly || decl.parent.parent.isTypeOnly;
  if (ts.isImportClause(decl)) return decl.isTypeOnly;
  if (ts.isNamespaceImport(decl)) return decl.parent.isTypeOnly;
  return false;
}

/**
 * True when `node` sits in the callback of a `test`/`it` call Bun runs, with no
 * skipped, todo or unclassifiable `test`/`it`/`describe` call around it.
 */
function inRunningTest(node: ts.Node): boolean {
  let inTest = false;
  for (let n: ts.Node = node; n.parent; n = n.parent) {
    const parent = n.parent;
    if (!ts.isCallExpression(parent)) continue;
    if (notRun(parent)) return false;
    const { root } = chainOf(parent.expression);
    if ((root === "test" || root === "it") && ts.isFunctionLike(n) && parent.arguments.includes(n as ts.Expression))
      inTest = true;
  }
  return inTest;
}

/**
 * Why the test at `mapping.test` does not drive its signer through
 * `mapping.entry`, or `null`. `sources` are the scanned package sources
 * (`readSources`) and `testSource` is the test file's text.
 *
 * The test must
 *   - import the entry's export (the function, or the class of a method entry)
 *     as a VALUE: a type-only import (`import type`, or an inline `type`
 *     specifier) is erased at runtime and does not count;
 *   - for a method entry, construct the class (`new`) through that import; and
 *   - call the entry inside a `test`/`it` callback that Bun runs: a call outside
 *     any test, or inside a skipped, todo, x-prefixed or false-conditioned
 *     `test`/`it`/`describe`, does not count.
 *
 * A call matches by symbol, through the type checker: `runDashboard(...)` must
 * resolve to the entry function itself (another export of the same module does
 * not match), and `x.getAgent(...)` must resolve to the entry class's method.
 *
 * THE LIMIT, STATED: the check is lexical. A call written in a running test's
 * callback counts even when it sits in a branch that never executes, after an
 * early return, or in a nested function nothing invokes; calls in unreachable
 * code within a test are out of scope. A call made from another module (a
 * shared test helper) is not seen. That the entry reaches the signer is the
 * inventory's claim, not the check's: the evidence for each mapping is that the
 * mapped test fails when the signer is made to return no authorization.
 */
export function signerDrivingProblem(
  mapping: SignerMapping,
  testSource: string,
  sources: Readonly<Record<string, string>>,
): string | null {
  const { test: testFile, entry } = mapping;
  const [module, qualified] = entry.split("#");
  const [exportName, method] = (qualified ?? "").split(".");
  if (!module || !exportName) return `entry ${entry} is not <module>#<export> or <module>#<Class>.<method>`;
  if (!Object.hasOwn(sources, module)) return `entry module ${module} is not a scanned source`;

  const what = method ? `${exportName} (the class of ${entry})` : exportName;
  const noImport = `${testFile} has no value import of ${what} from ${module}`;
  const { program, checker, testSf } = testProgram(sources, testFile, testSource);
  const moduleSf = program.getSourceFile(`${ROOT}/${module}`);
  const moduleSym = moduleSf && checker.getSymbolAtLocation(moduleSf);
  if (!moduleSym) return noImport;
  const resolveAlias = (sym: ts.Symbol | undefined): ts.Symbol | undefined => {
    let s = sym;
    for (let i = 0; s && s.flags & ts.SymbolFlags.Alias && i < 20; i++) s = checker.getAliasedSymbol(s);
    return s;
  };
  const exported = resolveAlias(checker.getExportsOfModule(moduleSym).find((s) => s.name === exportName));
  if (!exported) return `entry ${entry}: ${module} does not export ${exportName}`;
  const target = method ? exported.members?.get(ts.escapeLeadingUnderscores(method)) : exported;
  if (!target) return `entry ${entry}: ${exportName} has no method ${method}`;
  /** True when a property access names the entry method (matched by its declaration). */
  const isTargetMethod = (name: ts.MemberName): boolean => {
    const sym = resolveAlias(checker.getSymbolAtLocation(name));
    return !!sym?.declarations?.some((d) => target.declarations?.includes(d));
  };

  /** The import binding an identifier names, when it is one. */
  const importOf = (id: ts.Identifier): ts.Declaration | undefined => {
    const sym = checker.getSymbolAtLocation(id);
    const decl = sym && sym.flags & ts.SymbolFlags.Alias ? sym.declarations?.[0] : undefined;
    return decl && (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) ? decl : undefined;
  };
  /** True when `expr` (an identifier, or `ns.name`) reaches `exported` through a value import. */
  const viaValueImport = (expr: ts.Expression): boolean => {
    let root = expr;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    if (!ts.isIdentifier(root)) return false;
    const decl = importOf(root);
    if (!decl || typeOnlyImport(decl)) return false;
    const named = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
    return resolveAlias(checker.getSymbolAtLocation(named)) === exported;
  };

  let imported = false;
  let typeOnly = false;
  let constructed = false;
  let called = false;
  let calledOutside = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      for (const id of importedNames(node)) {
        const decl = importOf(id);
        if (!decl) continue;
        const sym = resolveAlias(checker.getSymbolAtLocation(id));
        const reaches = sym === exported || (ts.isNamespaceImport(decl) && sym === moduleSym);
        if (!reaches) continue;
        if (typeOnlyImport(decl)) typeOnly = true;
        else imported = true;
      }
    }
    if (ts.isNewExpression(node) && viaValueImport(node.expression)) constructed = true;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const hit = method
        ? ts.isPropertyAccessExpression(callee) && isTargetMethod(callee.name)
        : viaValueImport(callee);
      if (hit) {
        if (inRunningTest(node)) called = true;
        else calledOutside = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(testSf);

  if (!imported) return `${noImport}${typeOnly ? " (only a type-only import)" : ""}`;
  if (method && !constructed) return `${testFile} never constructs ${exportName} through its import`;
  if (!called)
    return `${testFile} never calls ${entry} inside a running test${calledOutside ? " (only outside a test, or in a skipped or todo one)" : ""}`;
  return null;
}

/** The local identifiers an import declaration binds. */
function importedNames(stmt: ts.ImportDeclaration): ts.Identifier[] {
  const clause = stmt.importClause;
  if (!clause) return [];
  const out: ts.Identifier[] = [];
  if (clause.name) out.push(clause.name);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) out.push(bindings.name);
  else if (bindings) for (const el of bindings.elements) out.push(el.name);
  return out;
}
