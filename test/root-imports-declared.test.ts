/**
 * test/root-imports-declared.test.ts — cli#871.
 *
 * The root package.json declares the packages that the root tests and scripts
 * import by literal specifier, so the root lane resolves them after a plain
 * root install instead of through the hoisted workspace tree. The check lives
 * in scripts/lib/root-imports-declared.mjs; see that file for what it does not
 * cover.
 */

import { describe, expect, it, spyOn } from "bun:test";
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
function undeclaredIn(body: string, file = "fixture.ts") {
	const dir = mkdtempSync(join(tmpdir(), "root-imports-"));
	try {
		writeFileSync(join(dir, file), body);
		return findUndeclaredImports(dir, [file], { devDependencies: {} });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The entry a bare, unscoped specifier reports from `fixture.ts`. */
function reportEntry(specifier: string) {
	return { file: "fixture.ts", specifier, packageName: specifier };
}

/**
 * Whether an identifier or literal child of `parent` sits in an expression position.
 */
function isExpressionLeaf(parent: ts.Node, node: ts.Node): boolean {
	if (
		ts.isImportDeclaration(parent) ||
		ts.isExportDeclaration(parent) ||
		ts.isExternalModuleReference(parent)
	) return false;
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
 * `source` parsed with parentheses around identifiers and string/template
 * literals in expression positions, then printed by TypeScript. The walk visits
 * every node with ts.visitEachChild; the leaves left unwrapped are
 * the ones that are not expressions: a declaration or binding name, a property
 * name after a dot or in a meta property, a property-assignment, method or
 * shorthand property name, an import or export specifier, a qualified name, a
 * label, module specifier, and a type node. An already parenthesised expression
 * is wrapped again instead of being skipped.
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
			if (
				!inType &&
				(ts.isIdentifier(child) || ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) &&
				isExpressionLeaf(parent, child)
			) {
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
		it("reports a bound loader in a file name containing a backslash", () => {
			const dir = mkdtempSync(join(tmpdir(), "root-imports-"));
			const file = "sub\\fixture.ts";
			try {
				mkdirSync(join(dir, "sub"));
				writeFileSync(
					join(dir, file),
					'const load = createRequire(import.meta.url); load("undeclared-backslash");',
				);
				expect(findUndeclaredImports(dir, [file], { devDependencies: {} })).toEqual([
					{ file, specifier: "undeclared-backslash", packageName: "undeclared-backslash" },
				]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		// Every loader form that must report a specifier, with the specifiers it
		// reports. The generated-parentheses case below runs over this whole set.
		const LOADER_FIXTURES: { name: string; source: string; specifiers: string[] }[] = [
			{
				name: "a loader bound by a function parameter default",
				source: 'function f(load = createRequire(import.meta.url)) { return load("undeclared-param-function"); }',
				specifiers: ["undeclared-param-function"],
			},
			{
				name: "a loader bound by an arrow parameter default",
				source: 'const f = (load = createRequire(import.meta.url)) => load("undeclared-param-arrow");',
				specifiers: ["undeclared-param-arrow"],
			},
			{
				name: "a loader bound by a method parameter default",
				source: 'class Reader { read(load = createRequire(import.meta.url)) { return load("undeclared-param-method"); } }',
				specifiers: ["undeclared-param-method"],
			},
			{
				name: "a literal argument to require.main.require",
				source: 'require.main.require("undeclared-require-main");',
				specifiers: ["undeclared-require-main"],
			},
			{
				name: "a literal argument to optional require.main.require",
				source: 'require.main?.require("undeclared-require-main-optional");',
				specifiers: ["undeclared-require-main-optional"],
			},
			{
				name: "a literal argument to require.main.require through computed member access",
				source: 'require["main"][`require`]("undeclared-require-main-computed");',
				specifiers: ["undeclared-require-main-computed"],
			},
			{
				name: "a loader bound by an object binding-pattern shorthand default",
				source: 'const { load = createRequire(import.meta.url) } = {}; load("undeclared-a");',
				specifiers: ["undeclared-a"],
			},
			{
				name: "a loader bound by a renamed object binding-pattern default",
				source: 'const { load: l = createRequire(import.meta.url) } = {}; l("undeclared-b");',
				specifiers: ["undeclared-b"],
			},
			{
				name: "a loader bound by an object assignment-pattern shorthand default",
				source: 'let load; ({ load = createRequire(import.meta.url) } = {}); load("undeclared-c");',
				specifiers: ["undeclared-c"],
			},
			{
				name: "a loader bound by a renamed object assignment-pattern default",
				source: 'let l; ({ load: l = createRequire(import.meta.url) } = {}); l("undeclared-d");',
				specifiers: ["undeclared-d"],
			},
			{
				name: "a loader bound by an array assignment-pattern default",
				source: 'let load; [load = createRequire(import.meta.url)] = []; load("undeclared-e");',
				specifiers: ["undeclared-e"],
			},
			{
				name: "as assertions around loader expressions",
				source: [
					'const load = createRequire(import.meta.url) as (id: string) => unknown; load("u-as-assertion");',
					...["=", "??=", "||=", "&&="].map((operator, index) =>
						`let assigned${index}; assigned${index} ${operator} createRequire(import.meta.url) as any; assigned${index}("u-as-assignment-${index}");`,
					),
					'(module as any)[("require" as string)]("u-as-member" as string);',
					'(module.require as any)("u-as-callee");',
					'const other = (createRequire as any)(import.meta.url); (other as any)("u-as-bound-callee");',
					'const { destructured = createRequire(import.meta.url) as any } = {}; destructured("u-as-destructuring-default");',
					'let shorthand; ({ shorthand = createRequire(import.meta.url) as any } = {}); shorthand("u-as-shorthand-default");',
					'function withParam(paramLoad = createRequire(import.meta.url) as any) { return paramLoad("u-as-parameter-default"); }',
					'(process.mainModule as any).require("u-as-main-module");',
					'(require.main as any).require("u-as-require-main");',
					'let lhs; (lhs as any) = createRequire(import.meta.url); lhs("u-as-lhs");',
				].join("\n"),
				specifiers: ["u-as-assertion", ...[0, 1, 2, 3].map((index) => `u-as-assignment-${index}`), "u-as-member", "u-as-callee", "u-as-bound-callee", "u-as-destructuring-default", "u-as-shorthand-default", "u-as-parameter-default", "u-as-main-module", "u-as-require-main", "u-as-lhs"],
			},
			{
				name: "a satisfies expression around a loader initializer",
				source: 'const load = createRequire(import.meta.url) satisfies unknown; load("u-satisfies");',
				specifiers: ["u-satisfies"],
			},
			{
				name: "a non-null expression around a loader initializer",
				source: 'const load = createRequire(import.meta.url)!; load("u-nonnull");',
				specifiers: ["u-nonnull"],
			},
			{
				name: "nested as assertions around a direct loader callee",
				source: '(createRequire(import.meta.url) as unknown as (id: string) => unknown)("u-direct-as");',
				specifiers: ["u-direct-as"],
			},
			{
				name: "an angle-bracket type assertion around a loader initializer",
				source: 'const load = <any>createRequire(import.meta.url); load("u-type-assertion");',
				specifiers: ["u-type-assertion"],
			},
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
			{
				name: "a parenthesised module.require argument",
				source: 'module.require(("undeclared-paren-arg-module"))',
				specifiers: ["undeclared-paren-arg-module"],
			},
			{
				name: "a parenthesised bound-loader argument",
				source: 'const load = createRequire(import.meta.url); load(("undeclared-paren-arg-bound"))',
				specifiers: ["undeclared-paren-arg-bound"],
			},
			{
				name: "a parenthesised template argument",
				source: 'module.require((`undeclared-paren-template`))',
				specifiers: ["undeclared-paren-template"],
			},
			{
				name: "a doubly parenthesised argument",
				source: 'module.require((("undeclared-double-paren")))',
				specifiers: ["undeclared-double-paren"],
			},
			{
				name: "a parenthesised require key",
				source: 'module[("require")]("undeclared-paren-key")',
				specifiers: ["undeclared-paren-key"],
			},
			{
				name: "a parenthesised mainModule key",
				source: 'process[("mainModule")].require("undeclared-paren-main")',
				specifiers: ["undeclared-paren-main"],
			},
			{
				name: "a template require key",
				source: 'module[`require`]("undeclared-template-key")',
				specifiers: ["undeclared-template-key"],
			},
			{
				name: "a template mainModule key",
				source: 'process[`mainModule`].require("undeclared-proc-template")',
				specifiers: ["undeclared-proc-template"],
			},
			{
				name: "a loader bound by ??=",
				source: 'let load; load ??= createRequire(import.meta.url); load("undeclared-nullish")',
				specifiers: ["undeclared-nullish"],
			},
			{
				name: "a loader bound by ||=",
				source: 'let load; load ||= createRequire(import.meta.url); load("undeclared-or")',
				specifiers: ["undeclared-or"],
			},
			{
				name: "a loader bound by &&=",
				source: 'let load; load &&= createRequire(import.meta.url); load("undeclared-and")',
				specifiers: ["undeclared-and"],
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

		for (const receiver of ["module", "process", "require"]) {
			const call = receiver === "module" ? 'module.require("display-label")' : receiver === "process" ? 'process.mainModule.require("display-label")' : 'require.main.require("display-label")';
			for (const declaration of [
				`function render(${receiver}) { return ${call}; }`,
				`{ const ${receiver} = {}; ${call}; }`,
				`{ const ${receiver} = {}; ${call.replace(receiver, `(${receiver} as any)`)}; }`,
				`{ let ${receiver}; ${call}; }`,
				`function render() { ${call}; var ${receiver}; }`,
				`function ${receiver}() {} ${call};`,
				`class ${receiver} {} ${call};`,
				`import { ${receiver} } from "node:module"; ${call};`,
				`const { ${receiver} } = {}; ${call};`,
				`try {} catch (${receiver}) { ${call}; }`,
				`import ${receiver} from "node:module"; ${call};`,
				`import * as ${receiver} from "node:module"; ${call};`,
				`import ${receiver} = require("node:module"); ${call};`,
				`enum ${receiver} {} ${call};`,
				`namespace ${receiver} { export const x = 1; } ${call};`,
				`const render = function ${receiver}() { ${call}; };`,
				`const render = class ${receiver} { render() { ${call}; } };`,
			]) {
				it(`does not report a locally declared receiver: ${declaration}`, () => {
					expect(undeclaredIn(declaration)).toEqual([]);
				});
			}
		}

		it("leaves assignment to an undeclared name unchecked in a cjs script", () => {
			expect(undeclaredIn('load = createRequire(__filename); load("undeclared-global");', "fixture.cjs")).toEqual([]);
		});

		it("reports a loader bound by a cjs parameter default using __filename", () => {
			expect(undeclaredIn('function f(load = createRequire(__filename)) { return load("undeclared-param-cjs"); }', "fixture.cjs")).toEqual([
				{ file: "fixture.cjs", specifier: "undeclared-param-cjs", packageName: "undeclared-param-cjs" },
			]);
		});

		it("does not report a parameter default from a different factory", () => {
			expect(undeclaredIn('const load = createRequire(import.meta.url); function f(load = makeLoader()) { return load("display-label"); }')).toEqual([]);
		});

		for (const file of ["fixture.cjs", "fixture.js"]) {
			it(`reports require.main.require spellings beside CommonJS exports in ${file}`, () => {
				expect(undeclaredIn('require.main.require("u-main"); require.main?.require("u-main-optional"); require["main"].require("u-main-computed"); module.exports = {};', file).map((entry) => entry.specifier)).toEqual(["u-main", "u-main-optional", "u-main-computed"]);
			});

			it(`does not report require.main.require with a local require in ${file}`, () => {
				for (const source of [
					'const require = customLoader; require.main.require("display-label");',
					'function f(require) { require.main?.require("display-label"); require["main"].require("display-label"); }',
				]) {
					expect(undeclaredIn(source, file)).toEqual([]);
				}
			});
		}

		it("treats var re-declarations and ambient module declarations as shadowing", () => {
			for (const file of ["fixture.cjs", "fixture.js"]) {
				expect(undeclaredIn('var module;\nmodule.require("undeclared-var-module");', file)).toEqual([]);
			}
			expect(undeclaredIn('declare const module: any;\nmodule.require("undeclared-ambient-module");')).toEqual([]);
		});

		it("leaves an aliased createRequire import unchecked", () => {
			expect(undeclaredIn('import { createRequire as cr } from "node:module"; const load = cr(import.meta.url); load("undeclared-alias");')).toEqual([]);
		});

		it("reports unshadowed receivers in a cjs script", () => {
			expect(undeclaredIn('module.require("undeclared-cjs-module"); process.mainModule.require("undeclared-cjs-process");', "fixture.cjs").map((entry) => entry.specifier)).toEqual(["undeclared-cjs-module", "undeclared-cjs-process"]);
		});

		for (const fixture of [
			{
				file: "b.cjs",
				source: 'module.require("u-cjs-exports");\nmodule.exports = {};',
				specifier: "u-cjs-exports",
			},
			{
				file: "fixture.js",
				source: 'module.require("undeclared-js-module");\nmodule.exports = {};',
				specifier: "undeclared-js-module",
			},
			{
				file: "exports.js",
				source: 'module.require("undeclared-js-exports");\nexports.x = 1;',
				specifier: "undeclared-js-exports",
			},
		]) {
			it(`reports module.require beside CommonJS exports in ${fixture.file}`, () => {
				expect(undeclaredIn(fixture.source, fixture.file)).toEqual([
					{ file: fixture.file, specifier: fixture.specifier, packageName: fixture.specifier },
				]);
			});
		}

		it("scans the real tree without ts.sys filesystem calls", () => {
			const calls: string[] = [];
			const methods = ["fileExists", "directoryExists", "readFile", "realpath", "getDirectories", "readDirectory", "getCurrentDirectory"] as const;
			const spies = methods.map((method) => spyOn(ts.sys, method).mockImplementation(() => {
				calls.push(method);
				throw new Error(`unexpected ts.sys.${method}`);
			}));
			try {
				const files = SCANNED_DIRS.flatMap((dir) => listSourceFiles(ROOT, dir));
				expect(findUndeclaredImports(ROOT, files, rootManifest())).toEqual([]);
				expect(calls).toEqual([]);
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
		});

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

		it("reports the same specifiers with expression-position identifiers and literals parenthesised, and both forms parse cleanly", () => {
			// This covers parenthesisation only; assertion forms are pinned by the per-form fixtures.
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

		it("generates parenthesised string and template keys and arguments", () => {
			const variant = withParenthesisedExpressions('module["require"]("x"); process[`mainModule`].require(`y`);');
			expect(variant.printed).toContain('[("require")](("x"))');
			expect(variant.printed).toContain('[(`mainModule`)]');
			expect(variant.printed).toContain('((`y`))');
			expect(parseDiagnostics(variant.printed)).toEqual([]);
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
