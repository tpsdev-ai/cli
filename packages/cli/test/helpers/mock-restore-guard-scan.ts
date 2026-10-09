/**
 * mock-restore-guard-scan.ts — the static check behind the cli#555 guard,
 * extended by cli#568.
 *
 * A cli test file runs in ONE bun process with every other test file the suite
 * loads, so a spy, a module mock or a value left on a global changes what a
 * later file observes (cli#544: a prototype `connect` spy made two transport
 * tests time out only in suite order).
 *
 * The check parses a test file's source with the TypeScript compiler and
 * reports:
 *   - `module-mock-needs-child-process`: the file calls `mock.module(...)`.
 *     Measured on bun 1.3.10, `mock.restore()` does not undo a module mock
 *     (mock-restore-guard.test.ts runs that probe), so such a file needs
 *     child-process isolation.
 *   - `missing-mock-restore-teardown`: the file names a mock API without the
 *     teardown that clears it.
 *   - `direct-assignment-needs-restore`: the file assigns to a global (other
 *     than a `globalThis` name the runtime preload checks: guarded-globals.ts)
 *     or to a property of an imported module object, outside the `patchShared`
 *     helper — `mock.restore()` does not undo such an assignment, so it leaks
 *     into later files.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { RUNTIME_GLOBALS } from "./guarded-globals.js";

export type Finding =
  | { kind: "module-mock-needs-child-process"; detail: string }
  | { kind: "missing-mock-restore-teardown"; detail: string }
  | { kind: "direct-assignment-needs-restore"; detail: string };

/**
 * One direct assignment that leaks: to a global (not a runtime-checked
 * `globalThis` name) or to a property of an imported module object. `patchShared`
 * is the sanctioned form and performs the assignment itself, so a file using it
 * has no such assignment to report.
 */
function directAssignmentFinding(assignment: ts.BinaryExpression, moduleObjects: Map<string, string>): Finding | undefined {
  const lhs = assignment.left;
  let base: string | undefined;
  let property: string | undefined;
  let computed = false;
  if (ts.isPropertyAccessExpression(lhs) && !lhs.questionDotToken && ts.isIdentifier(lhs.expression)) {
    base = lhs.expression.text;
    property = lhs.name.text;
  } else if (ts.isElementAccessExpression(lhs) && !lhs.questionDotToken && ts.isIdentifier(lhs.expression)) {
    base = lhs.expression.text;
    const argument = lhs.argumentExpression;
    if (argument && ts.isStringLiteral(argument)) property = argument.text;
    else computed = true;
  } else {
    return undefined;
  }
  if (moduleObjects.has(base)) {
    const where = computed ? "" : `.${property}`;
    return {
      kind: "direct-assignment-needs-restore",
      detail: `assigns to the imported module object '${base}'${where} without the patchShared helper, which mock.restore() does not undo`,
    };
  }
  if (base === "globalThis" || base === "global") {
    if (!computed && property !== undefined && base === "globalThis" && RUNTIME_GLOBALS.has(property)) return undefined;
    const where = computed ? "[…]" : `.${property}`;
    return {
      kind: "direct-assignment-needs-restore",
      detail: `assigns to the global '${base}${where}' without the patchShared helper, and it is not a globalThis name the runtime preload checks`,
    };
  }
  return undefined;
}

/** The identifiers that make a file need the teardown. */
const MOCK_API = new Set(["spyOn", "mock", "jest", "vi"]);

function isMockRestoreCall(node: ts.Expression, bindings: BunTestBindings): boolean {
  return (
    ts.isCallExpression(node) &&
    !node.questionDotToken &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    !node.expression.questionDotToken &&
    bindings.exportOf(node.expression.expression) === "mock" &&
    node.expression.name.text === "restore"
  );
}

/** `afterEach(() => { mock.restore(); })` or `afterEach(() => mock.restore())`. */
function isRestoreTeardown(statement: ts.Statement, bindings: BunTestBindings): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  const call = statement.expression;
  if (!ts.isCallExpression(call) || call.questionDotToken || call.arguments.length !== 1) return false;
  if (bindings.exportOf(call.expression) !== "afterEach") return false;
  const hook = call.arguments[0]!;
  if (!ts.isArrowFunction(hook) || hook.parameters.length !== 0 || hook.modifiers?.length) return false;
  if (!ts.isBlock(hook.body)) return isMockRestoreCall(hook.body, bindings);
  const [only, ...rest] = hook.body.statements;
  return rest.length === 0 && only !== undefined && ts.isExpressionStatement(only) && isMockRestoreCall(only.expression, bindings);
}

class BunTestBindings {
  readonly named = new Map<string, string>();
  readonly namespaces = new Set<string>();
  unresolved = false;

  constructor(file: ts.SourceFile) {
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (statement.moduleSpecifier.text !== "bun:test") continue;
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) this.unresolved = true;
      const bindings = clause.namedBindings;
      if (!bindings) continue;
      if (ts.isNamespaceImport(bindings)) {
        this.namespaces.add(bindings.name.text);
      } else {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) this.named.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    }
  }

  exportOf(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node)) {
      if ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
        ts.isTypeQueryNode(node.parent)) return undefined;
      return this.named.get(node.text);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      !node.questionDotToken &&
      ts.isIdentifier(node.expression) &&
      this.namespaces.has(node.expression.text)
    ) return node.name.text;
    return undefined;
  }
}

/** Every finding this check reports for one file's source. */
export function analyzeSource(source: string): Finding[] {
  const file = ts.createSourceFile("guarded.test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = new BunTestBindings(file);
  const moduleObjects = new Map<string, string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) moduleObjects.set(clause.name.text, statement.moduleSpecifier.text);
    const namedBindings = clause.namedBindings;
    if (!namedBindings) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      moduleObjects.set(namedBindings.name.text, statement.moduleSpecifier.text);
    } else {
      for (const element of namedBindings.elements) {
        if (!element.isTypeOnly) moduleObjects.set(element.name.text, statement.moduleSpecifier.text);
      }
    }
  }
  let moduleMocks = 0;
  const named = new Set([...bindings.named.values()].filter((name) => MOCK_API.has(name)));
  const directAssignments: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const finding = directAssignmentFinding(node, moduleObjects);
      if (finding) directAssignments.push(finding);
    }
    const exported = bindings.exportOf(node);
    if (exported && MOCK_API.has(exported)) named.add(exported);
    if (exported === "mock") {
      const parent = node.parent;
      if (!((ts.isCallExpression(parent) && parent.expression === node && !parent.questionDotToken) ||
        (ts.isPropertyAccessExpression(parent) && parent.expression === node && !parent.questionDotToken))) {
        bindings.unresolved = true;
      }
    }
    if (ts.isPropertyAccessExpression(node) && bindings.exportOf(node.expression) === "mock" &&
      node.name.text === "module" && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      bindings.unresolved = true;
    }
    if (ts.isIdentifier(node) && MOCK_API.has(node.text)) named.add(node.text);
    if (ts.isIdentifier(node) && bindings.namespaces.has(node.text)) {
      if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node || node.parent.questionDotToken) {
        bindings.unresolved = true;
      }
    }
    if (
      (ts.isCallExpression(node) && node.arguments.some((arg) => ts.isStringLiteral(arg) && arg.text === "bun:test") &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) ||
      (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression) && node.moduleReference.expression.text === "bun:test")
    ) bindings.unresolved = true;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (bindings.exportOf(node.expression.expression) === "mock" ||
        (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "mock")) &&
      node.expression.name.text === "module"
    ) {
      moduleMocks++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const findings: Finding[] = [];
  findings.push(...directAssignments);
  if (moduleMocks > 0) {
    findings.push({
      kind: "module-mock-needs-child-process",
      detail: `${moduleMocks} mock.module() call(s): mock.restore() does not undo a module mock on bun 1.3.10, so a shared-process test file must not register one`,
    });
  }
  if (named.size > 0 || bindings.unresolved) {
    const hasTeardown = !bindings.unresolved && file.statements.some((statement) => isRestoreTeardown(statement, bindings));
    if (!hasTeardown) {
      findings.push({
        kind: "missing-mock-restore-teardown",
        detail: bindings.unresolved
          ? "unresolved bun:test binding or access"
          : `names ${[...named].sort().join(", ")} without a top-level afterEach(() => { mock.restore(); }) (afterEach and mock imported from "bun:test")`,
      });
    }
  }
  return findings;
}

/**
 * Every `*.test.ts` file under `rootDir`, recursively, sorted. Dot-directories
 * and `node_modules` are skipped (bun does not descend into them, and neither
 * does this walk); other directories, including `dist/`, are walked.
 */
export function discoverCliTestFiles(rootDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name));
      } else if (/\.test\.ts$/.test(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(rootDir);
  return found.sort();
}
