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
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	findUndeclaredImports,
	formatUndeclared,
} from "../scripts/lib/root-imports-declared.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCANNED_DIRS = ["test", "scripts"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

type RootManifest = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

function listSourceFiles(root: string, dir: string): string[] {
	const found: string[] = [];
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
			const message = formatUndeclared(undeclared);
			expect(message).toContain("fixture.ts");
			expect(message).toContain('"left-pad"');
			expect(message).toContain("left-pad");
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

	it("accepts builtins, a relative import and a declared scoped package", () => {
		const dir = mkdtempSync(join(tmpdir(), "root-imports-"));
		try {
			writeFileSync(
				join(dir, "fixture.ts"),
				[
					'import { readFileSync } from "node:fs";',
					'import { describe } from "bun:test";',
					'import { helper } from "./helper";',
					'import { agent } from "@tpsdev-ai/agent";',
					"void readFileSync; void describe; void helper; void agent;",
					"",
				].join("\n"),
			);
			const undeclared = findUndeclaredImports(dir, ["fixture.ts"], {
				devDependencies: { "@tpsdev-ai/agent": "workspace:*" },
			});
			expect(undeclared).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
