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
  { file: "src/bridge/core.ts", literal: '"anvil"', context: 'this.defaultAgentId = config.defaultAgentId ?? "anvil";', reason: "follow-up: cli#484 merged, but this default remains on the merge base" },
  { file: "src/commands/agent.ts", literal: '"anvil"', context: 'const scopeAgentId = process.env.TPS_AGENT_ID ?? "anvil";', reason: "cli#474 merged; not incorporated here; cli#486 removes this default" },
  { file: "src/commands/roster.ts", literal: '"anvil"', context: 'const viewerId = opts.agentId ?? process.env.TPS_AGENT_ID ?? "anvil";', reason: "follow-up: cli#484 merged, but this default remains on the merge base" },
  { file: "bin/tps.ts", literal: '"pulse"', context: 'case "pulse": {', reason: "command dispatch" },
];

// cli#499 — branch and memory resolve their identity from configuration and
// refuse by name when none is set; neither may fall back to an identity. The
// fallback expressions that were removed are pinned here, so re-adding one turns
// this guard red. (Known-id literals are already covered by the ALLOWLIST scan
// above.)
const IDENTITY_FALLBACKS: { file: string; pattern: RegExp; fallback: string }[] = [
  { file: "src/commands/branch.ts", pattern: /hostname\(\)\.split\(/, fallback: 'hostname().split(".")[0]' },
  { file: "src/commands/memory.ts", pattern: /"admin"/, fallback: '"admin"' },
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

describe("no identity fallback in branch and memory (cli#499)", () => {
  test("coverage pins exactly the two covered files", () => {
    expect(IDENTITY_FALLBACKS.map((e) => e.file)).toEqual(["src/commands/branch.ts", "src/commands/memory.ts"]);
  });
  test("each covered file resolves its identity without a fallback", () => {
    for (const { file, pattern } of IDENTITY_FALLBACKS) {
      expect(pattern.test(readFileSync(join(CLI, file), "utf8"))).toBe(false);
    }
  });
  test("each fallback pattern matches the expression it guards", () => {
    for (const { pattern, fallback } of IDENTITY_FALLBACKS) {
      expect(pattern.test(`const id = ${fallback};`)).toBe(true);
    }
  });
});
