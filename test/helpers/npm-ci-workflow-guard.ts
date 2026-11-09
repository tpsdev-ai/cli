import { load } from "js-yaml";

type WorkflowStep = { name?: string; run?: string; uses?: string; "working-directory"?: string };
type WorkflowJob = {
  steps: WorkflowStep[];
  defaults?: { run?: { "working-directory"?: string } };
};

export function parseWorkflow(source: string) {
  return load(source) as { jobs: Record<string, WorkflowJob>; defaults?: WorkflowJob["defaults"] };
}

export function scanQuotedValue(value: string): string[] | null {
  if (/^'[^'\r\n]*'$/.test(value)) return [];
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return null;
  const names: string[] = [];
  const end = value.length - 1;
  for (let index = 1; index < end;) {
    const char = value[index++];
    if (/[A-Za-z0-9_./ :+-]/.test(char)) continue;
    if (char !== "$") return null;
    const braced = value[index] === "{";
    if (braced) index++;
    const start = index;
    if (index >= end || !/[A-Za-z_]/.test(value[index])) return null;
    index++;
    while (index < end && /[A-Za-z0-9_]/.test(value[index])) index++;
    names.push(value.slice(start, index));
    if (braced && value[index++] !== "}") return null;
  }
  return names;
}

function resolveRepoDir(base: string, target: string, label: string): string {
  const parts = base.split("/").filter((segment) => segment !== "" && segment !== ".");
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) throw new Error(`${label}: ${target} leaves the repository root`);
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

type ShellWord = { raw: string; value: string | null };
type LogicalLine = { text: string; line: number };

/** Join `\`-newline continuations as bash does; keep each logical line's first physical line number. */
function logicalLines(run: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let text = "";
  let start = 1;
  let physical = 1;
  for (let index = 0; index < run.length; index++) {
    const char = run[index];
    if (char === "\\" && run[index + 1] === "\r" && run[index + 2] === "\n") {
      index += 2;
      physical++;
      continue;
    }
    if (char === "\\" && run[index + 1] === "\n") {
      index++;
      physical++;
      continue;
    }
    if (char === "\n") {
      lines.push({ text, line: start });
      text = "";
      physical++;
      start = physical;
      continue;
    }
    text += char;
  }
  lines.push({ text, line: start });
  return lines;
}

/** Drop a shell comment while preserving quoted text. */
function stripShellComment(line: string): string {
  return line.replace(/("[^"]*"|'[^']*')|\s+#.*$/g, (_whole, quoted: string | undefined) => quoted ?? "");
}

/** Consume `$VAR`, `${...}`, `$(...)` or a backtick substitution and return the index after it. */
function consumeSubstitution(line: string, start: number): number {
  if (line[start] === "`") {
    let index = start + 1;
    while (index < line.length) {
      if (line[index] === "\\") { index += 2; continue; }
      if (line[index] === "`") return index + 1;
      index++;
    }
    return line.length;
  }
  if (line[start] !== "$") return start + 1;
  if (line[start + 1] === "(") {
    let depth = 0;
    let quote: string | null = null;
    for (let index = start + 1; index < line.length; index++) {
      const char = line[index];
      if (quote !== null) {
        if (char === "\\" && quote === '"') { index++; continue; }
        if (char === quote) quote = null;
      } else if (char === "'" || char === '"' || char === "`") quote = char;
      else if (char === "(") depth++;
      else if (char === ")" && --depth === 0) return index + 1;
    }
    return line.length;
  }
  if (line[start + 1] === "{") {
    let depth = 1;
    for (let index = start + 2; index < line.length; index++) {
      if (line[index] === "\\") { index++; continue; }
      if (line[index] === "{") depth++;
      else if (line[index] === "}" && --depth === 0) return index + 1;
    }
    return line.length;
  }
  let index = start + 1;
  if (index < line.length && /[0-9@*#?$!-]/.test(line[index])) return index + 1;
  while (index < line.length && /[A-Za-z0-9_]/.test(line[index])) index++;
  return index;
}

/** Split one word with bash's single-quote, double-quote, backslash and concatenation rules. */
function parseShellWord(line: string, start: number): { word: ShellWord; next: number } {
  let index = start;
  let raw = "";
  let value = "";
  let resolvable = true;
  while (index < line.length) {
    const char = line[index];
    if (/\s/.test(char) || /[;&|()<>]/.test(char)) break;
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) {
        raw += line.slice(index);
        index = line.length;
        resolvable = false;
        break;
      }
      raw += line.slice(index, end + 1);
      value += line.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let closed = false;
      let inside = "";
      while (end < line.length) {
        const inner = line[end];
        if (inner === '"') { closed = true; end++; break; }
        if (inner === "\\" && (line[end + 1] === "$" || line[end + 1] === "`" || line[end + 1] === '"' || line[end + 1] === "\\")) {
          inside += line[end + 1];
          end += 2;
          continue;
        }
        if (inner === "$" || inner === "`") {
          const next = consumeSubstitution(line, end);
          inside += line.slice(end, next);
          end = next;
          resolvable = false;
          continue;
        }
        inside += inner;
        end++;
      }
      raw += line.slice(index, end);
      value += inside;
      if (!closed) resolvable = false;
      index = end;
      continue;
    }
    if (char === "\\") {
      const escaped = line[index + 1];
      if (escaped === undefined) { raw += char; index++; resolvable = false; break; }
      raw += char + escaped;
      value += escaped;
      index += 2;
      continue;
    }
    if (char === "$" || char === "`") {
      const end = consumeSubstitution(line, index);
      raw += line.slice(index, end);
      value += " ";
      index = end;
      resolvable = false;
      continue;
    }
    if (char === "*" || char === "?" || char === "[") resolvable = false;
    raw += char;
    value += char;
    index++;
  }
  return { word: { raw, value: resolvable ? value : null }, next: index };
}

/** Split a logical run-step line into simple commands by unquoted shell separators. */
function shellCommands(line: string): ShellWord[][] {
  const commands: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (/\s/.test(char)) { index++; continue; }
    if (char === "#") break;
    if (/[;&|()<>]/.test(char)) {
      if (words.length > 0) { commands.push(words); words = []; }
      index++;
      while (index < line.length && /[;&|<>]/.test(line[index])) index++;
      continue;
    }
    const parsed = parseShellWord(line, index);
    if (parsed.word.raw !== "") words.push(parsed.word);
    index = parsed.next;
  }
  if (words.length > 0) commands.push(words);
  return commands;
}

const RESOLVER_PREFIXES = new Set(["env", "command", "exec", "eval"]);

/** Classify a run-step line after unquoting: an npm install, or an unresolvable command position. */
function classifyShellLine(line: string): { install: boolean; unresolved: boolean } {
  let install = false;
  let unresolved = false;
  for (const words of shellCommands(line)) {
    let command = 0;
    while (command < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[command].raw)) command++;
    if (command >= words.length) continue;
    const first = words[command];
    const rest = words.slice(command + 1);
    const firstCi = rest.findIndex((word) => word.value === "ci");
    const firstNpm = rest.findIndex((word) => word.value === "npm");
    if (first.value === null && firstCi >= 0) unresolved = true;
    if (first.value !== null && RESOLVER_PREFIXES.has(first.value) && firstNpm >= 0 && firstCi > firstNpm) unresolved = true;
    for (let index = command; index < words.length; index++) {
      if (words[index].value !== "npm") continue;
      if (words.slice(index + 1).some((word) => word.value === "ci")) install = true;
    }
  }
  return { install, unresolved };
}

/** Inspect npm ci command words and helper calls in workflow run text.
 * Command words are unquoted before classification; an unresolvable command position carrying an npm ci install is refused. Scripts and composite actions are outside this guard. */
export function npmCiLockDirs(run: string, workdir: string, label: string): string[] {
  const logical = logicalLines(run).map(({ text, line }) => ({ text: stripShellComment(text).trim(), line }))
    .filter((entry) => entry.text !== "" && !entry.text.startsWith("#"));
  const lines = logical.map((entry) => entry.text);
  const refuse = (reason: string): never => {
    throw new Error(`${label}: cannot establish the npm ci directory: ${reason}`);
  };
  let unresolved: LogicalLine | null = null;
  let rawInstall: string | null = null;
  let hasHelper = false;
  for (const entry of logical) {
    if (entry.text.includes("npm-ci-tracked-lock.sh")) hasHelper = true;
    const classified = classifyShellLine(entry.text);
    if (classified.unresolved && unresolved === null) unresolved = entry;
    if (classified.install && rawInstall === null) rawInstall = entry.text;
  }
  if (unresolved !== null) refuse(`unclassifiable command word at line ${unresolved.line}: ${unresolved.text}`);
  if (rawInstall !== null) refuse(`raw npm ci is refused; use the tracked-lock helper: ${rawInstall}`);
  if (!hasHelper) return [];
  if (!/^(?!\/)[A-Za-z0-9_./-]*$/.test(workdir)) refuse("non-literal working-directory");
  if (lines.some((line) => line.includes("npm-ci-tracked-lock.sh"))) {
    const allowedSubstitutions = new Set(['"$(node scripts/heartbeat-real-openclaw-lane.mjs --pin)"']);
    const assigned = new Set<string>(["RUNNER_TEMP"]);
    const quotedValue = (value: string): boolean => {
      const names = scanQuotedValue(value);
      return names !== null && names.every((name) => assigned.has(name));
    };
    const dirs: string[] = [];
    for (const line of lines) {
      if (line === "set -euo pipefail") continue;
      const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (assignment !== null) {
        const [, name, value] = assignment;
        if (!/^[a-z][a-z0-9_]*$/.test(name) || /^(?:PATH|NODE_.*|NPM_.*|GIT_.*|BASH.*|ENV|SHELLOPTS|SHELL|CDPATH|IFS|HOME|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_.*|XDG_.*|SFW_.*|SOCKET_.*|LD_.*|DYLD_.*|SSL_.*|OPENSSL_.*|.*_PROXY|COREPACK_.*|GITHUB_.*|RUNNER_.*)$/i.test(name)) {
          refuse(`tool environment assignment is refused: ${line}`);
        }
        if (!quotedValue(value) && !allowedSubstitutions.has(value)) {
          refuse(`unsupported helper-step line: ${line}`);
        }
        assigned.add(name);
        continue;
      }
      const helper = line.match(/^bash (?:\.\/)?scripts\/npm-ci-tracked-lock\.sh --via (npm|sfw) (?:(--in-place) )?([A-Za-z0-9_./-]+)(?: ("[^"\r\n]*"|'[^'\r\n]*'))?(?: ((?:--ignore-scripts|--no-audit|--no-fund)(?: (?:--ignore-scripts|--no-audit|--no-fund))*))?$/);
      if (helper !== null && !helper[3].startsWith("/") && helper[3] !== "-" &&
          (helper[2] === "--in-place" ? helper[4] === undefined : helper[4] !== undefined && quotedValue(helper[4])) &&
          resolveRepoDir(workdir, "scripts/npm-ci-tracked-lock.sh", label) === "scripts/npm-ci-tracked-lock.sh") {
        dirs.push(resolveRepoDir(workdir, helper[3], label));
        continue;
      }
      const echo = line.match(/^echo ("[A-Z_][A-Z0-9_]*=[^"\r\n]*") >> "\$GITHUB_ENV"$/);
      if (echo !== null && quotedValue(echo[1].replace(/^"[A-Z_][A-Z0-9_]*=/, '"'))) continue;
      refuse(`unsupported helper-step line (helper requires a literal relative fixture directory and repository-root invocation): ${line}`);
    }
    return dirs;
  }
  refuse(`raw npm ci is refused; use the tracked-lock helper: ${lines.find((line) => /\bnpm\b(?!-).*\bci\b/.test(line))}`);
}

export function assertNpmCiLockfilesRead(source: string, tracked: Set<string>, workflowName?: string): number {
  const workflow = parseWorkflow(source);
  let installs = 0;
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const defaultWorkdir = job.defaults?.run?.["working-directory"] ?? workflow.defaults?.run?.["working-directory"] ?? "";
    for (const [index, step] of job.steps.entries()) {
      if (step.run === undefined) continue;
      const label = `${workflowName === undefined ? "" : `workflow ${workflowName} `}job ${jobName} step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
      for (const dir of npmCiLockDirs(step.run, step["working-directory"] ?? defaultWorkdir, label)) {
        installs++;
        const lockfile = dir === "" ? "package-lock.json" : `${dir}/package-lock.json`;
        if (!tracked.has(lockfile)) throw new Error(`${label}: ${lockfile} is not a tracked lockfile the gate reads`);
      }
    }
  }
  return installs;
}
