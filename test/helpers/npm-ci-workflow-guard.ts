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

/**
 * Install subcommands and their aliases. npm's command docs list the install
 * aliases i, in, ins, inst, insta, instal, isntall and add
 * (docs/content/commands/npm-install.md); `npm ci` is its own command
 * (docs/content/commands/npm-ci.md); install-test and install-ci-test are
 * install subcommands (docs/content/commands/npm-install-test.md and
 * npm-install-ci-test.md). The short aliases are English words, so the guard
 * matches them only in the subcommand position; the long spellings are
 * matched anywhere after the npm word.
 */
const INSTALL_ALIASES = new Set([
  "ci", "install", "i", "add", "isntall", "in", "ins", "inst", "insta", "instal",
  "it", "install-test", "install-ci-test",
]);
const UNAMBIGUOUS_INSTALL_ALIASES = new Set(["ci", "install", "isntall", "install-test", "install-ci-test"]);

/** Delete quote characters, backslashes and `$'` prefixes. No quote state is tracked. */
function normalizeShellLine(text: string): string {
  return text.replace(/\$'/g, "").replace(/['"\\]/g, "");
}

/** Split a normalized line into shell words; separators delimit tokens. */
function normalizedTokens(normalized: string): string[] {
  return normalized.split(/[\s;&|()<>`]+/).filter((token) => token !== "");
}

/** An npm word that bash builds through brace expansion, such as `{npm,}`. */
function bracedNpm(line: string): boolean {
  return /\{[^{}]*\bnpm\b[^{}]*\}/.test(line);
}

/** Remove escaped backticks and their literal content; bash does not execute them. */
function stripEscapedBackticks(line: string): string {
  return line.replace(/\\`[\s\S]*?\\`/g, "");
}

/** A normalized line carrying an npm word and an install subcommand. */
function isInstallCandidate(line: string): boolean {
  const normalized = normalizeShellLine(stripEscapedBackticks(line));
  const tokens = normalizedTokens(normalized);
  const npm = tokens.indexOf("npm");
  const npmPresent = npm >= 0 || bracedNpm(line);
  if (!npmPresent) return false;
  if (npm >= 0) {
    const next = tokens[npm + 1];
    if (next !== undefined && INSTALL_ALIASES.has(next)) return true;
    return tokens.slice(npm + 1).some((token) => UNAMBIGUOUS_INSTALL_ALIASES.has(token));
  }
  return tokens.some((token) => UNAMBIGUOUS_INSTALL_ALIASES.has(token));
}

/** A normalized line carrying an npm word, an install subcommand and a shell indirection. */
function isUnclassifiableInstall(line: string): boolean {
  const normalized = normalizeShellLine(stripEscapedBackticks(line));
  const tokens = normalizedTokens(normalized);
  const npm = tokens.indexOf("npm");
  const npmPresent = npm >= 0 || bracedNpm(line);
  if (!npmPresent) return false;
  const next = npm >= 0 ? tokens[npm + 1] : undefined;
  const expansionSubcommand = next !== undefined && (next.startsWith("$") || next.includes("`"));
  const marker = /\$|`/.test(normalized) || /\beval\b/.test(normalized) ||
    /\bbash\s+-c\b/.test(normalized) || /\bsh\s+-c\b/.test(normalized) ||
    /(?:^|\s)env(?:\s|$)/.test(normalized) || /(?:^|\s)command(?:\s|$)/.test(normalized) ||
    /(?:^|\s)exec(?:\s|$)/.test(normalized) || /(?:^|\s)xargs(?:\s|$)/.test(normalized) ||
    /\{[^{}]*\}/.test(normalized);
  return marker && (isInstallCandidate(line) || expansionSubcommand);
}

/** An exact, version-pinned global tool install, which does not read a lockfile. */
const EXACT_VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const PACKAGE_NAME = String.raw`(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*`;
const GLOBAL_TOOL_INSTALL = new RegExp(
  `^npm install (?:-g|--global) (?:${PACKAGE_NAME})@(?:${EXACT_VERSION})(?: --registry=https:\\/\\/[A-Za-z0-9._~:\\/?#@!$+,=%-]+)?$`,
);

function isAcceptedGlobalToolInstall(line: string): boolean {
  const normalized = normalizeShellLine(line).trim();
  if (/[;|<>()`{}]|&&/.test(normalized)) return false;
  return GLOBAL_TOOL_INSTALL.test(normalized);
}

/** Accept only a tracked-lock helper call: the shape accepted on main, with literal options. */
const HELPER_CALL = /^bash (?:\.\/)?scripts\/npm-ci-tracked-lock\.sh --via (npm|sfw) (?:(--in-place) )?([A-Za-z0-9_./-]+)(?: ("[^"\r\n]*"|'[^'\r\n]*'))?(?: ((?:--ignore-scripts|--no-audit|--no-fund)(?: (?:--ignore-scripts|--no-audit|--no-fund))*))?$/;

/** Inspect npm install command words and helper calls in workflow run text.
 * Each logical line is normalized by deleting quotes, backslashes and `$'` prefixes,
 * then matched conservatively: an install candidate must be an accepted tracked-lock
 * helper call or an exact global tool install, and an install-like line carrying an
 * expansion or indirection is refused as unclassifiable. A command named entirely
 * through variables with no literal npm token on the line is not detected: the guard
 * does not follow variable values. Scripts and composite actions are outside this guard. */
export function npmCiLockDirs(run: string, workdir: string, label: string): string[] {
  const rawLogical = logicalLines(run).map(({ text, line }) => ({ text: text.trim(), line }))
    .filter((entry) => entry.text !== "");
  const logical = rawLogical.map(({ text, line }) => ({ text: stripShellComment(text).trim(), line }))
    .filter((entry) => entry.text !== "" && !entry.text.startsWith("#"));
  const lines = logical.map((entry) => entry.text);
  const refuse = (reason: string): never => {
    throw new Error(`${label}: cannot establish the npm ci directory: ${reason}`);
  };
  let unclassifiable: LogicalLine | null = null;
  let rawInstall: LogicalLine | null = null;
  let hasHelper = false;
  for (const entry of logical) {
    if (entry.text.includes("npm-ci-tracked-lock.sh")) hasHelper = true;
  }
  for (const entry of rawLogical) {
    if (HELPER_CALL.test(entry.text)) continue;
    if (isAcceptedGlobalToolInstall(entry.text)) continue;
    if (isUnclassifiableInstall(entry.text)) {
      if (unclassifiable === null) unclassifiable = entry;
      continue;
    }
    if (isInstallCandidate(entry.text) && rawInstall === null) rawInstall = entry;
  }
  if (unclassifiable !== null) refuse(`unclassifiable npm install-like line at line ${unclassifiable.line}: ${unclassifiable.text}`);
  if (rawInstall !== null) refuse(`raw npm install is refused; use the tracked-lock helper: ${rawInstall.text}`);
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
      const helper = line.match(HELPER_CALL);
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
  refuse(`raw npm install is refused; use the tracked-lock helper: ${lines.find((line) => /\bnpm\b(?!-).*\bci\b/.test(line))}`);
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
