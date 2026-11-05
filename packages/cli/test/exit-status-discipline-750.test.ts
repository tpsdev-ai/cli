// cli#750 — commands report status through `process.exitCode` and return.
// `bin/tps.ts` calls `process.exit` once, after the command returns, with that
// status. A `process.exit(0)` inside a command bypasses that tail and can
// replace a failure code already set. The deliberate zero-status exits below
// are daemon shutdown handlers, the npm launcher's version fast path, and
// in-frame success exits; each is pinned with a reason. A new one fails here.
import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CLI = join(import.meta.dir, "..");

interface ZeroExitAllowance {
  file: string;
  count: number;
  reason: string;
}

const ALLOWLIST: ZeroExitAllowance[] = [
  {
    file: "bin/tps.cjs",
    count: 1,
    reason: "npm launcher --version fast path; runs before any command can set a code",
  },
  {
    file: "src/utils/mail-bridge.ts",
    count: 1,
    reason: "SIGINT/SIGTERM shutdown handler stops the bridge core, then exits cleanly",
  },
  {
    file: "src/utils/mail-relay.ts",
    count: 2,
    reason: "mail-relay daemon SIGINT/SIGTERM shutdown handlers",
  },
  {
    file: "src/utils/llm-proxy.ts",
    count: 2,
    reason: "llm-proxy daemon SIGINT/SIGTERM shutdown handlers",
  },
  {
    file: "src/commands/bridge.ts",
    count: 3,
    reason: "adapter shutdown handlers (2) and the already-running start guard",
  },
  {
    file: "src/commands/agent.ts",
    count: 2,
    reason: "log-follow SIGINT handler and the unreachable tail after its never-resolving wait",
  },
  {
    file: "src/commands/mail-watch.ts",
    count: 1,
    reason: "mail-watch daemon SIGINT/SIGTERM shutdown handler",
  },
  {
    file: "src/commands/secrets.ts",
    count: 1,
    reason: "secrets verify exits 0 when there is nothing to verify",
  },
  {
    file: "src/commands/office.ts",
    count: 3,
    reason: "office relay/connect SIGINT/SIGTERM shutdown handlers",
  },
  {
    file: "src/commands/branch.ts",
    count: 2,
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

/** Zero-status `process.exit` calls: `process.exit()`, `process.exit(0)`. */
function zeroExitLines(src: string, file = "sample.ts"): number[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
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
        (ts.isNumericLiteral(arg) && Number(arg.text.replace(/_/g, "")) === 0);
      if (isZero) {
        lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

function scanTree(): { file: string; line: number }[] {
  return [join(CLI, "bin"), join(CLI, "src")].flatMap((dir) =>
    sourceFiles(dir).flatMap((path) =>
      zeroExitLines(readFileSync(path, "utf8"), path).map((line) => ({
        file: relative(CLI, path),
        line,
      })),
    ),
  );
}

describe("cli#750 — zero-status process.exit sites are pinned", () => {
  test("every zero-status exit in bin/ and src/ is allowlisted with a reason", () => {
    const found = scanTree();
    const offenders: string[] = [];

    for (const entry of ALLOWLIST) {
      expect(entry.reason.trim()).not.toBe("");
      const actual = found.filter((site) => site.file === entry.file).length;
      if (actual !== entry.count) {
        offenders.push(
          `${entry.file}: expected ${entry.count} allowlisted zero-status exit(s), found ${actual}`,
        );
      }
    }

    const allowedFiles = new Set(ALLOWLIST.map((entry) => entry.file));
    for (const site of found) {
      if (!allowedFiles.has(site.file)) {
        offenders.push(`${site.file}:${site.line}: zero-status process.exit is not allowlisted`);
      }
    }

    expect(offenders).toEqual([]);
    expect(found).toHaveLength(ALLOWLIST.reduce((sum, entry) => sum + entry.count, 0));
  });

  test("the scanner flags an added process.exit(0) in a command", () => {
    expect(zeroExitLines("export function runThing() { process.exit(0); }")).toEqual([1]);
    expect(zeroExitLines("export function runThing() { process.exit(); }")).toEqual([1]);
    expect(zeroExitLines("export function runThing() { process.exit(0x0); }")).toEqual([1]);
  });

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
