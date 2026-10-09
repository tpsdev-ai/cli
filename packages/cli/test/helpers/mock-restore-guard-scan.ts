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

/**
 * Roots whose members are guarded globals: whatever the right-hand side, an
 * assignment to one must go through patchShared. globalThis/Date/process/
 * console match the runtime guard's snapshot objects; Bun is the runtime's
 * own global object.
 */
const GUARDED_GLOBAL_ROOTS = new Set(["globalThis", "global", "Date", "process", "console", "Bun"]);

/** Bare global identifiers that name a global the runtime guard snapshots. */
const GUARDED_BARE_GLOBALS = new Set(["fetch", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "setImmediate", "clearImmediate", "queueMicrotask"]);

/** True when the target is a guarded global or a member of an imported module object. */
function guardedTarget(lhs: ts.Expression, moduleObjects: Map<string, string>, declared: Set<string>): boolean {
  const node = unwrap(lhs);
  if (ts.isIdentifier(node)) return GUARDED_BARE_GLOBALS.has(node.text) && !declared.has(node.text);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const root = targetRoot(node);
    if (root === undefined) return false;
    if (moduleObjects.has(root)) return true;
    if (!GUARDED_GLOBAL_ROOTS.has(root) || declared.has(root)) return false;
    // process.env is the env-leak preload's object, not a guarded global.
    return !(root === "process" && /^process\.env(?:$|\.|\[)/.test(node.getText()));
  }
  return false;
}

function directAssignmentFinding(assignment: ts.BinaryExpression, moduleObjects: Map<string, string>,
  declared: Set<string>, mockValue: (node: ts.Expression) => boolean): Finding | undefined {
  const detail = `assignment to '${assignment.left.getText()}' requires patchShared; inline restoration is refused`;
  if (guardedTarget(assignment.left, moduleObjects, declared)) {
    return { kind: "direct-assignment-needs-restore", detail };
  }
  const root = targetRoot(assignment.left);
  if (!root) {
    if (!mockValue(assignment.right)) return undefined;
    return { kind: "unclassified-assignment-target", detail: `cannot classify mock assignment target: ${assignment.left.getText()}` };
  }
  if (!mockValue(assignment.right)) return undefined;
  return { kind: "direct-assignment-needs-restore", detail };
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

/**
 * Identifiers bound anywhere in the file: imports, variables, functions, classes
 * and parameters. A guarded global's name that is locally bound belongs to the
 * local, not the global, so the scan skips it.
 */
function declaredNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const addName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) addName(element.name);
  };
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name) names.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings) {
        if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
        else for (const element of bindings.elements) names.add(element.name.text);
      }
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) addName(node.name);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/**
 * Every identifier that names an imported module object or derives from one, by
 * plain alias, destructuring or a property read. A member assignment on such an
 * identifier is reported as a member assignment on the module object, so an
 * alias no longer hides it.
 */
function moduleObjectNames(file: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) names.set(clause.name.text, statement.moduleSpecifier.text);
    const namedBindings = clause.namedBindings;
    if (!namedBindings) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      names.set(namedBindings.name.text, statement.moduleSpecifier.text);
    } else {
      for (const element of namedBindings.elements) {
        if (!element.isTypeOnly) names.set(element.name.text, statement.moduleSpecifier.text);
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    const derived = (node: ts.Expression): boolean => {
      node = unwrap(node);
      if (ts.isIdentifier(node)) return names.has(node.text);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return derived(node.expression);
      return false;
    };
    const add = (name: string): void => {
      if (!names.has(name)) { names.set(name, "<alias>"); changed = true; }
    };
    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          if (derived(node.initializer)) add(node.name.text);
        } else if ((ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) &&
          derived(node.initializer)) {
          for (const element of node.name.elements) {
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) add(element.name.text);
          }
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const left = unwrap(node.left);
        if (ts.isIdentifier(left) && derived(node.right)) add(left.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
  return names;
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
  const moduleObjects = moduleObjectNames(file);
  const declared = declaredNames(file);
  const mockValue = mockValues(file, bindings);
  let moduleMocks = 0;
  const named = new Set([...bindings.named.values()].filter((name) => MOCK_API.has(name)));
  const directAssignments: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const finding = directAssignmentFinding(node, moduleObjects, declared, mockValue);
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
