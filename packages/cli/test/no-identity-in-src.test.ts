/**
 * no-identity-in-src.test.ts — cli#397.
 *
 * No source file under packages/cli/src may name a person as a hardcoded
 * principal or default. A bare string literal equal to a known agent id means
 * the code acts as, or defaults to, that id with nobody configuring it: a TUI
 * that can approve/merge, or a daemon whose mail is signed, as that agent.
 * The fix is configuration (cli#397); this test keeps it that way.
 *
 * Detection: parse each .ts with the TypeScript parser and collect every
 * string literal (and substitution-free template literal) whose text is
 * exactly one of the ids. Comments are excluded by the parser, so a comment
 * that attributes work to a person is not a hit.
 *
 * ALLOWLIST holds the genuine non-identity uses — a `~/.tps/pulse` path
 * segment, a memory tag — and the identity defaults still owned by an open
 * PR, each with a reason. A NEW occurrence anywhere, including these files,
 * still fails: the allowlist is per file+id, not a blanket skip.
 */
import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const IDS = ["flint", "kern", "sherlock", "anvil", "heskew", "pulse"];

interface AllowEntry {
  ids: string[];
  reason: string;
}

const ALLOWLIST: Record<string, AllowEntry> = {
  "commands/office-health.ts": {
    ids: ["pulse"],
    reason: "`~/.tps/pulse` state-path segment, not an identity",
  },
  "commands/pulse.ts": {
    ids: ["pulse"],
    reason: "pulse's own principal, the `~/.tps/pulse` state dir, and a memory tag",
  },
  // Identity defaults in files an open PR owns; not touched by cli#397.
  "bridge/core.ts": {
    ids: ["anvil"],
    reason: "identity default in a file owned by open PR cli#484",
  },
  "commands/agent.ts": {
    ids: ["anvil"],
    reason: "identity default in a file owned by open PR cli#474",
  },
  "commands/roster.ts": {
    ids: ["anvil"],
    reason: "identity default in a file owned by open PR cli#484",
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function bareIdLiterals(file: string): { line: number; id: string }[] {
  const src = readFileSync(file, "utf-8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: { line: number; id: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text.trim();
      if (IDS.includes(text)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        found.push({ line, id: text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("no identity in source (cli#397)", () => {
  test("no known agent id is a hardcoded principal/default under packages/cli/src", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      const allowed = ALLOWLIST[rel];
      for (const hit of bareIdLiterals(file)) {
        if (allowed?.ids.includes(hit.id)) continue;
        offenders.push(`${rel}:${hit.line}: ${hit.id}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
