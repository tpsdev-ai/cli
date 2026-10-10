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
function guardedTarget(lhs: ts.Expression, moduleAliases: AliasTable, guardedAliases: AliasTable): boolean {
  const node = unwrap(lhs);
  if (ts.isIdentifier(node)) return GUARDED_BARE_GLOBALS.has(node.text) && !resolveScope(node);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    if (isImportCall(rootExpression(node))) return true;
    const rootNode = rootIdentifier(node);
    if (rootNode === undefined) return false;
    if (aliasRootAt(moduleAliases, rootNode) !== undefined) return true;
    const root = guardedRootOf(rootNode, guardedAliases);
    if (root === undefined) return false;
    // process.env is the env-leak preload's object, not a guarded global.
    return !(root === "process" && isEnvMemberOf(node, rootNode));
  }
  return false;
}

/** True when the member of `rootNode` that `node` reaches through is `.env` or `["env"]`. */
function isEnvMemberOf(node: ts.Expression, rootNode: ts.Identifier): boolean {
  node = unwrap(node);
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  if (unwrap(node.expression) === rootNode) {
    return ts.isPropertyAccessExpression(node) ? node.name.text === "env" :
      ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "env";
  }
  return isEnvMemberOf(node.expression, rootNode);
}

function directAssignmentFinding(assignment: ts.BinaryExpression, moduleAliases: AliasTable,
  guardedAliases: AliasTable, mockValue: (node: ts.Expression) => boolean): Finding | undefined {
  const detail = `assignment to '${assignment.left.getText()}' requires patchShared; inline restoration is refused`;
  if (guardedTarget(assignment.left, moduleAliases, guardedAliases)) {
    return { kind: "direct-assignment-needs-restore", detail };
  }
  const root = targetRoot(assignment.left);
  if (!root) {
    const base = rootExpression(assignment.left);
    if (base.kind === ts.SyntaxKind.ThisKeyword || ts.isObjectLiteralExpression(base) || ts.isArrayLiteralExpression(base)) return undefined;
    return { kind: "unclassified-assignment-target", detail: `cannot classify assignment target: ${assignment.left.getText()}` };
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

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, out);
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
}

function hoistedVars(node: ts.Node, out: Set<string>): void {
  ts.forEachChild(node, (child) => {
    if (isFunctionLike(child)) return;
    if (ts.isVariableDeclarationList(child) && !(child.flags & ts.NodeFlags.BlockScoped)) {
      for (const declaration of child.declarations) bindingNames(declaration.name, out);
    }
    hoistedVars(child, out);
  });
}

function statementNames(statements: readonly ts.Statement[], out: Set<string>): void {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.BlockScoped) {
      for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, out);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) && statement.name) {
      out.add(statement.name.text);
    } else if (ts.isImportEqualsDeclaration(statement)) {
      out.add(statement.name.text);
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name) out.add(clause.name.text);
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) out.add(named.name.text);
      else if (named) for (const element of named.elements) out.add(element.name.text);
    }
  }
}

/** The names a scope node itself declares: parameters, lexical statements, hoisted vars or a catch binding. */
function scopeNames(node: ts.Node): Set<string> {
  const out = new Set<string>();
  if (ts.isSourceFile(node)) {
    statementNames(node.statements, out);
    hoistedVars(node, out);
  } else if (ts.isBlock(node) || ts.isModuleBlock(node)) {
    statementNames(node.statements, out);
  } else if (ts.isCaseBlock(node)) {
    for (const clause of node.clauses) statementNames(clause.statements, out);
  } else if (isFunctionLike(node)) {
    for (const parameter of node.parameters) bindingNames(parameter.name, out);
    if (ts.isFunctionExpression(node) && node.name) out.add(node.name.text);
    if (node.body) hoistedVars(node.body, out);
  } else if (ts.isCatchClause(node)) {
    if (node.variableDeclaration) bindingNames(node.variableDeclaration.name, out);
  } else if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    const initializer = node.initializer;
    if (initializer && ts.isVariableDeclarationList(initializer)) {
      for (const declaration of initializer.declarations) bindingNames(declaration.name, out);
    }
  } else if (ts.isClassExpression(node) && node.name) {
    out.add(node.name.text);
  }
  return out;
}

/** The nearest enclosing scope that declares the identifier's name, or undefined when it names a global. */
function resolveScope(id: ts.Identifier): ts.Node | undefined {
  for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
    if (scopeNames(node).has(id.text)) return node;
  }
  return undefined;
}

/** The innermost expression a member chain hangs off, without the members. */
function rootExpression(node: ts.Expression): ts.Expression {
  node = unwrap(node);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return rootExpression(node.expression);
  return node;
}

function isImportCall(node: ts.Expression): boolean {
  node = unwrap(node);
  if (ts.isAwaitExpression(node)) return isImportCall(node.expression);
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function rootIdentifier(node: ts.Expression): ts.Identifier | undefined {
  node = unwrap(node);
  if (ts.isIdentifier(node)) return node;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return rootIdentifier(node.expression);
  return undefined;
}

/** One binding's alias history in source order; a `root` of undefined ends the alias. */
type AliasEvents = { at: number; root: string | undefined }[];

/**
 * Alias events keyed by the scope that declares the binding and the binding's
 * name. A read takes the last event at or before its position, so an assignment
 * that rebinds the name ends the alias for the reads after it.
 */
type AliasTable = Map<ts.Node, Map<string, AliasEvents>>;

function aliasEvents(table: AliasTable, scope: ts.Node, name: string): AliasEvents {
  let byName = table.get(scope);
  if (!byName) table.set(scope, (byName = new Map()));
  let events = byName.get(name);
  if (!events) byName.set(name, (events = []));
  return events;
}

/** The alias root a binding names at this identifier's position, or undefined. */
function aliasRootAt(table: AliasTable, id: ts.Identifier): string | undefined {
  const scope = resolveScope(id);
  if (!scope) return undefined;
  const events = table.get(scope)?.get(id.text);
  if (!events) return undefined;
  const at = id.getStart();
  let root: string | undefined;
  for (const event of events) if (event.at <= at) root = event.root;
  return root;
}

/** Establishes the alias when `root` is set; ends it otherwise, or is a no-op when it never began. */
function recordAlias(table: AliasTable, target: ts.Identifier, root: string | undefined): void {
  const scope = resolveScope(target);
  if (!scope) return;
  if (root === undefined && !table.get(scope)?.get(target.text)?.length) return;
  aliasEvents(table, scope, target.text).push({ at: target.getStart(), root });
}

/** Every identifier a binding pattern introduces, nested patterns included. */
function bindingIdentifiers(name: ts.BindingName, out: ts.Identifier[]): void {
  if (ts.isIdentifier(name)) out.push(name);
  else for (const element of name.elements) if (ts.isBindingElement(element)) bindingIdentifiers(element.name, out);
}

/** The guarded global root an identifier names, directly or through an alias of one. */
function guardedRootOf(id: ts.Identifier, aliases: AliasTable): string | undefined {
  const root = aliasRootAt(aliases, id);
  if (root !== undefined) return root;
  return resolveScope(id) === undefined && GUARDED_GLOBAL_ROOTS.has(id.text) ? id.text : undefined;
}

/** The bindings that name a guarded global root, directly or through another such binding. */
function guardedAliasNames(file: ts.SourceFile): AliasTable {
  const aliases: AliasTable = new Map();
  const walk = (node: ts.Node): void => {
    let target: ts.Identifier | undefined;
    let value: ts.Expression | undefined;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      target = node.name;
      value = node.initializer;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrap(node.left);
      if (ts.isIdentifier(left)) { target = left; value = node.right; }
    }
    if (target && value) {
      const source = rootIdentifier(value);
      const root = source ? guardedRootOf(source, aliases) : undefined;
      // process.env is the env-leak preload's object, not a guarded global.
      recordAlias(aliases, target, root === "process" && source && isEnvMemberOf(value, source) ? undefined : root);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return aliases;
}

/**
 * Every binding that names an imported module object or derives from one, by
 * plain alias, destructuring or a property read. A member assignment on such a
 * binding is reported as a member assignment on the module object, so an alias
 * no longer hides it, and a rebinding to a local value ends the alias.
 */
function moduleObjectAliases(file: ts.SourceFile): AliasTable {
  const aliases: AliasTable = new Map();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    if (clause.name) recordAlias(aliases, clause.name, specifier);
    const namedBindings = clause.namedBindings;
    if (!namedBindings) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      recordAlias(aliases, namedBindings.name, specifier);
    } else {
      for (const element of namedBindings.elements) if (!element.isTypeOnly) recordAlias(aliases, element.name, specifier);
    }
  }
  const derived = (node: ts.Expression): boolean => {
    node = unwrap(node);
    if (isImportCall(node)) return true;
    if (ts.isIdentifier(node)) return aliasRootAt(aliases, node) !== undefined;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return derived(node.expression);
    return false;
  };
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        recordAlias(aliases, node.name, derived(node.initializer) ? "<alias>" : undefined);
      } else if ((ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) &&
        derived(node.initializer)) {
        const bound: ts.Identifier[] = [];
        bindingIdentifiers(node.name, bound);
        for (const name of bound) recordAlias(aliases, name, "<alias>");
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = unwrap(node.left);
      if (ts.isIdentifier(left)) recordAlias(aliases, left, derived(node.right) ? "<alias>" : undefined);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return aliases;
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
  const moduleAliases = moduleObjectAliases(file);
  const guardedAliases = guardedAliasNames(file);
  const mockValue = mockValues(file, bindings);
  let moduleMocks = 0;
  const named = new Set([...bindings.named.values()].filter((name) => MOCK_API.has(name)));
  const directAssignments: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const finding = directAssignmentFinding(node, moduleAliases, guardedAliases, mockValue);
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
