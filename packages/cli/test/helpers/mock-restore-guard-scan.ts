/**
 * mock-restore-guard-scan.ts — the static check behind the cli#555 guard.
 *
 * A cli test file runs in ONE bun process with every other test file the suite
 * loads, so a spy or a module mock a file leaves in place changes what a later
 * file observes (cli#544: a prototype `connect` spy made two transport tests
 * time out only in suite order).
 *
 * The check parses a test file's source with the TypeScript compiler and
 * reports:
 *   - `module-mock-needs-child-process`: the file calls `mock.module(...)`.
 *     Measured on bun 1.3.10, `mock.restore()` does not undo a module mock
 *     (mock-restore-guard.test.ts runs that probe), so such a file needs
 *     child-process isolation.
 *   - `missing-mock-restore-teardown`: the file contains `spyOn`, `mock`,
 *     `jest` or `vi` as an identifier, and none of its top-level statements is
 *     one of
 *         afterEach(() => { mock.restore(); });
 *         afterEach(() => mock.restore());
 *     with `afterEach` and `mock` imported under those names from "bun:test".
 *     No other cleanup form is credited.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export type Finding =
  | { kind: "module-mock-needs-child-process"; detail: string }
  | { kind: "missing-mock-restore-teardown"; detail: string };

/** The identifiers that make a file need the teardown. */
const MOCK_API = new Set(["spyOn", "mock", "jest", "vi"]);

/** `mock.restore()` with no arguments, `mock` an identifier. */
function isMockRestoreCall(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    !node.questionDotToken &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    !node.expression.questionDotToken &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "mock" &&
    node.expression.name.text === "restore"
  );
}

/** `afterEach(() => { mock.restore(); })` or `afterEach(() => mock.restore())`. */
function isRestoreTeardown(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  const call = statement.expression;
  if (!ts.isCallExpression(call) || call.questionDotToken || call.arguments.length !== 1) return false;
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "afterEach") return false;
  const hook = call.arguments[0]!;
  if (!ts.isArrowFunction(hook) || hook.parameters.length !== 0 || hook.modifiers?.length) return false;
  if (!ts.isBlock(hook.body)) return isMockRestoreCall(hook.body);
  const [only, ...rest] = hook.body.statements;
  return rest.length === 0 && only !== undefined && ts.isExpressionStatement(only) && isMockRestoreCall(only.expression);
}

/** The names a file imports from "bun:test" without an alias or `type`. */
function bunTestImports(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "bun:test") continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly && !element.propertyName) names.add(element.name.text);
    }
  }
  return names;
}

/** Every finding this check reports for one file's source. */
export function analyzeSource(source: string): Finding[] {
  const file = ts.createSourceFile("guarded.test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let moduleMocks = 0;
  const named = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && MOCK_API.has(node.text)) named.add(node.text);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "mock" &&
      node.expression.name.text === "module"
    ) {
      moduleMocks++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const findings: Finding[] = [];
  if (moduleMocks > 0) {
    findings.push({
      kind: "module-mock-needs-child-process",
      detail: `${moduleMocks} mock.module() call(s): mock.restore() does not undo a module mock on bun 1.3.10, so a shared-process test file must not register one`,
    });
  }
  if (named.size > 0) {
    const imports = bunTestImports(file);
    const hasTeardown = imports.has("afterEach") && imports.has("mock") && file.statements.some(isRestoreTeardown);
    if (!hasTeardown) {
      findings.push({
        kind: "missing-mock-restore-teardown",
        detail: `names ${[...named].sort().join(", ")} without a top-level afterEach(() => { mock.restore(); }) (afterEach and mock imported from "bun:test")`,
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
