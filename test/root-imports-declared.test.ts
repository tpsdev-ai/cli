/**
 * test/root-imports-declared.test.ts — cli#871.
 *
 * The root package.json declares the packages that the root tests and scripts
 * import by literal specifier, so the root lane resolves them after a plain
 * root install instead of through the hoisted workspace tree. The check lives
 * in scripts/lib/root-imports-declared.mjs; see that file for what it does not
 * cover.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
	findUndeclaredImports,
	formatUndeclared,
	listSourceFiles,
} from "../scripts/lib/root-imports-declared.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCANNED_DIRS = ["test", "scripts"] as const;

type RootManifest = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

function rootManifest(): RootManifest {
	return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as RootManifest;
}

/** The undeclared packages reported for one fixture body in a throwaway directory. */
function undeclaredIn(body: string) {
	const dir = mkdtempSync(join(tmpdir(), "root-imports-"));
	try {
		writeFileSync(join(dir, "fixture.ts"), body);
		return findUndeclaredImports(dir, ["fixture.ts"], { devDependencies: {} });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The entry a bare, unscoped specifier reports from `fixture.ts`. */
function reportEntry(specifier: string) {
	return { file: "fixture.ts", specifier, packageName: specifier };
}

/**
 * Whether an Identifier child of `parent` sits in an expression position.
 */
function isExpressionIdentifier(parent: ts.Node, node: ts.Identifier): boolean {
	// A property name after a dot, and the `meta`/`target` of a meta property.
	if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
	if (ts.isQualifiedName(parent) || ts.isMetaProperty(parent)) return false;
	// A label, which is a name rather than an expression.
	if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) {
		return false;
	}
	// A declaration or binding name, or the `as` name of an import, export or
	// binding specifier. Anything else under a declaration is an expression.
	if (ts.isDeclaration(parent)) {
		const named = parent as { name?: ts.Node; propertyName?: ts.Node };
		return named.name !== node && named.propertyName !== node;
	}
	return true;
}

/**
 * `source` parsed with a ParenthesizedExpression around every Identifier in an
 * expression position, then printed by TypeScript's printer. The walk visits
 * every node with ts.visitEachChild; the only Identifiers left unwrapped are
 * the ones that are not expressions: a declaration or binding name, a property
 * name after a dot or in a meta property, a property-assignment, method or
 * shorthand property name, an import or export specifier, a qualified name, a
 * label, and a type node. An already parenthesised expression is wrapped again
 * instead of being skipped.
 */
function withParenthesisedExpressions(source: string): { printed: string; wrapped: number } {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	let wrapped = 0;
	const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
		const visitChild = (parent: ts.Node, child: ts.Node, inType: boolean): ts.Node => {
			if (!inType && ts.isIdentifier(child) && isExpressionIdentifier(parent, child)) {
				wrapped += 1;
				return context.factory.createParenthesizedExpression(child);
			}
			return visit(child, inType);
		};
		const visit = (node: ts.Node, inType: boolean): ts.Node => {
			const childrenInType = inType || ts.isTypeNode(node);
			return ts.visitEachChild(node, (child) => visitChild(node, child, childrenInType), context);
		};
		return (root) => ts.visitNode(root, (node) => visit(node, false)) as ts.SourceFile;
	};
	const transformed = ts.transform(sourceFile, [transformer]).transformed[0];
	return { printed: ts.createPrinter().printFile(transformed), wrapped };
}

/** Diagnostic messages from reparsing `source` as the fixture script kind. */
function parseDiagnostics(source: string): string[] {
	const { diagnostics } = ts.transpileModule(source, {
		fileName: "fixture.ts",
		reportDiagnostics: true,
		compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
	});
	return (diagnostics ?? []).map((diagnostic) =>
		ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
	);
}

describe("root imports are declared", () => {
	it("passes on the root tree with the root manifest", () => {
		const files = SCANNED_DIRS.flatMap((dir) => listSourceFiles(ROOT, dir));
		expect(files.length).toBeGreaterThan(0);
		const undeclared = findUndeclaredImports(ROOT, files, rootManifest());
		expect(formatUndeclared(undeclared)).toBe(
			"root files import packages the root manifest does not declare:",
		);
	});

	it("reports the js-yaml importers when the root manifest drops js-yaml", () => {
		const manifest = rootManifest();
		delete manifest.devDependencies?.["js-yaml"];
		const files = SCANNED_DIRS.flatMap((dir) => listSourceFiles(ROOT, dir));
		const undeclared = findUndeclaredImports(ROOT, files, manifest);
		expect(undeclared.length).toBeGreaterThan(0);
		for (const entry of undeclared) expect(entry.packageName).toBe("js-yaml");
		const reported = new Set(undeclared.map((entry) => entry.file));
		for (const file of [
			"test/check-dep-ages.test.ts",
			"test/docker-image-tags.test.ts",
			"test/docker-nono-smoke.test.ts",
			"test/helpers/npm-ci-workflow-guard.ts",
			"test/npm-required-lane.test.ts",
			"test/release-publish-npm-pin.test.ts",
			"scripts/reviewer/ci-job.mjs",
		]) {
			expect(reported).toContain(file);
		}
		expect(formatUndeclared(undeclared)).toContain('imports "js-yaml"');
	});

	it("reports an undeclared package imported from a fixture file", () => {
		const dir = mkdtempSync(join(tmpdir(), "root-imports-"));
		try {
			writeFileSync(join(dir, "fixture.ts"), 'import pad from "left-pad";\n');
			const undeclared = findUndeclaredImports(dir, ["fixture.ts"], {
				devDependencies: {},
			});
			expect(undeclared).toEqual([
				{ file: "fixture.ts", specifier: "left-pad", packageName: "left-pad" },
			]);
			expect(formatUndeclared(undeclared).split("\n")).toEqual([
				"root files import packages the root manifest does not declare:",
				'  fixture.ts imports "left-pad" (package: left-pad)',
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("derives the package name from a subpath import", () => {
		const dir = mkdtempSync(join(tmpdir(), "root-imports-"));
		try {
			writeFileSync(
				join(dir, "fixture.ts"),
				[
					'import a from "js-yaml/dist/js-yaml.mjs";',
					'import b from "@tpsdev-ai/agent/package.json";',
					'import c from "left-pad/lib/x";',
					'import d from "@undeclared/pkg/sub/path";',
					"void a; void b; void c; void d;",
					"",
				].join("\n"),
			);
			const undeclared = findUndeclaredImports(dir, ["fixture.ts"], {
				devDependencies: { "js-yaml": "*", "@tpsdev-ai/agent": "*" },
			});
			expect(undeclared).toEqual([
				{ file: "fixture.ts", specifier: "left-pad/lib/x", packageName: "left-pad" },
				{ file: "fixture.ts", specifier: "@undeclared/pkg/sub/path", packageName: "@undeclared/pkg" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("matches a builtin by the whole specifier, not by its first segment", () => {
		const dir = mkdtempSync(join(tmpdir(), "root-imports-"));
		try {
			writeFileSync(
				join(dir, "fixture.ts"),
				[
					'import { readFile } from "fs/promises";',
					'import { posix } from "path/posix";',
					'import EventEmitter from "events";',
					'import shim from "events/lib/x";',
					'import { Buffer } from "buffer/";',
					"void readFile; void posix; void EventEmitter; void shim; void Buffer;",
					"",
				].join("\n"),
			);
			const undeclared = findUndeclaredImports(dir, ["fixture.ts"], { devDependencies: {} });
			expect(undeclared).toEqual([
				{ file: "fixture.ts", specifier: "events/lib/x", packageName: "events" },
				{ file: "fixture.ts", specifier: "buffer/", packageName: "buffer" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts builtins, relative and absolute imports, and packages declared in dependencies or devDependencies", () => {
		const dir = mkdtempSync(join(tmpdir(), "root-imports-"));
		try {
			writeFileSync(
				join(dir, "fixture.ts"),
				[
					'import { readFileSync } from "node:fs";',
					'import { describe } from "bun:test";',
					'import { helper } from "./helper";',
					'import { absolute } from "/abs/helper";',
					'import { agent } from "@tpsdev-ai/agent";',
					'import onlyInDependencies from "declared-in-dependencies";',
					'import bunPrefixOnly from "bun:prefix-only-fixture";',
					"void readFileSync; void describe; void helper; void absolute; void agent; void onlyInDependencies; void bunPrefixOnly;",
					"",
				].join("\n"),
			);
			const undeclared = findUndeclaredImports(dir, ["fixture.ts"], {
				// Not a Bun/Node builtin name, so only the dependencies entry can pass it.
				dependencies: { "declared-in-dependencies": "^1.0.0" },
				devDependencies: { "@tpsdev-ai/agent": "workspace:*" },
			});
			expect(undeclared).toEqual([]);
			// Each case passes only through the rule it pins, never as a runtime builtin
			// (Bun lists `bun:test` and `ws` in builtinModules).
			expect(builtinModules).not.toContain("bun:prefix-only-fixture");
			expect(builtinModules).not.toContain("declared-in-dependencies");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// A stated limitation, pinned so a scanner change shows up here instead of
	// silently changing what the changelog and the lib's docblock claim.
	it("does not see a type-only import: the TypeScript loader removes it before the scan", () => {
		const dir = mkdtempSync(join(tmpdir(), "root-imports-"));
		try {
			writeFileSync(
				join(dir, "fixture.ts"),
				[
					'import type { A } from "undeclared-import-type";',
					'export type { B } from "undeclared-export-type";',
					'import { type C } from "undeclared-type-names";',
					'import { value } from "undeclared-value";',
					"export type Uses = A | C;",
					"void value;",
					"",
				].join("\n"),
			);
			const undeclared = findUndeclaredImports(dir, ["fixture.ts"], { devDependencies: {} });
			expect(undeclared).toEqual([
				{ file: "fixture.ts", specifier: "undeclared-value", packageName: "undeclared-value" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a # specifier under its own name", () => {
		const dir = mkdtempSync(join(tmpdir(), "root-imports-"));
		try {
			writeFileSync(
				join(dir, "fixture.ts"),
				'import internal from "#internal";\nimport sub from "#internal/sub";\nvoid internal; void sub;\n',
			);
			const undeclared = findUndeclaredImports(dir, ["fixture.ts"], { devDependencies: {} });
			expect(undeclared).toEqual([
				{ file: "fixture.ts", specifier: "#internal", packageName: "#internal" },
				{ file: "fixture.ts", specifier: "#internal/sub", packageName: "#internal/sub" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe("module loader forms", () => {
		// Every loader form that must report a specifier, with the specifiers it
		// reports. The generated-parentheses case below runs over this whole set.
		const LOADER_FIXTURES: { name: string; source: string; specifiers: string[] }[] = [
			{
				name: "a literal argument to a function bound from createRequire",
				source: [
					'import { createRequire } from "node:module";',
					"const load = createRequire(import.meta.url);",
					'const pkg = load("undeclared-create-require-bound");',
					"void pkg;",
					"",
				].join("\n"),
				specifiers: ["undeclared-create-require-bound"],
			},
			{
				name: "a literal argument to createRequire called directly",
				source: [
					'import { createRequire } from "node:module";',
					'const pkg = createRequire(import.meta.url)("undeclared-create-require-direct");',
					"void pkg;",
					"",
				].join("\n"),
				specifiers: ["undeclared-create-require-direct"],
			},
			{
				name: "a literal argument to module.require",
				source: 'const pkg = module.require("undeclared-module-require");\nvoid pkg;\n',
				specifiers: ["undeclared-module-require"],
			},
			{
				name: "a literal argument to process.mainModule.require",
				source: 'const pkg = process.mainModule.require("undeclared-main-module-require");\nvoid pkg;\n',
				specifiers: ["undeclared-main-module-require"],
			},
			{
				name: "loader member access split by whitespace or a comment",
				source: [
					'const a = module . require("undeclared-module-require-spaced");',
					'const b = module /* c */ . require("undeclared-module-require-comment");',
					'const c = process.mainModule . require("undeclared-main-module-require-spaced");',
					'const d = process.mainModule /* c */ .require("undeclared-main-module-require-comment");',
					"void a; void b; void c; void d;",
					"",
				].join("\n"),
				specifiers: [
					"undeclared-module-require-spaced",
					"undeclared-module-require-comment",
					"undeclared-main-module-require-spaced",
					"undeclared-main-module-require-comment",
				],
			},
			{
				name: "a literal argument through computed member access",
				source: [
					'const a = module["require"]("undeclared-module-require-computed");',
					'const b = process.mainModule["require"]("undeclared-main-module-require-computed");',
					'const c = process["mainModule"]["require"]("undeclared-both-computed");',
					"void a; void b; void c;",
					"",
				].join("\n"),
				specifiers: [
					"undeclared-module-require-computed",
					"undeclared-main-module-require-computed",
					"undeclared-both-computed",
				],
			},
			{
				name: "a literal argument to a function bound from a parenthesised createRequire",
				source: [
					'import { createRequire } from "node:module";',
					"const load = (createRequire(import.meta.url));",
					'const pkg = load("undeclared-create-require-parenthesised");',
					"void pkg;",
					"",
				].join("\n"),
				specifiers: ["undeclared-create-require-parenthesised"],
			},
			{
				name: "a dot-access loader name written with unicode escapes",
				source: 'const pkg = module.r\\u0065quire("undeclared-escaped-dot-name");\nvoid pkg;\n',
				specifiers: ["undeclared-escaped-dot-name"],
			},
			{
				name: "a string-literal loader key written with unicode escapes",
				source: 'const pkg = module["r\\u0065quire"]("undeclared-escaped-key-name");\nvoid pkg;\n',
				specifiers: ["undeclared-escaped-key-name"],
			},
			{
				name: "a loader bound to a createRequire name written with unicode escapes",
				source: [
					"const load = creat\\u0065Require(import.meta.url);",
					'const pkg = load("undeclared-escaped-bind-name");',
					"void pkg;",
					"",
				].join("\n"),
				specifiers: ["undeclared-escaped-bind-name"],
			},
			{
				name: "a parenthesised loader callee",
				source: 'const pkg = (module.require)("undeclared-parenthesised-callee");\nvoid pkg;\n',
				specifiers: ["undeclared-parenthesised-callee"],
			},
			{
				name: "a parenthesised bound loader",
				source: [
					'import { createRequire } from "node:module";',
					"const load = createRequire(import.meta.url);",
					'const pkg = (load)("undeclared-parenthesised-bound");',
					"void pkg;",
					"",
				].join("\n"),
				specifiers: ["undeclared-parenthesised-bound"],
			},
			{
				name: "a parenthesised member-access object",
				source: 'const pkg = (module).require("undeclared-parenthesised-object");\nvoid pkg;\n',
				specifiers: ["undeclared-parenthesised-object"],
			},
			{
				name: "a literal argument to a parenthesised createRequire callee",
				source: 'const pkg = (createRequire)(import.meta.url)("undeclared-parenthesised-create-require");\nvoid pkg;\n',
				specifiers: ["undeclared-parenthesised-create-require"],
			},
			{
				name: "a literal argument to a function bound from a parenthesised createRequire callee",
				source: [
					"const load = (createRequire)(import.meta.url);",
					'const pkg = load("undeclared-parenthesised-create-require-bound");',
					"void pkg;",
					"",
				].join("\n"),
				specifiers: ["undeclared-parenthesised-create-require-bound"],
			},
			{
				name: "a literal argument to a loader bound by an assignment",
				source: [
					"let load;",
					"load = createRequire(import.meta.url);",
					'const pkg = load("undeclared-assigned-create-require");',
					"void pkg;",
					"",
				].join("\n"),
				specifiers: ["undeclared-assigned-create-require"],
			},
			{
				name: "a literal argument to a loader bound by a parenthesised assignment",
				source: [
					"let load;",
					"(load) = createRequire(import.meta.url);",
					'const pkg = load("undeclared-parenthesised-assignment");',
					"void pkg;",
					"",
				].join("\n"),
				specifiers: ["undeclared-parenthesised-assignment"],
			},
		];

		for (const fixture of LOADER_FIXTURES) {
			it(`reports ${fixture.name}`, () => {
				expect(undeclaredIn(fixture.source)).toEqual(fixture.specifiers.map(reportEntry));
			});
		}

		const SHADOW_FIXTURES = [
			{
				name: "a parameter",
				body: 'function render(load) { return load("display-label"); }',
			},
			{
				name: "a nested const",
				body: '{ const load = (label) => label; load("display-label"); }',
			},
			{
				name: "a catch binding",
				body: 'try {} catch (load) { load("display-label"); }',
			},
			{
				name: "an inner function declaration",
				body: 'function render() { load("display-label"); function load(label) { return label; } }',
			},
			{
				name: "a hoisted var",
				body: 'function render() { load("display-label"); var load = (label) => label; }',
			},
			{
				name: "a nested let",
				body: '{ let load = (label) => label; load("display-label"); }',
			},
			{
				name: "a class declaration",
				body: 'function render() { class load {} load("display-label"); }',
			},
			{
				name: "an enclosing import",
				body: 'import { load } from "node:module"; function render() { load("display-label"); }',
				binding: 'function setup() { const load = createRequire(import.meta.url); }',
			},
		];

		for (const fixture of SHADOW_FIXTURES) {
			it(`does not report a loader name shadowed by ${fixture.name}`, () => {
				expect(
					undeclaredIn(
						[
							'import { createRequire } from "node:module";',
							fixture.binding ?? "const load = createRequire(import.meta.url);",
							fixture.body,
						].join("\n"),
					),
				).toEqual([]);
			});
		}

		it("reports an outer loader used in a nested scope without shadowing", () => {
			expect(
				undeclaredIn(
					[
						"const load = createRequire(import.meta.url);",
						'function render() { return (load)("undeclared-nested-loader"); }',
					].join("\n"),
				),
			).toEqual([reportEntry("undeclared-nested-loader")]);
		});

		it("binds an assignment to its resolved symbol", () => {
			expect(
				undeclaredIn(
					[
						"let load;",
						"function setup() { (load) = createRequire(import.meta.url); }",
						'function render(load) { return load("display-label"); }',
						'load("undeclared-assigned-outer-loader");',
					].join("\n"),
				),
			).toEqual([reportEntry("undeclared-assigned-outer-loader")]);
		});

		it("reports the same specifiers with every expression-position identifier parenthesised, and both forms parse cleanly", () => {
			for (const fixture of LOADER_FIXTURES) {
				expect({ fixture: fixture.name, diagnostics: parseDiagnostics(fixture.source) }).toEqual({
					fixture: fixture.name,
					diagnostics: [],
				});
				const variant = withParenthesisedExpressions(fixture.source);
				// A fixture that wrapped nothing would make this case vacuous.
				expect({ fixture: fixture.name, wrapped: variant.wrapped > 0 }).toEqual({
					fixture: fixture.name,
					wrapped: true,
				});
				expect({ fixture: fixture.name, diagnostics: parseDiagnostics(variant.printed) }).toEqual({
					fixture: fixture.name,
					diagnostics: [],
				});
				expect({ fixture: fixture.name, reported: undeclaredIn(variant.printed) }).toEqual({
					fixture: fixture.name,
					reported: fixture.specifiers.map(reportEntry),
				});
			}
		});

		it("generates a variant that wraps an assignment's right-hand side and a void operand", () => {
			const assigned = withParenthesisedExpressions(
				'r = createRequire(import.meta.url);\nr("x");\n',
			);
			expect(assigned.printed).toContain("(createRequire)(");
			expect(assigned.printed).toContain("(r)(");
			const voided = withParenthesisedExpressions("void pkg;\n");
			expect(voided.printed).toContain("void (pkg)");
		});

		it("does not report a module.require call in a comment, a string or a template literal", () => {
			expect(
				undeclaredIn(
					[
						'// module.require("commented-out-pkg")',
						'const text = "module.require(\\"in-string-pkg\\")";',
						'const template = `process.mainModule.require("in-template-pkg")`;',
						"void text; void template;",
						"",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("does not report a file: specifier as a package", () => {
			expect(
				undeclaredIn(
					[
						'import { createRequire } from "node:module";',
						'import local from "file:./local.ts";',
						"const load = createRequire(import.meta.url);",
						'const other = load("file:./other.ts");',
						"void local; void other;",
						"",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("does not report a data: specifier as a package", () => {
			expect(
				undeclaredIn(
					[
						'import { createRequire } from "node:module";',
						'import inline from "data:text/javascript,export default 1";',
						"const load = createRequire(import.meta.url);",
						'const other = load("data:text/javascript,export default 2");',
						"void inline; void other;",
						"",
					].join("\n"),
				),
			).toEqual([]);
		});
	});

	it("lists and checks exactly the six claimed extensions, outside node_modules and symlinked directories", () => {
		const root = mkdtempSync(join(tmpdir(), "root-imports-"));
		try {
			const write = (rel: string, body: string) => {
				mkdirSync(join(root, rel, ".."), { recursive: true });
				writeFileSync(join(root, rel), body);
			};
			write("test/a.ts", 'import x from "undeclared-ts";\nvoid x;\n');
			write("test/b.tsx", 'import x from "undeclared-tsx";\nexport const el = <div>{String(x)}</div>;\n');
			write("test/c.js", 'import x from "undeclared-js";\nvoid x;\n');
			write("test/d.jsx", 'import x from "undeclared-jsx";\nexport const el = <div>{String(x)}</div>;\n');
			write("test/sub/e.mjs", 'import x from "undeclared-mjs";\nvoid x;\n');
			write("test/f.cjs", 'const x = require("undeclared-cjs");\nvoid x;\n');
			write("test/node_modules/pkg/g.ts", 'import x from "undeclared-node-modules";\nvoid x;\n');
			write("outside/h.ts", 'import x from "undeclared-symlinked";\nvoid x;\n');
			symlinkSync(join(root, "outside"), join(root, "test", "linked"), "dir");
			write("test/i.mts", 'import x from "undeclared-mts";\nvoid x;\n');
			write("test/j.cts", 'import x from "undeclared-cts";\nvoid x;\n');
			write("test/k.sh", 'node -e \'require("undeclared-sh")\'\n');
			const files = listSourceFiles(root, "test");
			expect(files).toEqual([
				"test/a.ts",
				"test/b.tsx",
				"test/c.js",
				"test/d.jsx",
				"test/f.cjs",
				"test/sub/e.mjs",
			]);
			const undeclared = findUndeclaredImports(root, files, { devDependencies: {} });
			// JSX in b.tsx and d.jsx: Bun's scanner adds two `react` requires per file (the
			// JSX runtime subpath and `react`), so JSX in a root file needs `react` declared.
			expect(undeclared.map((entry) => entry.packageName).sort()).toEqual([
				"react",
				"react",
				"react",
				"react",
				"undeclared-cjs",
				"undeclared-js",
				"undeclared-jsx",
				"undeclared-mjs",
				"undeclared-ts",
				"undeclared-tsx",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
