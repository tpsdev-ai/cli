/** Static mock-assignment and teardown checks for cli test files. */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export type Finding =
  | { kind: "module-mock-needs-child-process"; detail: string }
  | { kind: "missing-mock-restore-teardown"; detail: string }
  | { kind: "direct-assignment-needs-restore"; detail: string }
  | { kind: "unclassified-assignment-target"; detail: string };

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function targetRoot(node: ts.Expression): string | undefined {
  node = unwrap(node);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return targetRoot(node.expression);
  return undefined;
}

function directAssignmentFinding(assignment: ts.BinaryExpression, moduleObjects: Map<string, string>,
  mockValue: (node: ts.Expression) => boolean): Finding | undefined {
  const root = targetRoot(assignment.left);
  const isMock = mockValue(assignment.right);
  if (!root) {
    if (!isMock) return undefined;
    return { kind: "unclassified-assignment-target", detail: `cannot classify mock assignment target: ${assignment.left.getText()}` };
  }
  const lhs = unwrap(assignment.left);
  const shared = root === "globalThis" || root === "global" ||
    (!ts.isIdentifier(lhs) && (moduleObjects.has(root) || ["console", "Date", "process"].includes(root)) &&
      !(root === "process" && /^process\.env(?:$|\.|\[)/.test(lhs.getText())));
  if (!isMock && !shared) return undefined;
  return {
    kind: "direct-assignment-needs-restore",
    detail: `assignment to '${assignment.left.getText()}' requires patchShared; inline restoration is refused`,
  };
}

function mockValues(file: ts.SourceFile, bindings: BunTestBindings): (node: ts.Expression) => boolean {
  const factories = new Set<string>();
  const values = new Set<string>();
  function factory(node: ts.Expression): boolean {
    node = unwrap(node);
    const exported = bindings.exportOf(node);
    if (exported === "mock" || exported === "spyOn") return true;
    if (ts.isIdentifier(node)) return factories.has(node.text) || node.text === "mock" || node.text === "spyOn";
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = ts.isPropertyAccessExpression(node) ? node.name.text :
        node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
      const base = unwrap(node.expression);
      if (ts.isIdentifier(base) && bindings.namespaces.has(base.text) && (property === "mock" || property === "spyOn")) return true;
      if ((property === "fn" || property === "spyOn") && ["jest", "vi"].includes(bindings.exportOf(base) ?? "")) return true;
      if (property === "module" && factory(base)) return true;
    }
    return false;
  }
  function value(node: ts.Expression): boolean {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return values.has(node.text);
    if (ts.isCallExpression(node)) {
      if (factory(node.expression)) return true;
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) return value(callee.expression);
    }
    if (ts.isAwaitExpression(node)) return value(node.expression);
    if (ts.isConditionalExpression(node)) return value(node.whenTrue) || value(node.whenFalse);
    if (ts.isBinaryExpression(node)) return value(node.left) || value(node.right);
    return false;
  }
  let changed = true;
  while (changed) {
    changed = false;
    const bind = (name: string, expression: ts.Expression): void => {
      for (const [set, matches] of [[factories, factory(expression)], [values, value(expression)]] as const) {
        if (matches && !set.has(name)) { set.add(name); changed = true; }
      }
    };
    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bind(node.name.text, node.initializer);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(unwrap(node.left))) {
        bind((unwrap(node.left) as ts.Identifier).text, node.right);
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
  return value;
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
  const mockValue = mockValues(file, bindings);
  let moduleMocks = 0;
  const named = new Set([...bindings.named.values()].filter((name) => MOCK_API.has(name)));
  const directAssignments: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const finding = directAssignmentFinding(node, moduleObjects, mockValue);
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
