// Scan known agent literals in src/ and bin/; exceptions pin one literal and line.
import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { load } from "js-yaml";

const CLI = join(import.meta.dir, "..");
const manifest = load(readFileSync(join(CLI, "..", "..", "manifests", "dev-team.yaml"), "utf8")) as {
  manager: { name: string }; agents: { name: string }[];
};
const IDS = new Set([
  "flint", "kern", "sherlock", "anvil", "heskew", "pulse", "ember", "nathan",
  "gauge", "canary", "pixel", "quill", "reed", "adjudicator", "smoke-1781024342351-1343f65d", "smoke-test-auth-check",
  manifest.manager.name.toLowerCase(), ...manifest.agents.map((a) => a.name.toLowerCase()),
]);

interface AllowEntry { file: string; literal: string; context: string; reason: string }
const ALLOWLIST: AllowEntry[] = [
  { file: "src/commands/office-health.ts", literal: '"pulse"', context: 'return join(homeDir(), ".tps", "pulse", "state.json");', reason: "state-path segment" },
  { file: "src/commands/pulse.ts", literal: '"pulse"', context: 'export const PULSE_AGENT_ID = "pulse";', reason: "notification sender's own principal" },
  { file: "src/commands/pulse.ts", literal: '"pulse"', context: 'return join(homeDir(), ".tps", "pulse");', reason: "state-path segment" },
  { file: "src/commands/pulse.ts", literal: '"pulse"', context: 'tags: ["pulse", "pr-lifecycle", to],', reason: "memory tag" },
  { file: "bin/tps.ts", literal: '"pulse"', context: 'case "pulse": {', reason: "command dispatch" },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(?:[cm]?js|tsx?)$/.test(path) ? [path] : [];
  });
}

function offenders(file: string, src: string, allowed = ALLOWLIST): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const unused = [...allowed];
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && IDS.has(node.text.trim().toLowerCase())) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const context = src.split(/\r?\n/)[line]!.trim();
      const index = unused.findIndex((a) => a.file === file && a.literal === node.getText(sf) && a.context === context);
      if (index >= 0) unused.splice(index, 1);
      else found.push(`${file}:${line + 1}: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("known identity literals (cli#397)", () => {
  test("src and shipped bin literals have occurrence-pinned exceptions", () => {
    const files = [join(CLI, "src"), join(CLI, "bin")].flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((f) => offenders(relative(CLI, f), readFileSync(f, "utf8")))).toEqual([]);
  });
  test("each exception still pins one existing occurrence", () => {
    for (const entry of ALLOWLIST) {
      const lines = readFileSync(join(CLI, entry.file), "utf8").split(/\r?\n/).filter((line) => line.trim() === entry.context);
      expect(lines).toHaveLength(1);
      expect(offenders(entry.file, lines[0]!, [])).toHaveLength(1);
    }
  });
  test("a new literal in every allowlisted file fails, even with identical context", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason).not.toBeEmpty();
      expect(offenders(entry.file, `${entry.context}\n${entry.context}`, [entry])).toHaveLength(1);
      expect(offenders(entry.file, `${entry.context}\nconst regression = "nathan";`, [entry])).toHaveLength(1);
    }
  });
  test("all known ids, including manifest agents, are detected in bin", () => {
    for (const id of IDS) expect(offenders("bin/probe.ts", `const regression = ${JSON.stringify(id)};`)).toHaveLength(1);
  });
});
