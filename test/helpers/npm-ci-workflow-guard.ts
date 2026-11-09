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

const PACKAGE_NAME = String.raw`(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*`;
const VERSION_SEGMENT = "(?:0|[1-9][0-9]{0,8})";
const EXACT_VERSION = `${VERSION_SEGMENT}\\.${VERSION_SEGMENT}\\.${VERSION_SEGMENT}`;
const GLOBAL_TOOL_INSTALL = new RegExp(
  `^npm install (?:-g|--global) (${PACKAGE_NAME})@(${EXACT_VERSION})(?: --registry=https:\\/\\/[A-Za-z0-9._~-]+(?:\\:[0-9]+)?(?:\\/[A-Za-z0-9._~\\/:-]*)?)?$`,
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
 * Approved real workflow lines containing `npm`.
 * Each entry is matched literally against a trimmed physical line. The
 * all-workflows test checks that every entry still matches a real line.
 */
export const EXACT_LINE_ALLOWLIST: readonly AllowlistEntry[] = [
  { text: "bun --no-install scripts/check-npm-pin-release-age.mjs", reason: "approved release-age gate" },
  { text: "# fails, packages 1-3 stay staged; npm offers no cleanup, no resume and", reason: "shell comment" },
  { text: "echo \"::error::RECOVERY, from a machine logged in to npm:\"", reason: "approved release message" },
  { text: "echo \"::error::  npm stage list                        # see what is pending\"", reason: "release guidance printed by echo" },
  { text: "echo \"::error::  npm stage view <stage-id>              # confirm version + contents\"", reason: "release guidance printed by echo" },
  { text: "echo \"::error::  npm stage reject <stage-id>            # for each staged package\"", reason: "release guidance printed by echo" },
  { text: "echo \"::group::npm stage publish — $nm (packages/$p)\"", reason: "approved release message" },
  { text: "# Capture npm's OWN output, so the failure branch below can branch on the", reason: "shell comment" },
  { text: "# error CODE npm reports rather than on the exit status alone. Exit status", reason: "shell comment" },
  { text: "out=\"$( cd \"packages/$p\" && npm stage publish --tag staged --access public 2>&1 )\"", reason: "approved staged release publish" },
  { text: "elif npm view \"$nm@$VERSION\" version >/dev/null 2>&1; then", reason: "approved published-version check" },
  { text: "codes=\"$(printf '%s\\n' \"$out\" | awk '/npm error code /{print $4}' | sort -u | paste -sd, -)\"", reason: "approved npm error parsing" },
  { text: "# Authentication failure for THIS package: npm never got far enough to", reason: "shell comment" },
  { text: "echo \"::error::npm reported an authentication failure (${codes:-no error code parsed}) — OIDC\"", reason: "approved release message" },
  { text: "echo \"::error::  - a Trusted Publisher registration exists for $nm on npmjs.com,\"", reason: "approved release message" },
  { text: "echo \"::error::    OIDC token npm swaps for a short-lived publish credential)\"", reason: "approved release message" },
  { text: "echo \"::error::  - npm is new enough — OIDC trusted publishing needs >= 11.5.1 and\"", reason: "approved release message" },
  { text: "# npm-stage(1): staged versions share the semver unique index with", reason: "shell comment" },
  { text: "# separate rule from 2FA — per npm-stage(1) only approve and reject", reason: "shell comment" },
  { text: "echo \"::error::npm reported ${codes:-a conflict} — most likely it is ALREADY STAGED from\"", reason: "approved release message" },
  { text: "echo \"::error::Why CI cannot resolve this itself: npm-stage(1) shares the semver\"", reason: "approved release message" },
  { text: "echo \"::error::npm error code(s): ${codes:-none reported in npm output}\"", reason: "approved release message" },
  { text: "echo \"::error::code. Read the npm output above and diagnose from it; do not assume a\"", reason: "approved release message" },
  { text: "echo \"**Approve:** a maintainer approves the staged release in npm (2FA). The version\"", reason: "approved release message" },
  { text: "HOME=\"$iso_home\" TPS_TEST_REQUIRE_NPM=1 bun run test", reason: "approved test command" },
  { text: "npm run build             # tsc — REQUIRED: the node-load tests read the built dist/src/index.js", reason: "approved plugin build or typecheck" },
  { text: "npm run build", reason: "approved plugin build or typecheck" },
  { text: "npm run typecheck:test", reason: "approved plugin build or typecheck" },
  { text: "npm run build           # tsc is GREEN after cli#393 — a compile failure MUST fail the job, never be swallowed", reason: "approved plugin build or typecheck" },

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

/** Check physical run-step lines containing `npm` against exact approved lines and shapes. */
export function npmCiLockDirs(run: string, workdir: string, label: string): string[] {
  const lines = physicalLines(run);
  const refuse = (entry: PhysicalLine, reason: string): never => {
    throw new Error(`${label}: cannot establish the npm ci directory: ${reason}: ${entry.text} (physical line ${entry.line})`);
  };
  const allowlist = new Map(EXACT_LINE_ALLOWLIST.map((entry) => [entry.text, entry]));
  const helpers: PhysicalLine[] = [];
  for (const entry of lines) {
    if (!/npm/i.test(entry.text)) continue;
    if (allowlist.has(entry.text)) continue;
    if (isAcceptedGlobalToolInstall(entry.text)) continue;
    if (HELPER_CALL.test(entry.text)) {
      helpers.push(entry);
      continue;
    }
    refuse(entry, "a run line containing npm is refused unless the whole line is an exact allowlist entry in test/helpers/npm-ci-workflow-guard.ts (add one with its reason), a tracked-lock helper call, or the bounded global tool install");
  }
  if (helpers.length === 0) return [];
  if (!/^(?!\/)[A-Za-z0-9_./-]*$/.test(workdir)) refuse(helpers[0], "non-literal working-directory");
  {
    const allowedSubstitutions = new Set(['"$(node scripts/heartbeat-real-openclaw-lane.mjs --pin)"']);
    const assigned = new Set<string>(["RUNNER_TEMP"]);
    const quotedValue = (value: string): boolean => {
      const names = scanQuotedValue(value);
      return names !== null && names.every((name) => assigned.has(name));
    };
    const dirs: string[] = [];
    for (const entry of lines) {
      const line = entry.text;
      if (line === "set -euo pipefail") continue;
      const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (assignment !== null) {
        const [, name, value] = assignment;
        if (!/^[a-z][a-z0-9_]*$/.test(name) || /^(?:PATH|NODE_.*|NPM_.*|GIT_.*|BASH.*|ENV|SHELLOPTS|SHELL|CDPATH|IFS|HOME|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_.*|XDG_.*|SFW_.*|SOCKET_.*|LD_.*|DYLD_.*|SSL_.*|OPENSSL_.*|.*_PROXY|COREPACK_.*|GITHUB_.*|RUNNER_.*)$/i.test(name)) {
          refuse(entry, "tool environment assignment is refused");
        }
        if (!quotedValue(value) && !allowedSubstitutions.has(value)) {
          refuse(entry, "unsupported helper-step line");
        }
        assigned.add(name);
        continue;
      }
      const helper = line.match(HELPER_CALL);
      if (helper !== null && !helper[3].startsWith("/") && helper[3] !== "-" &&
          (helper[2] === "--in-place" ? helper[4] === undefined : helper[4] !== undefined && quotedValue(helper[4])) &&
          resolveRepoDir(workdir, "scripts/npm-ci-tracked-lock.sh", `${label} physical line ${entry.line}`) === "scripts/npm-ci-tracked-lock.sh") {
        dirs.push(resolveRepoDir(workdir, helper[3], `${label} physical line ${entry.line}`));
        continue;
      }
      const echo = line.match(/^echo ("[A-Z_][A-Z0-9_]*=[^"\r\n]*") >> "\$GITHUB_ENV"$/);
      if (echo !== null && quotedValue(echo[1].replace(/^"[A-Z_][A-Z0-9_]*=/, '"'))) continue;
      refuse(entry, "unsupported helper-step line (helper requires a literal relative fixture directory and repository-root invocation)");
    }
    return dirs;
  }
}

export function assertNpmCiLockfilesRead(source: string, tracked: Set<string>, workflowName?: string): number {
  const workflow = parseWorkflow(source);
  let installs = 0;
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const defaultWorkdir = job.defaults?.run?.["working-directory"] ?? workflow.defaults?.run?.["working-directory"] ?? "";
    for (const [index, step] of job.steps.entries()) {
      if (step.run === undefined) continue;
      const label = `${workflowName === undefined ? "" : `workflow ${workflowName} `}job ${jobName} step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
      const dirs = npmCiLockDirs(step.run, step["working-directory"] ?? defaultWorkdir, label);
      const helperLines = physicalLines(step.run).filter((entry) => HELPER_CALL.test(entry.text));
      for (const [installIndex, dir] of dirs.entries()) {
        installs++;
        const lockfile = dir === "" ? "package-lock.json" : `${dir}/package-lock.json`;
        if (!tracked.has(lockfile)) {
          throw new Error(`${label}: ${lockfile} is not a tracked lockfile the gate reads (physical line ${helperLines[installIndex].line})`);
        }
      }
    }
  }
  return installs;
}
