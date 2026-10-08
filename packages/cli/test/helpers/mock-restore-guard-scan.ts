/**
 * mock-restore-guard-scan.ts — the static scanner behind the cli#555 guard.
 *
 * A cli test file runs in ONE bun process, alongside every other test file the
 * suite loads. `spyOn(...)` replaces a property on a shared target (a global, a
 * module namespace object, a prototype), so a spy a file does not undo changes
 * what a LATER file sees. cli#544 hit exactly this: a prototype `connect` spy
 * left in place made two transport tests time out only in suite order.
 *
 * `mock.module(...)` is treated as a different case: measured on bun 1.3.10,
 * `mock.restore()` does NOT undo a module mock — a later consumer of the module
 * still receives the replacement (mock-restore-guard.test.ts runs that probe as
 * a regression). So this scanner REJECTS `mock.module(...)` in a shared-process
 * `*.test.ts` file rather than accepting a teardown restore for it; such a file
 * needs child-process isolation.
 *
 * The scanner reads each test file's SOURCE and reports:
 *   - `module-mock-needs-child-process` — the file calls `mock.module(...)`.
 *   - `spy-not-restored-in-teardown` — the file registers a `spyOn(...)` that no
 *     reachable restore covers. A restore covers a registration when it is
 *     reachable (not inside a statically dead branch such as `if (false)`) and
 *     its describe scope encloses the registration: either a `mock.restore()`
 *     in an `afterEach` / `afterAll` hook, or a `.mockRestore()` on the spy's
 *     binding (or on an array the binding was pushed into). A restore that a
 *     registration's scope does not enclose does not cover it.
 *   - `env-not-restored-in-teardown` — a `beforeEach` / `beforeAll` hook assigns
 *     a dotted `process.env.NAME` that no teardown restores, either by name
 *     (`delete process.env.NAME` / `process.env.NAME = …`) or through a
 *     recognised save/restore object that captured the name.
 *
 * It is textual and deliberately conservative. It strips comments and string /
 * template literals first, so a pattern named in a comment (several files warn
 * against `mock.module` in a comment) is not counted as code. Its scope is the
 * source it is given: a process entry point the suite loads through an imported
 * helper or a `--preload` is not a `*.test.ts` file and is not scanned, and a
 * `spyOn` / `mock.module` inside a template interpolation is part of the
 * blanked literal, so it is not seen even though the interpolation runs.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

export type Finding =
  | { kind: "spy-not-restored-in-teardown"; detail: string }
  | { kind: "module-mock-needs-child-process"; detail: string }
  | { kind: "env-not-restored-in-teardown"; names: string[] };

const SETUP_HOOKS = ["beforeEach", "beforeAll"];
const TEARDOWN_HOOKS = ["afterEach", "afterAll"];

/**
 * Replace every comment and string / template literal with spaces, keeping
 * newlines (including an escaped line continuation, so a three-line literal
 * still spans three lines) so line numbers survive. What remains is the code
 * around them, which is what the registrations, hooks and `process.env` writes
 * are matched against: a `//` inside a string, or a `spyOn(` inside a comment,
 * is not read as code. A template literal's interpolations are code, not data,
 * and are blanked with the literal, so a registration or restore written inside
 * one is not seen.
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
    // An escaped line continuation (\<newline>) keeps its newline so the line
    // count does not shrink; every other escaped pair becomes two spaces.
    if (c === "\\") {
      out += d === "\n" ? "\n " : "  ";
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

interface Call {
  /** Index of the call's callee (the `s` of `spyOn`). */
  start: number;
  /** Index of the `(` that opens the argument list. */
  bodyStart: number;
  /** Index of the `)` that closes it. */
  bodyEnd: number;
}

/**
 * Each call to `name(` in `source`, using balanced parentheses. A call whose
 * opening paren falls inside one already consumed — a nested same-name call — is
 * skipped, so only the outermost such calls are reported.
 */
function findCalls(source: string, name: string): Call[] {
  const calls: Call[] = [];
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
    calls.push({ start: match.index + match[1]!.length, bodyStart: open, bodyEnd: end });
    re.lastIndex = end + 1;
  }
  return calls;
}

/**
 * The argument text `( … )` of the OUTERMOST call to `name(` in `source`. A
 * nested same-name call (`spyOn(spyOn(a, b), c)`) is skipped: a call whose
 * opening paren falls inside the one already consumed is not reported again,
 * so such an expression yields one body, not two. The caller passes a stripped
 * source, so parentheses inside string or template literals are already spaces.
 */
export function findCallBodies(source: string, name: string): string[] {
  return findCalls(source, name).map((call) => source.slice(call.bodyStart, call.bodyEnd + 1));
}

function hookBodies(source: string, hooks: string[]): string {
  return hooks
    .flatMap((hook) => findCalls(source, hook))
    .map((call) => source.slice(call.bodyStart, call.bodyEnd + 1))
    .join("\n");
}

interface Span {
  start: number;
  end: number;
}

/** The parenthesised bodies of the outermost `describe(…)` calls, sorted outermost first. */
function describeSpans(code: string): Span[] {
  return findCalls(code, "describe")
    .map((call) => ({ start: call.bodyStart, end: call.bodyEnd }))
    .sort((a, b) => a.start - b.start);
}

/** The describe spans that lexically enclose `index`, outermost first. */
function scopeChain(describes: Span[], index: number): Span[] {
  return describes.filter((span) => span.start < index && index < span.end);
}

/** `outer` is `inner` or an ancestor of it. */
function isPrefix(outer: Span[], inner: Span[]): boolean {
  if (outer.length > inner.length) return false;
  return outer.every((span, i) => span.start === inner[i]!.start);
}

/**
 * The bodies of `if (false) …` / `if (0) …` / `while (false) …` guards in
 * `code`. A restore inside one of these never runs, so it does not count.
 */
function deadSpans(code: string): Span[] {
  const spans: Span[] = [];
  const re = /\b(?:if|while)\s*\(\s*(?:false|0)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    let i = match.index + match[0].length;
    while (i < code.length && /\s/.test(code[i]!)) i++;
    if (code[i] === "{") {
      let depth = 0;
      let j = i;
      for (; j < code.length; j++) {
        if (code[j] === "{") depth++;
        else if (code[j] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      spans.push({ start: i, end: j });
    } else {
      const semi = code.indexOf(";", i);
      spans.push({ start: i, end: semi === -1 ? code.length : semi });
    }
  }
  return spans;
}

const inSpans = (spans: Span[], index: number) => spans.some((span) => span.start <= index && index <= span.end);

interface Binding {
  binding: string | null;
  isArray: boolean;
}

/** The array literal `NAME = [ … ]` spans in `code`. */
function arrayLiterals(code: string): Array<Span & { name: string }> {
  const out: Array<Span & { name: string }> = [];
  const re = /([A-Za-z_$][\w$]*)\s*=\s*\[/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const open = code.indexOf("[", match.index);
    let depth = 0;
    let end = open;
    for (; end < code.length; end++) {
      if (code[end] === "[") depth++;
      else if (code[end] === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ start: open, end, name: match[1]! });
    re.lastIndex = end + 1;
  }
  return out;
}

/** `ARRAY.push(NAME)` — which spy binding was pushed into which array. */
function pushTargets(code: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /([A-Za-z_$][\w$]*)\.push\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) map.set(match[2]!, match[1]!);
  return map;
}

/**
 * The binding a `spyOn(…)` call is stored under: `NAME = spyOn(…)`,
 * `ARRAY.push(spyOn(…))`, or an element of an `ARRAY = [ … ]` literal. Returns
 * a null binding when the call is not stored anywhere readable.
 */
function bindingOf(code: string, call: Call, arrays: Array<Span & { name: string }>): Binding {
  const before = code.slice(Math.max(0, call.start - 120), call.start);
  const pushed = before.match(/([A-Za-z_$][\w$]*)\.push\(\s*$/);
  if (pushed) return { binding: pushed[1]!, isArray: true };
  const assigned = before.match(/([A-Za-z_$][\w$]*)(?:\s*:[^=;(){}\n]*)?\s*=\s*$/);
  if (assigned) return { binding: assigned[1]!, isArray: false };
  const enclosing = arrays
    .filter((span) => span.start < call.start && call.start < span.end)
    .sort((a, b) => b.start - a.start)[0];
  if (enclosing) return { binding: enclosing.name, isArray: true };
  return { binding: null, isArray: false };
}

/** Every `RECEIVER.mockRestore()` call in `code`. */
function restores(code: string): Array<{ receiver: string; index: number }> {
  const out: Array<{ receiver: string; index: number }> = [];
  const re = /([A-Za-z_$][\w$]*)\s*\??\.\s*mockRestore\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) out.push({ receiver: match[1]!, index: match.index });
  return out;
}

interface IterTarget {
  variable: string;
  array: string;
  start: number;
  end: number;
}

/** The loop bodies of `for (const V of ARRAY) …` and `ARRAY.forEach((V) => …)`. */
function iterationTargets(code: string): IterTarget[] {
  const out: IterTarget[] = [];
  const forRe = /\bfor\s*\(\s*(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = forRe.exec(code)) !== null) {
    const close = code.indexOf(")", match.index);
    if (close === -1) continue;
    out.push({ variable: match[1]!, array: match[2]!, ...statementSpan(code, close + 1) });
  }
  const eachRe = /([A-Za-z_$][\w$]*)\.forEach\(\s*\(?\s*([A-Za-z_$][\w$]*)/g;
  while ((match = eachRe.exec(code)) !== null) {
    const arrow = code.indexOf("=>", match.index);
    if (arrow === -1) continue;
    out.push({ variable: match[2]!, array: match[1]!, ...statementSpan(code, arrow + 2) });
  }
  return out;
}

/** The span of the `{ … }` block or `;`-terminated statement starting at `from`. */
function statementSpan(code: string, from: number): Span {
  let i = from;
  while (i < code.length && /\s/.test(code[i]!)) i++;
  if (code[i] === "{") {
    let depth = 0;
    let j = i;
    for (; j < code.length; j++) {
      if (code[j] === "{") depth++;
      else if (code[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return { start: i, end: j };
  }
  const semi = code.indexOf(";", i);
  return { start: i, end: semi === -1 ? code.length : semi };
}

/** The dotted `process.env.NAME = …` names assigned in `source`. */
/** Like {@link stripCommentsAndStrings} but removes comments only, keeping string contents. */
function stripComments(source: string): string {
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
      } else {
        if (c === "'") state = "single";
        else if (c === '"') state = "double";
        else if (c === "`") state = "template";
        out += c;
      }
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else out += " ";
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") {
        state = "code";
        out += "  ";
        i++;
      } else out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (c === "\\") {
      out += d === "\n" ? "\n " : "  ";
      i++;
      continue;
    }
    if ((state === "single" && c === "'") || (state === "double" && c === '"') || (state === "template" && c === "`")) {
      state = "code";
    }
    out += c;
  }
  return out;
}

function hookBodiesRaw(source: string, hooks: string[]): string {
  return hooks
    .flatMap((hook) => findCalls(source, hook))
    .map((call) => source.slice(call.bodyStart, call.bodyEnd + 1))
    .join("\n");
}

interface SavedGroup {
  object: string;
  names: string[] | "all";
}

/** String literals in a comma-separated list. */
function literals(list: string): string[] {
  return [...list.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
}

/**
 * The env objects a setup hook snapshots, with the names each one captures:
 * a whole-environment snapshot (`OBJ = { ...process.env }`), an
 * `Object.fromEntries([…])` list, or a `for (const K of […]) OBJ[K] = process.env[K]`
 * loop. An unrecognised save form yields no group, so its names are not covered.
 */
function savedGroups(setup: string): SavedGroup[] {
  const groups: SavedGroup[] = [];
  for (const m of setup.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*\{\s*\.\.\.\s*process\.env\s*\}/g)) {
    groups.push({ object: m[1]!, names: "all" });
  }
  for (const m of setup.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*Object\.fromEntries\(\s*\[([^\]]*)\]/g)) {
    groups.push({ object: m[1]!, names: literals(m[2]!) });
  }
  for (const m of setup.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*\{([^{}]*)\}/g)) {
    const names = [...m[2]!.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*process\.env\.\1/g)].map((pair) => pair[1]!);
    if (names.length > 0) groups.push({ object: m[1]!, names });
  }
  for (const m of setup.matchAll(
    /for\s*\(\s*(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s+of\s*\[([^\]]*)\]\s*\)\s*\{?\s*([A-Za-z_$][\w$]*)\[\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*process\.env\[\s*([A-Za-z_$][\w$]*)\s*\]/g,
  )) {
    if (m[1] === m[4] && m[1] === m[5]) groups.push({ object: m[3]!, names: literals(m[2]!) });
  }
  return groups;
}

/**
 * The env objects a teardown hook restores wholesale: a
 * `for (const [K, V] of Object.entries(OBJ))` loop whose body both deletes and
 * re-assigns `process.env[K]`, or a `process.env = OBJ` snapshot restore.
 */
function envRestoreObjects(teardown: string): string[] {
  const objects: string[] = [];
  const loopRe = /for\s*\(\s*(?:const\s+|let\s+|var\s+)?\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s+of\s+Object\.entries\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  for (const m of teardown.matchAll(loopRe)) {
    const key = m[1]!;
    let from = m.index + m[0].length;
    if (teardown[from] === ")") from++;
    const body = statementSpan(teardown, from);
    const bodyText = teardown.slice(body.start, body.end + 1);
    const del = new RegExp(`delete\\s+process\\.env\\[\\s*${key}\\s*\\]`).test(bodyText);
    const assign = new RegExp(`process\\.env\\[\\s*${key}\\s*\\]\\s*=`).test(bodyText);
    if (del && assign) objects.push(m[3]!);
  }
  for (const m of teardown.matchAll(/process\.env\s*=\s*([A-Za-z_$][\w$]*)/g)) objects.push(m[1]!);
  return objects;
}

function envNamesAssigned(source: string): string[] {
  const names = new Set<string>();
  const dotted = /process\.env\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?!=)/g;
  let match: RegExpExecArray | null;
  while ((match = dotted.exec(source)) !== null) names.add(match[1]!);
  return [...names];
}

/**
 * Every assigned name is restored: by name (a dotted `delete process.env.NAME`
 * or `process.env.NAME = …`), or by a recognised whole-object save/restore that
 * captured the name. A stray `process.env[…]` read or `delete process.env[…]`
 * of some other key restores no name and does not count.
 */
function envRestoredInTeardown(teardown: string, names: string[], groups: SavedGroup[]): boolean {
  const restored = envRestoreObjects(teardown);
  const covers = (name: string) => {
    const byName = new RegExp(`(?:delete\\s+process\\.env\\.${name}\\b|process\\.env\\.${name}\\s*=(?!=))`).test(teardown);
    if (byName) return true;
    return groups.some(
      (group) => restored.includes(group.object) && (group.names === "all" || group.names.includes(name)),
    );
  };
  return names.every(covers);
}

/** Every finding this scanner reports for one file's source. */
export function analyzeSource(source: string): Finding[] {
  const code = stripCommentsAndStrings(source);
  const findings: Finding[] = [];

  const moduleMocks = findCalls(code, "mock\\.module");
  if (moduleMocks.length > 0) {
    findings.push({
      kind: "module-mock-needs-child-process",
      detail: `${moduleMocks.length} mock.module() call(s): mock.restore() does not undo a module mock on bun 1.3.10, so a shared-process test file must not register one`,
    });
  }

  const spies = findCalls(code, "spyOn");
  if (spies.length > 0) {
    const describes = describeSpans(code);
    const dead = deadSpans(code);
    const arrays = arrayLiterals(code);
    const pushes = pushTargets(code);
    const iterations = iterationTargets(code);
    const restoreList = restores(code).map((restore) => ({
      ...restore,
      chain: scopeChain(describes, restore.index),
      dead: inSpans(dead, restore.index),
    }));
    const teardownCalls = TEARDOWN_HOOKS.flatMap((hook) => findCalls(code, hook));
    const blankets = findCalls(code, "mock\\.restore")
      .filter((call) => teardownCalls.some((body) => body.bodyStart < call.start && call.start < body.bodyEnd))
      .map((call) => ({ chain: scopeChain(describes, call.start), dead: inSpans(dead, call.start) }));

    const arrayCovered = (array: string, chain: Span[]): boolean =>
      restoreList.some((restore) => {
        if (restore.dead || !isPrefix(restore.chain, chain)) return false;
        if (restore.receiver === array) return true;
        return iterations.some(
          (loop) => loop.array === array && loop.variable === restore.receiver && loop.start < restore.index && restore.index < loop.end,
        );
      });
    const nameCovered = (name: string, chain: Span[]): boolean =>
      restoreList.some((restore) => !restore.dead && restore.receiver === name && isPrefix(restore.chain, chain));

    let uncovered = 0;
    for (const spy of spies) {
      const chain = scopeChain(describes, spy.start);
      if (blankets.some((blanket) => !blanket.dead && isPrefix(blanket.chain, chain))) continue;
      const { binding, isArray } = bindingOf(code, spy, arrays);
      if (!binding) {
        uncovered++;
        continue;
      }
      const covered = isArray
        ? arrayCovered(binding, chain)
        : nameCovered(binding, chain) || (pushes.has(binding) && arrayCovered(pushes.get(binding)!, chain));
      if (!covered) uncovered++;
    }
    if (uncovered > 0) {
      findings.push({
        kind: "spy-not-restored-in-teardown",
        detail: `${uncovered} spyOn(...) registration(s) with no reachable restore covering them`,
      });
    }
  }

  const setup = hookBodies(code, SETUP_HOOKS);
  const assigned = envNamesAssigned(setup);
  if (assigned.length > 0) {
    const stripped = stripComments(source);
    const teardown = hookBodies(code, TEARDOWN_HOOKS);
    const groups = savedGroups(hookBodiesRaw(stripped, SETUP_HOOKS));
    if (!envRestoredInTeardown(teardown, assigned, groups)) {
      const restored = envRestoreObjects(teardown);
      const missing = assigned.filter((name) => {
        const byName = new RegExp(`(?:delete\\s+process\\.env\\.${name}\\b|process\\.env\\.${name}\\s*=(?!=))`).test(teardown);
        return !(byName || groups.some((group) => restored.includes(group.object) && (group.names === "all" || group.names.includes(name))));
      });
      findings.push({ kind: "env-not-restored-in-teardown", names: missing });
    }
  }

  return findings;
}

/**
 * Every `*.test.ts` file under `rootDir`, recursively, sorted. Dot-directories
 * and `node_modules` are skipped (bun does not descend into them, and neither
 * does this walk); other directories, including `dist/`, are walked.
 */
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
