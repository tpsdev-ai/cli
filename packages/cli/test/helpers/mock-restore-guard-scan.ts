/**
 * mock-restore-guard-scan.ts — the static scanner behind the cli#555 guard.
 *
 * A cli test file runs in ONE bun process, alongside every other test file the
 * suite loads. `spyOn(...)` and `mock.module(...)` replace a property on a shared
 * target (a global, a module namespace object, a prototype), so a registration a
 * file does not undo changes what a LATER file sees. cli#544 hit exactly this: a
 * prototype `connect` spy left in place made two transport tests time out only
 * in suite order.
 *
 * This scanner reads each test file's SOURCE and reports:
 *   - `spy-not-restored-in-teardown` — the file registers a spy or a module mock
 *     but has no `mock.restore()` / `.mockRestore()` inside an `afterEach` /
 *     `afterAll` hook. A restore only on a test's happy path does not count: a
 *     throwing assertion would skip it and leak, so the restore must live in a
 *     teardown that always runs.
 *   - `env-not-restored-in-teardown` — a `beforeEach` / `beforeAll` hook assigns
 *     a `process.env` variable that no teardown restores (by name, or through a
 *     whole-environment reassignment `process.env = …` or a dynamic
 *     `process.env[…]` / `delete process.env[…]` restore-all).
 *
 * It is textual and deliberately conservative: it strips comments and string /
 * template literals first, so a pattern named in a comment (several files warn
 * against `mock.module` in a comment) is not counted, and it never attributes a
 * restore to a file that does not have one.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

export type Finding =
  | { kind: "spy-not-restored-in-teardown"; detail: string }
  | { kind: "env-not-restored-in-teardown"; names: string[] };

const SETUP_HOOKS = ["beforeEach", "beforeAll"];
const TEARDOWN_HOOKS = ["afterEach", "afterAll"];

/**
 * Replace every comment and string / template literal with spaces (newlines
 * kept, so line numbers survive). What remains is code only, which is what the
 * registrations, hooks and `process.env` writes are matched against. A `//`
 * inside a string, or a `spyOn(` inside a comment, therefore cannot be read as
 * code. Template-literal interpolations are blanked too — a template is data.
 */
export function stripCommentsAndStrings(source: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const d = source[i + 1];
    if (state === "code") {
      if (c === "/" && d === "/") {
        state = "line";
        out += "  ";
        i++;
      } else if (c === "/" && d === "*") {
        state = "block";
        out += "  ";
        i++;
      } else if (c === "'") {
        state = "single";
        out += " ";
      } else if (c === '"') {
        state = "double";
        out += " ";
      } else if (c === "`") {
        state = "template";
        out += " ";
      } else {
        out += c;
      }
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else {
        out += " ";
      }
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") {
        state = "code";
        out += "  ";
        i++;
      } else {
        out += c === "\n" ? "\n" : " ";
      }
      continue;
    }
    // A string or template literal: blank its body, honour backslash escapes.
    if (c === "\\") {
      out += "  ";
      i++;
      continue;
    }
    if ((state === "single" && c === "'") || (state === "double" && c === '"') || (state === "template" && c === "`")) {
      state = "code";
      out += " ";
      continue;
    }
    out += c === "\n" ? "\n" : " ";
  }
  return out;
}

/**
 * The argument text `( … )` of every call to `name(` in `source`, using balanced
 * parentheses. The caller passes a stripped source, so parentheses inside string
 * or template literals are already spaces and cannot unbalance the scan.
 */
export function findCallBodies(source: string, name: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(`(^|[^A-Za-z0-9_$.])${name}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const open = source.indexOf("(", match.index + match[0].length - 1);
    if (open === -1) continue;
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(open, end + 1));
    re.lastIndex = end + 1;
  }
  return bodies;
}

function hookBodies(source: string, hooks: string[]): string {
  return hooks.flatMap((hook) => findCallBodies(source, hook)).join("\n");
}

function envNamesAssigned(source: string): string[] {
  const names = new Set<string>();
  const dotted = /process\.env\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?!=)/g;
  let match: RegExpExecArray | null;
  while ((match = dotted.exec(source)) !== null) names.add(match[1]!);
  return [...names];
}

function envRestoredInTeardown(teardown: string, names: string[]): boolean {
  // A whole-environment reassignment or a dynamic restore restores every name.
  if (/process\.env\s*=(?!=)/.test(teardown)) return true;
  if (/process\.env\s*\[/.test(teardown)) return true;
  if (/delete\s+process\.env\s*\[/.test(teardown)) return true;
  // Otherwise every name the file set must be restored by name.
  return names.every((name) => {
    const restore = new RegExp(`(?:delete\\s+process\\.env\\.${name}\\b|process\\.env\\.${name}\\s*=(?!=))`);
    return restore.test(teardown);
  });
}

/** Every finding this scanner reports for one file's source. */
export function analyzeSource(source: string): Finding[] {
  const code = stripCommentsAndStrings(source);
  const findings: Finding[] = [];

  const registrations = [
    ...findCallBodies(code, "spyOn").map(() => "spyOn"),
    ...findCallBodies(code, "mock\\.module").map(() => "mock.module"),
  ];
  if (registrations.length > 0) {
    const teardown = hookBodies(code, TEARDOWN_HOOKS);
    const restored =
      new RegExp(`mock\\.restore\\s*\\(`).test(teardown) || new RegExp(`\\.mockRestore\\s*\\(`).test(teardown);
    if (!restored) {
      findings.push({
        kind: "spy-not-restored-in-teardown",
        detail: `${registrations.join(", ")} registered but no mock.restore()/mockRestore() in an ${TEARDOWN_HOOKS.join("/")} hook`,
      });
    }
  }

  const setup = hookBodies(code, SETUP_HOOKS);
  const assigned = envNamesAssigned(setup);
  if (assigned.length > 0) {
    const teardown = hookBodies(code, TEARDOWN_HOOKS);
    if (!envRestoredInTeardown(teardown, assigned)) {
      const missing = assigned.filter((name) => {
        const restore = new RegExp(`(?:delete\\s+process\\.env\\.${name}\\b|process\\.env\\.${name}\\s*=(?!=))`);
        return !restore.test(teardown);
      });
      findings.push({ kind: "env-not-restored-in-teardown", names: missing });
    }
  }

  return findings;
}

/** Every `*.test.ts` file under `rootDir`, recursively, sorted. */
export function discoverCliTestFiles(rootDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name));
      } else if (/\.test\.ts$/.test(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(rootDir);
  return found.sort();
}
