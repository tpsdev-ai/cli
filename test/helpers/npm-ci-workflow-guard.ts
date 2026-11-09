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

type PhysicalLine = { text: string; line: number };

/** Split a run block into physical lines. No continuation is joined and no comment is stripped. */
function physicalLines(run: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  const parts = run.split("\n");
  for (let index = 0; index < parts.length; index++) {
    const text = parts[index].replace(/\r$/, "").trim();
    if (text === "") continue;
    lines.push({ text, line: index + 1 });
  }
  return lines;
}

/**
 * Install subcommands and their aliases. npm's command docs list the install
 * aliases i, in, ins, inst, insta, instal, isntall and add
 * (docs/content/commands/npm-install.md); `npm ci` is its own command
 * (docs/content/commands/npm-ci.md); install-test and install-ci-test are
 * install subcommands (docs/content/commands/npm-install-test.md and
 * npm-install-ci-test.md). Short aliases are matched only in the subcommand
 * position to avoid matching prose; the long spellings are matched anywhere
 * after the npm word.
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

/** Split a normalized line into tokens; whitespace and shell separators delimit them. */
function normalizedTokens(normalized: string): string[] {
  return normalized.split(/[\s;&|()<>`]+/).filter((token) => token !== "");
}

function bracedNpm(line: string): boolean {
  return /\{[^{}]*\bnpm\b[^{}]*\}/.test(line);
}

/** The line's normalized tokens name npm and an install-subcommand token after it, or an expansion in the subcommand position. */
function isInstallCommandLine(line: string): boolean {
  const normalized = normalizeShellLine(line);
  const tokens = normalizedTokens(normalized);
  const npm = tokens.indexOf("npm");
  if (npm >= 0) {
    const next = tokens[npm + 1];
    if (next !== undefined && (INSTALL_ALIASES.has(next) || next.startsWith("$"))) return true;
    return tokens.slice(npm + 1).some((token) => UNAMBIGUOUS_INSTALL_ALIASES.has(token));
  }
  return bracedNpm(line) && tokens.some((token) => UNAMBIGUOUS_INSTALL_ALIASES.has(token));
}

/**
 * A physical line is npm-bearing when its normalized copy names npm and an
 * install-subcommand token or an expanded subcommand, when a backtick appears
 * on a line that names npm, when a line that names npm ends in a continuation
 * backslash, or when the raw line names an install subcommand with npm inside
 * a brace group.
 */
function isNpmBearing(line: string): boolean {
  const normalized = normalizeShellLine(line);
  const tokens = normalizedTokens(normalized);
  const npm = tokens.indexOf("npm");
  if (npm < 0) return bracedNpm(line) && isInstallCommandLine(line);
  if (/\\$/.test(line)) return true;
  if (line.includes("`")) return true;
  return isInstallCommandLine(line);
}

/**
 * An install-like spelling the guard cannot classify: it carries a shell marker
 * (substitution, backtick, eval, bash/sh -c, env, command, exec, xargs or a
 * brace group) together with an install subcommand or an expanded subcommand.
 */
function isUnclassifiableInstall(line: string): boolean {
  const normalized = normalizeShellLine(line);
  const tokens = normalizedTokens(normalized);
  const npm = tokens.indexOf("npm");
  if (npm < 0 && !bracedNpm(line)) return false;
  if (line.includes("`") && tokens.includes("npm")) return true;
  const next = npm >= 0 ? tokens[npm + 1] : undefined;
  const expansionSubcommand = next !== undefined && next.startsWith("$");
  const marker = /\$|`/.test(line) || /\beval\b/.test(line) ||
    /\bbash\s+-c\b/.test(line) || /\bsh\s+-c\b/.test(line) ||
    /(?:^|\s)env(?:\s|$)/.test(line) || /(?:^|\s)command(?:\s|$)/.test(line) ||
    /(?:^|\s)exec(?:\s|$)/.test(line) || /(?:^|\s)xargs(?:\s|$)/.test(line) ||
    /\{[^{}]*\}/.test(line);
  return marker && (isInstallCommandLine(line) || expansionSubcommand);
}

const PACKAGE_NAME = String.raw`(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*`;
const VERSION_SEGMENT = "(?:0|[1-9][0-9]{0,8})";
const EXACT_VERSION = `${VERSION_SEGMENT}\\.${VERSION_SEGMENT}\\.${VERSION_SEGMENT}`;
const GLOBAL_TOOL_INSTALL = new RegExp(
  `^npm install (?:-g|--global) (${PACKAGE_NAME})@(${EXACT_VERSION})(?: --registry=https:\\/\\/[A-Za-z0-9._~\\/:-]+)?$`,
);

/** Accept only a fully anchored global install with a bounded exact version. */
function isAcceptedGlobalToolInstall(line: string): boolean {
  const raw = line.trim();
  if (/[$`'"';&|<>(){}]|\\/.test(raw)) return false;
  return GLOBAL_TOOL_INSTALL.test(raw);
}

const QUOTED_VALUE = String.raw`(?:"(?:[A-Za-z0-9_./ :+-]|\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})*"|'[A-Za-z0-9_./ :+-]*')`;

/** Accept only a tracked-lock helper call: the shape accepted on main, with literal options. */
const HELPER_CALL = new RegExp(
  String.raw`^bash (?:\./)?scripts/npm-ci-tracked-lock\.sh --via (npm|sfw) (?:(--in-place) )?([A-Za-z0-9_./-]+)(?: (${QUOTED_VALUE}))?(?: ((?:--ignore-scripts|--no-audit|--no-fund)(?: (?:--ignore-scripts|--no-audit|--no-fund))*))?$`,
);

type AllowlistEntry = { text: string; reason: string };

/**
 * Exact real workflow lines that carry an npm token but cannot execute npm.
 * Each entry is matched literally against a trimmed physical line. The
 * all-workflows test checks that every entry still matches one real line.
 */
export const EXACT_LINE_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    text: "# `npm stage` subcommands (list/view/reject/approve) AT ALL. That is a",
    reason: "a shell comment executes nothing",
  },
  {
    text: 'echo "**Promote:** to make \\`npm install\\` serve this version, a maintainer runs, per package:"',
    reason: "echo prints its argument; the backticks are escaped and no command substitution runs",
  },
  {
    text: 'echo "  \\`npm dist-tag add @tpsdev-ai/cli@$VERSION latest\\`"',
    reason: "echo prints its argument; the backticks are escaped and no command substitution runs",
  },
  {
    text: 'echo "Until that promote, \\`npm install -g @tpsdev-ai/cli\\` keeps serving the previous version."',
    reason: "echo prints its argument; the backticks are escaped and no command substitution runs",
  },
];

/**
 * Inspect npm install command words and tracked-lock helper calls in workflow
 * run text.
 *
 * Each run block is split into physical lines: no continuation is joined, no
 * comment is stripped and no quote state is tracked. A physical line is
 * npm-bearing when its normalized copy (quotes, backslashes and `$'` deleted)
 * names npm and an install-subcommand token or an expanded subcommand, when a
 * backtick appears on a line that names npm, when a line that names npm ends in
 * a continuation backslash, or when the raw line names an install subcommand
 * with npm inside a brace group.
 *
 * After trimming leading and trailing whitespace, every npm-bearing physical
 * line must equal exactly one of: a tracked-lock helper call with a literal
 * relative directory (the shape accepted on main); the global tool shape
 * `npm install -g|--global <name>@<MAJOR.MINOR.PATCH>` with an optional literal
 * `--registry=https://...`; or an entry in EXACT_LINE_ALLOWLIST. Any other
 * npm-bearing line is refused, naming the workflow, job, step and physical
 * line.
 *
 * A command named entirely through variables with no literal npm token on the
 * line is not detected: the guard does not follow variable values. Scripts and
 * composite actions are outside this guard.
 */
export function npmCiLockDirs(run: string, workdir: string, label: string): string[] {
  const lines = physicalLines(run);
  const refuse = (reason: string): never => {
    throw new Error(`${label}: cannot establish the npm ci directory: ${reason}`);
  };
  const allowlist = new Map(EXACT_LINE_ALLOWLIST.map((entry) => [entry.text, entry]));
  let unclassifiable: PhysicalLine | null = null;
  let rawInstall: PhysicalLine | null = null;
  let hasHelper = false;
  for (const entry of lines) {
    if (entry.text.includes("npm-ci-tracked-lock.sh")) hasHelper = true;
  }
  for (const entry of lines) {
    // Helper call lines are validated by the helper-step pass below.
    if (entry.text.includes("npm-ci-tracked-lock.sh")) continue;
    if (!isNpmBearing(entry.text)) continue;
    if (isAcceptedGlobalToolInstall(entry.text)) continue;
    if (allowlist.has(entry.text)) continue;
    if (isUnclassifiableInstall(entry.text)) {
      if (unclassifiable === null) unclassifiable = entry;
      continue;
    }
    if (rawInstall === null) rawInstall = entry;
  }
  if (unclassifiable !== null) {
    refuse(`unclassifiable npm install-like line at physical line ${unclassifiable.line}: ${unclassifiable.text}`);
  }
  if (rawInstall !== null) {
    refuse(`raw npm install is refused; use the tracked-lock helper: ${rawInstall.text} (physical line ${rawInstall.line})`);
  }
  if (!hasHelper) return [];
  if (!/^(?!\/)[A-Za-z0-9_./-]*$/.test(workdir)) refuse("non-literal working-directory");
  const texts = lines.map((entry) => entry.text);
  if (texts.some((line) => line.includes("npm-ci-tracked-lock.sh"))) {
    const allowedSubstitutions = new Set(['"$(node scripts/heartbeat-real-openclaw-lane.mjs --pin)"']);
    const assigned = new Set<string>(["RUNNER_TEMP"]);
    const quotedValue = (value: string): boolean => {
      const names = scanQuotedValue(value);
      return names !== null && names.every((name) => assigned.has(name));
    };
    const dirs: string[] = [];
    for (const line of texts) {
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
  refuse(`raw npm install is refused; use the tracked-lock helper: ${texts.find((line) => /\bnpm\b(?!-).*\bci\b/.test(line))}`);
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
