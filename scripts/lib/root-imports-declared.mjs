/**
 * scripts/lib/root-imports-declared.mjs — cli#871.
 *
 * Reports bare specifiers imported by root test and script files that the root
 * package.json does not declare in dependencies or devDependencies. Imports
 * are read with Bun's own scanner, not a regex.
 *
 * A bare specifier passes when it is a Node/Bun builtin (`node:` and `bun:`
 * prefixes, and `node:module`'s `builtinModules`) or when its package name
 * (scope and name for a scoped package, first segment otherwise) is declared.
 * Relative and absolute imports pass.
 *
 * NOT covered: a dynamic import whose specifier is not a literal string
 * (`await import(name)`), packages imported only from outside test/ and
 * scripts/, and whether a declared range resolves for a published consumer.
 * The root test lists only .ts, .tsx, .js, .jsx, .mjs and .cjs files and does
 * not descend into a directory reached through a symlink, so JavaScript inside
 * shell scripts or built in template strings, and .mts/.cts files, are not read.
 */

import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { extname, join } from "node:path";

const BUILTINS = new Set(builtinModules);

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
	if (!specifier.startsWith("@")) return specifier.split("/")[0] ?? "";
	return specifier.split("/").slice(0, 2).join("/");
}

/** Imports in one source file. The shebang line is blanked because scanImports rejects it. */
export function scanSourceImports(file, source) {
	const parsed = new Bun.Transpiler({ loader: loaderFor(file) }).scanImports(
		source.replace(/^#![^\n]*\n/, "\n"),
	);
	return parsed
		.map((entry) => {
			const record = entry;
			return typeof record === "string" ? record : (record.path ?? "");
		})
		.filter((specifier) => specifier !== "");
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
			const name = packageName(specifier);
			if (BUILTINS.has(name) || declared.has(name)) continue;
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
