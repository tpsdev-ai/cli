import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CLI = join(import.meta.dir, "..");

interface ZeroExitAllowance {
  file: string;
  contexts: string[];
  reason: string;
}

const ALLOWLIST: ZeroExitAllowance[] = [
  {
    file: "bin/tps.cjs",
    contexts: [
      "if(versionRequested):then #1 (zero)",
    ],
    reason: "npm launcher --version fast path; runs before any command can set a code",
  },
  {
    file: "src/utils/mail-bridge.ts",
    contexts: [
      "startBridgeDaemon > shutdown > core.stop().then()[callback:0] #1 (zero)",
    ],
    reason: "SIGINT/SIGTERM shutdown handler stops the bridge core, then exits cleanly",
  },
  {
    file: "src/utils/mail-relay.ts",
    contexts: [
      "runRelayDaemon > process.on(\"SIGTERM\")[callback:1] #1 (zero)",
      "runRelayDaemon > process.on(\"SIGINT\")[callback:1] #1 (zero)",
    ],
    reason: "mail-relay daemon SIGINT/SIGTERM shutdown handlers",
  },
  {
    file: "src/utils/llm-proxy.ts",
    contexts: [
      "startProxyDaemon > process.once(\"SIGTERM\")[callback:1] #1 (zero)",
      "startProxyDaemon > process.once(\"SIGINT\")[callback:1] #1 (zero)",
    ],
    reason: "llm-proxy daemon SIGINT/SIGTERM shutdown handlers",
  },
  {
    file: "src/commands/bridge.ts",
    contexts: [
      "runBridge > case \"start\" > if(adapter === \"discord\"):then > shutdown > core.stop().then()[callback:0] #1 (zero)",
      "runBridge > case \"start\" > if(adapter === \"stdio\"):then > shutdown > core.stop().then()[callback:0] #1 (zero)",
      "runBridge > case \"start\" > if(st.running):then #1 (zero)",
    ],
    reason: "adapter shutdown handlers (2) and the already-running start guard",
  },
  {
    file: "src/commands/agent.ts",
    contexts: [
      "streamLogUpdates > Promise()[callback:0] > handleSigint #1 (zero)",
      "streamLogUpdates #1 (zero)",
    ],
    reason: "log-follow SIGINT handler and the unreachable tail after its never-resolving wait",
  },
  {
    file: "src/commands/mail-watch.ts",
    contexts: [
      "runMailWatch > shutdown #1 (zero)",
    ],
    reason: "mail-watch daemon SIGINT/SIGTERM shutdown handler",
  },
  {
    file: "src/commands/secrets.ts",
    contexts: [
      "handleVerify > if(Object.keys(filteredManifest.credentials).length === 0):then #1 (zero)",
    ],
    reason: "secrets verify exits 0 when there is nothing to verify",
  },
  {
    file: "src/commands/office.ts",
    contexts: [
      "runOffice > case \"relay\" > process.on(\"SIGTERM\")[callback:1] #1 (zero)",
      "runOffice > case \"relay\" > process.on(\"SIGINT\")[callback:1] #1 (zero)",
      "runOffice > case \"connect\" > process.on(\"SIGINT\")[callback:1] #1 (zero)",
    ],
    reason: "office relay/connect SIGINT/SIGTERM shutdown handlers",
  },
  {
    file: "src/commands/branch.ts",
    contexts: [
      "runStart > if(spawnsDaemon):then #1 (zero)",
      "runStart > onShutdown #1 (zero)",
    ],
    reason: "daemon spawn success and branch daemon shutdown handler",
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?js|tsx?)$/.test(path) ? [path] : [];
  });
}

interface ExitSite {
  context: string;
  line: number;
}

function exitContext(node: ts.Node, sf: ts.SourceFile): string {
  const chain: string[] = [];
  for (let current = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isFunctionLike(current)) {
      if (current.name) chain.unshift(current.name.getText(sf));
      else if (ts.isVariableDeclaration(parent)) chain.unshift(parent.name.getText(sf));
      else if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
        const args = parent.arguments ?? [];
        const index = args.indexOf(current as ts.Expression);
        const preceding = args.slice(0, index).map((arg) => arg.getText(sf)).join(",");
        chain.unshift(`${parent.expression.getText(sf)}(${preceding})[callback:${index}]`);
      } else chain.unshift(ts.SyntaxKind[current.kind]);
    }
    if (ts.isIfStatement(parent)) {
      const branch = current === parent.thenStatement ? "then" : "else";
      chain.unshift(`if(${parent.expression.getText(sf)}):${branch}`);
    }
    if (ts.isCaseClause(current)) chain.unshift(`case ${current.expression.getText(sf)}`);
  }
  return chain.join(" > ") || "<module>";
}

function constantNumber(node: ts.Expression): number | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return constantNumber(node.expression);
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ""));
  if (ts.isPrefixUnaryExpression(node)) {
    const value = constantNumber(node.operand);
    if (value === undefined) return undefined;
    switch (node.operator) {
      case ts.SyntaxKind.PlusToken: return +value;
      case ts.SyntaxKind.MinusToken: return -value;
      case ts.SyntaxKind.TildeToken: return ~value;
      default: return undefined;
    }
  }
  if (!ts.isBinaryExpression(node)) return undefined;
  const left = constantNumber(node.left);
  const right = constantNumber(node.right);
  if (left === undefined || right === undefined) return undefined;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken: return left + right;
    case ts.SyntaxKind.MinusToken: return left - right;
    case ts.SyntaxKind.AsteriskToken: return left * right;
    case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right;
    case ts.SyntaxKind.SlashToken: return left / right;
    case ts.SyntaxKind.PercentToken: return left % right;
    case ts.SyntaxKind.LessThanLessThanToken: return left << right;
    case ts.SyntaxKind.GreaterThanGreaterThanToken: return left >> right;
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return left >>> right;
    case ts.SyntaxKind.AmpersandToken: return left & right;
    case ts.SyntaxKind.BarToken: return left | right;
    case ts.SyntaxKind.CaretToken: return left ^ right;
    default: return undefined;
  }
}

function zeroExitSites(src: string, file = "sample.ts"): ExitSite[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const sites: ExitSite[] = [];
  const ordinals = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "exit"
    ) {
      const arg = node.arguments[0];
      const isZero =
        arg === undefined ||
        constantNumber(arg) === 0;
      if (isZero) {
        const context = exitContext(node, sf);
        const ordinal = (ordinals.get(context) ?? 0) + 1;
        ordinals.set(context, ordinal);
        sites.push({
          context: `${context} #${ordinal} (${arg === undefined ? "bare" : "zero"})`,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function zeroExitLines(src: string): number[] {
  return zeroExitSites(src).map((site) => site.line);
}

function scanTree(): (ExitSite & { file: string })[] {
  return [join(CLI, "bin"), join(CLI, "src")].flatMap((dir) =>
    sourceFiles(dir).flatMap((path) =>
      zeroExitSites(readFileSync(path, "utf8"), path).map((site) => ({
        file: relative(CLI, path),
        ...site,
      })),
    ),
  );
}

function violations(found: (ExitSite & { file: string })[]): string[] {
  const offenders: string[] = [];
  for (const entry of ALLOWLIST) {
    for (const context of entry.contexts) {
      const matches = found.filter((site) => site.file === entry.file && site.context === context);
      if (matches.length !== 1) {
        offenders.push(`${entry.file}: ${context}: expected one approved exit, found ${matches.length}`);
      }
    }
  }
  for (const site of found) {
    if (!ALLOWLIST.some((entry) => entry.file === site.file && entry.contexts.includes(site.context))) {
      offenders.push(`${site.file}:${site.line}: ${site.context}: exit is not allowlisted`);
    }
  }
  return offenders;
}

describe("cli#750 — no-argument and explicit-zero process.exit contexts", () => {
  test("bin/ and src/ match the approved AST contexts", () => {
    for (const entry of ALLOWLIST) expect(entry.reason.trim()).not.toBe("");
    expect(violations(scanTree())).toEqual([]);
  });

  test("replacing an approved exit elsewhere in the same file is rejected", () => {
    const file = "src/commands/secrets.ts";
    const source = readFileSync(join(CLI, file), "utf8");
    const mutated = source.replace("process.exit(0);", "") +
      "\nexport function replacement() { process.exitCode = 1; process.exit(0); }";
    const sites = zeroExitSites(mutated, file).map((site) => ({ file, ...site }));
    const found = scanTree();
    expect(sites).toHaveLength(found.filter((site) => site.file === file).length);
    const errors = violations([...found.filter((site) => site.file !== file), ...sites]);
    expect(errors).toHaveLength(2);
    expect(errors.some((error) => error.includes("handleVerify") && error.includes("found 0"))).toBe(true);
    expect(errors.some((error) => error.includes("replacement") && error.includes("not allowlisted"))).toBe(true);
  });

  test("removing an approved exit is rejected", () => {
    const found = scanTree();
    const removed = found.find((site) => site.file === "src/commands/secrets.ts");
    expect(removed).toBeDefined();
    expect(violations(found.filter((site) => site !== removed))).toEqual([
      `${removed?.file}: ${removed?.context}: expected one approved exit, found 0`,
    ]);
  });

  test("unrelated functions and line shifts preserve an exit context", () => {
    const source = "function approved() { process.exit(0); }";
    const context = zeroExitSites(source)[0]?.context;
    expect(zeroExitSites("\nfunction unrelated() { return 1; }\n" + source)[0]?.context).toBe(context);
  });

  test("the scanner flags an added process.exit(0) in a command", () => {
    expect(zeroExitLines("export function runThing() { process.exit(0); }")).toEqual([1]);
    expect(zeroExitLines("export function runThing() { process.exit(); }")).toEqual([1]);
    expect(zeroExitLines("export function runThing() { process.exit(0x0); }")).toEqual([1]);
  });

  test.each([
    "((0))", "-0", "+0", "-(+(-0x0))", "0b0", "0o0", "0.0e3",
    "1 - 1", "0 * 12", "0 / 2", "2 % 2", "0 ** 2", "1 >> 1", "0 << 1",
    "1 >>> 1", "1 & 0", "0 | 0", "1 ^ 1", "~-1", "(0 as number)!", "0 satisfies number",
  ])("the scanner records numeric constant zero: %s", (expression) => {
    expect(zeroExitLines(`process.exit(${expression});`)).toEqual([1]);
  });

  test.each(["-1", "+1", "1 + 1", "0 / 0", "1 / 0", "0 ** 0", "1 << 1", "~0"])(
    "the scanner ignores a nonzero or nonfinite numeric constant: %s", (expression) => {
      expect(zeroExitLines(`process.exit(${expression});`)).toEqual([]);
    },
  );

  test("the scanner ignores refusals, the completion tail, comments and strings", () => {
    expect(zeroExitLines("export function runThing() { process.exit(1); }")).toEqual([]);
    expect(
      zeroExitLines(
        "main().then(() => process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0));",
      ),
    ).toEqual([]);
    expect(zeroExitLines("// process.exit(0)\nconst note = 'process.exit(0)';")).toEqual([]);
  });
});
