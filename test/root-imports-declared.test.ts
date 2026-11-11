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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
					"void readFileSync; void describe; void helper; void absolute; void agent; void onlyInDependencies;",
					"",
				].join("\n"),
			);
			const undeclared = findUndeclaredImports(dir, ["fixture.ts"], {
				// Not a Bun/Node builtin name, so only the dependencies entry can pass it.
				dependencies: { "declared-in-dependencies": "^1.0.0" },
				devDependencies: { "@tpsdev-ai/agent": "workspace:*" },
			});
			expect(undeclared).toEqual([]);
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
			writeFileSync(join(dir, "fixture.ts"), 'import internal from "#internal";\nvoid internal;\n');
			const undeclared = findUndeclaredImports(dir, ["fixture.ts"], { devDependencies: {} });
			expect(undeclared).toEqual([
				{ file: "fixture.ts", specifier: "#internal", packageName: "#internal" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
