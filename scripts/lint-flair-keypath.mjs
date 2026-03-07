#!/usr/bin/env node
/**
 * lint-flair-keypath.mjs
 * Fail if createFlairClient() is called with fewer than 3 arguments (missing keyPath).
 * Matches calls of the form: createFlairClient(x, y) — only 1 comma inside = 2 args = bug.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const searchDir = process.argv[2] ?? "packages/cli/src";
let failed = false;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (extname(full) !== ".ts" || full.endsWith(".d.ts")) continue;

    const src = readFileSync(full, "utf-8");
    // Simple regex: match createFlairClient(...) — single-line calls only
    // (multi-line calls are edge cases we can handle later)
    for (const m of src.matchAll(/createFlairClient\(([^)]+)\)/g)) {
      const inner = m[1];
      // Count top-level commas (not inside nested parens/templates)
      let depth = 0, commas = 0;
      for (const ch of inner) {
        if (ch === "(" || ch === "<") depth++;
        else if (ch === ")" || ch === ">") depth--;
        else if (ch === "," && depth === 0) commas++;
      }
      if (commas < 2) {
        const lineNum = src.slice(0, m.index).split("\n").length;
        console.error(`❌  ${full}:${lineNum} — createFlairClient(${inner}) — missing keyPath (3rd arg)`);
        failed = true;
      }
    }
  }
}

walk(searchDir);
if (!failed) console.log("✅  All createFlairClient calls include explicit keyPath");
process.exit(failed ? 1 : 0);
