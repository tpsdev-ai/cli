/**
 * scripts/lib/root-imports-declared.mjs — cli#871.
 *
 * Reports bare specifiers that root test and script files import or load by
 * value and that the root package.json does not declare in dependencies or
 * devDependencies.
 *
 * The check recognises these forms:
 *   - `import ... from "x"`, `export ... from "x"` and `import("x")` with a
 *     literal specifier, read with Bun's own scanner;
 *   - `require("x")`, read by the same scanner;
 *   - `module.require("x")` and `process.mainModule.require("x")`, with each
 *     property written as a dot access or as an element access with a
 *     string or no-substitution-template key (`module["require"]`);
 *   - a name bound to a `createRequire(...)` result by a variable declaration
 *     or an `=`, `??=`, `||=` or `&&=` assignment to a resolved binding;
 *   - a direct `createRequire(...)("x")` call.
 *
 * Parentheses, `as` and angle-bracket type assertions, `satisfies` and non-null
 * expressions are skipped around callees, initializers, assignment operands,
 * member-access objects, literal keys and literal arguments.
 * Local declarations are treated as shadowing `module` and `process`, including
 * `var module`, `declare const module`, `declare const process` and
 * `import process from "node:process"`, even when they bind the runtime receiver.
 * An argument is read only when it is a literal string (or a template literal
 * with no substitutions); any other form
 * is not checked, for example a dynamic key, `module.createRequire`, a loader
 * reached through another expression or invoked with `.call`/`.apply`, or a
 * non-literal argument. Reassignments away from a loader are not tracked.
 *
 * A specifier with a `file:` or `data:` scheme is skipped before a package name
 * is read: Bun resolves those without a package.
 *
 * A bare specifier passes when it is a Node/Bun builtin (`node:` and `bun:`
 * prefixes, or the whole specifier is in `node:module`'s `builtinModules`) or when its package name
 * (scope and name for a scoped package, first segment otherwise) is declared.
 * Relative and absolute imports pass. A `#` specifier (a package.json
 * `imports` entry) is reported under its whole name (`#x`, `#x/y`); the root
 * manifest has no `imports` field. A .tsx or .jsx file that contains JSX is reported as
 * importing `react`: Bun's scanner adds the JSX runtime (`react/jsx-runtime`
 * or `react/jsx-dev-runtime`) and `react` as requires.
 *
 * Not read: a type-only import (`import type { X } from "pkg"`,
 * `export type { X } from "pkg"`, or an import of `type` names only), which
 * Bun's TypeScript loader removes before the scan; `require.resolve("pkg")`;
 * packages imported only from outside test/ and scripts/, and whether a declared
 * range resolves for a published consumer.
 * Not checked: assignments to undeclared names; aliased `createRequire` imports; local `createRequire` shadowing (a parameter or declaration with that name is treated as the `node:module` factory).
 * `listSourceFiles` lists only .ts, .tsx, .js, .jsx, .mjs and .cjs files, skips
 * `node_modules`, and does not descend into a directory reached through a
 * symlink, so JavaScript inside shell scripts or built in template strings, and
 * .mts/.cts files, are not read.
 */

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { extname, join } from "node:path";
import ts from "typescript";

const BUILTINS = new Set(builtinModules);

export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Source files under `dir` (relative to `root`), sorted, as root-relative paths.
 * A symlinked directory is not a Dirent directory, so it is never entered.
 * @param {string} root
 * @param {string} dir
 * @returns {string[]}
 */
export function listSourceFiles(root, dir) {
	const found = [];
	for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
		const relativePath = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			found.push(...listSourceFiles(root, relativePath));
		} else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
			found.push(relativePath);
		}
	}
	return found.sort();
}

function loaderFor(file) {
	switch (extname(file)) {
		case ".ts":
			return "ts";
		case ".tsx":
			return "tsx";
		case ".jsx":
			return "jsx";
		default:
			return "js";
	}
}

function packageName(specifier) {
	// A `#` specifier is a package.json `imports` key; the whole key is its name.
	if (specifier.startsWith("#")) return specifier;
	if (!specifier.startsWith("@")) return specifier.split("/")[0] ?? "";
	return specifier.split("/").slice(0, 2).join("/");
}

/** TypeScript's ScriptKind for one of the extensions listSourceFiles reads. */
function scriptKindFor(file) {
	switch (extname(file)) {
		case ".ts":
			return ts.ScriptKind.TS;
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		default:
			return ts.ScriptKind.JS;
	}
}

/**
 * A node with parentheses and TypeScript assertion wrappers removed.
 */
function unwrap(node) {
	while (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isNonNullExpression(node) ||
		ts.isTypeAssertionExpression(node)
	) {
		node = node.expression;
	}
	return node;
}

/** An identifier's name after unwrapping, or null. */
function identifierText(node) {
	const expression = unwrap(node);
	return ts.isIdentifier(expression) ? expression.text : null;
}

/** A call written `createRequire(...)`. */
function isCreateRequireCall(node) {
	return ts.isCallExpression(node) && identifierText(node.expression) === "createRequire";
}

function stringLiteralText(node) {
	if (node === undefined) return null;
	const expression = unwrap(node);
	return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
		? expression.text
		: null;
}

/** The name of a dot access or literal-key element access, or null. */
function accessName(node) {
	const access = unwrap(node);
	if (ts.isPropertyAccessExpression(access)) return access.name.text;
	return ts.isElementAccessExpression(access) ? stringLiteralText(access.argumentExpression) : null;
}

function hasLocalBinding(symbol) {
	return symbol?.declarations?.some(
		(declaration) =>
			ts.isParameter(declaration) ||
			ts.isVariableDeclaration(declaration) ||
			ts.isBindingElement(declaration) ||
			ts.isFunctionDeclaration(declaration) ||
			ts.isFunctionExpression(declaration) ||
			ts.isClassDeclaration(declaration) ||
			ts.isClassExpression(declaration) ||
			ts.isImportClause(declaration) ||
			ts.isImportSpecifier(declaration) ||
			ts.isNamespaceImport(declaration) ||
			ts.isImportEqualsDeclaration(declaration) ||
			ts.isEnumDeclaration(declaration) ||
			ts.isModuleDeclaration(declaration),
	) ?? false;
}

/** A call written `process.mainModule.require(...)` with an unshadowed receiver. */
function isProcessMainModuleRequire(node, symbolAt) {
	const access = unwrap(node);
	if (accessName(access) !== "require") return false;
	const target = unwrap(access.expression);
	if (accessName(target) !== "mainModule") return false;
	return (
		identifierText(target.expression) === "process" &&
		!hasLocalBinding(symbolAt(target.expression))
	);
}

/** A call written `module.require(...)` with an unshadowed receiver. */
function isModuleRequire(node, symbolAt) {
	const access = unwrap(node);
	if (accessName(access) !== "require") return false;
	return (
		identifierText(access.expression) === "module" &&
		!hasLocalBinding(symbolAt(access.expression))
	);
}

function literalArgument(node) {
	return stringLiteralText(node.arguments[0]);
}

/**
 * Specifiers loaded through a module loader that Bun's scanner does not report:
 * a variable holding a `createRequire(...)` result (or a direct
 * `createRequire(...)(...)` call), `module.require` and
 * `process.mainModule.require`. Only a literal first argument is returned.
 * Comments and strings are not matched: this is a parse, not a text scan.
 * @param {string} file
 * @param {string} source
 * @returns {string[]}
 */
export function scanLoaderImports(file, source) {
	const normalizedFile = file.replaceAll("\\", "/");
	const sourceFile = ts.createSourceFile(
		normalizedFile,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindFor(file),
	);
	const options = { noResolve: true, noLib: true, allowJs: true, types: [] };
	// Binding needs this source only; resolution must not probe the host filesystem.
	const host = {
		getSourceFile: (name) => (name === normalizedFile ? sourceFile : undefined),
		getDefaultLibFileName: () => "",
		writeFile: () => {},
		getCurrentDirectory: () => "",
		getCanonicalFileName: (name) => name,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
		fileExists: (name) => name === normalizedFile,
		directoryExists: () => false,
		readFile: (name) => (name === normalizedFile ? source : undefined),
		realpath: (name) => name,
		getDirectories: () => [],
	};
	const checker = ts.createProgram([normalizedFile], options, host).getTypeChecker();
	const symbolAt = (node) => {
		const identifier = unwrap(node);
		return ts.isIdentifier(identifier) ? checker.getSymbolAtLocation(identifier) : undefined;
	};
	// Match the loader's binding symbol so intervening declarations shadow it.
	const bound = new Set();
	const bind = (node) => {
		const declared = ts.isVariableDeclaration(node) ? symbolAt(node.name) : undefined;
		if (
			declared !== undefined &&
			node.initializer !== undefined &&
			isCreateRequireCall(unwrap(node.initializer))
		) {
			bound.add(declared);
		}
		if (
			ts.isBindingElement(node) &&
			node.initializer !== undefined &&
			isCreateRequireCall(unwrap(node.initializer))
		) {
			const binding = symbolAt(node.name);
			if (binding !== undefined) bound.add(binding);
		}
		if (
			ts.isShorthandPropertyAssignment(node) &&
			node.objectAssignmentInitializer !== undefined &&
			isCreateRequireCall(unwrap(node.objectAssignmentInitializer))
		) {
			const assigned = checker.getShorthandAssignmentValueSymbol(node);
			if (assigned !== undefined) bound.add(assigned);
		}
		if (
			ts.isBinaryExpression(node) &&
			[
				ts.SyntaxKind.EqualsToken,
				ts.SyntaxKind.QuestionQuestionEqualsToken,
				ts.SyntaxKind.BarBarEqualsToken,
				ts.SyntaxKind.AmpersandAmpersandEqualsToken,
			].includes(node.operatorToken.kind) &&
			isCreateRequireCall(unwrap(node.right))
		) {
			const assigned = symbolAt(node.left);
			if (assigned !== undefined) bound.add(assigned);
		}
		ts.forEachChild(node, bind);
	};
	bind(sourceFile);
	const found = [];
	const collect = (node) => {
		if (ts.isCallExpression(node)) {
			const callee = unwrap(node.expression);
			const calleeSymbol = symbolAt(callee);
			const isLoader =
				isCreateRequireCall(callee) ||
				(calleeSymbol !== undefined && bound.has(calleeSymbol)) ||
				isModuleRequire(callee, symbolAt) ||
				isProcessMainModuleRequire(callee, symbolAt);
			if (isLoader) {
				const specifier = literalArgument(node);
				if (specifier !== null) found.push(specifier);
			}
		}
		ts.forEachChild(node, collect);
	};
	collect(sourceFile);
	return [...new Set(found)];
}

/** Imports in one source file. The shebang line is blanked because scanImports rejects it. */
export function scanSourceImports(file, source) {
	const parsed = new Bun.Transpiler({ loader: loaderFor(file) }).scanImports(
		source.replace(/^#![^\n]*\n/, "\n"),
	);
	const scanned = parsed
		.map((entry) => {
			const record = entry;
			return typeof record === "string" ? record : (record.path ?? "");
		})
		.filter((specifier) => specifier !== "");
	const seen = new Set(scanned);
	return [...scanned, ...scanLoaderImports(file, source).filter((s) => !seen.has(s))];
}

/**
 * @param {string} root
 * @param {readonly string[]} files paths relative to root
 * @param {{ dependencies?: Record<string,string>, devDependencies?: Record<string,string> }} manifest
 * @returns {{ file: string, specifier: string, packageName: string }[]}
 */
export function findUndeclaredImports(root, files, manifest) {
	const declared = new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.devDependencies ?? {}),
	]);
	const undeclared = [];
	for (const file of files) {
		const source = readFileSync(join(root, file), "utf8");
		for (const specifier of scanSourceImports(file, source)) {
			if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
			if (specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
			// Bun resolves these schemes without a package; the scheme is not a name.
			if (specifier.startsWith("file:") || specifier.startsWith("data:")) continue;
			const name = packageName(specifier);
			// A builtin is matched by the whole specifier: builtinModules lists the
			// builtin subpaths it has (fs/promises, path/posix, ...); Node and Bun
			// both look up `events/lib/x` and `buffer/` as npm packages instead.
			if (BUILTINS.has(specifier) || declared.has(name)) continue;
			undeclared.push({ file, specifier, packageName: name });
		}
	}
	return undeclared;
}

/** @param {readonly { file: string, specifier: string, packageName: string }[]} undeclared */
export function formatUndeclared(undeclared) {
	return [
		"root files import packages the root manifest does not declare:",
		...undeclared.map(
			(entry) =>
				`  ${entry.file} imports "${entry.specifier}" (package: ${entry.packageName})`,
		),
	].join("\n");
}
