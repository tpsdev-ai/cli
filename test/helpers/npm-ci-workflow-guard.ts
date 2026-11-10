import { readFileSync } from "node:fs";
import { join } from "node:path";
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
 * Approved complete run blocks containing npm. Text is pinned here, independent
 * of workflow input. Variable or substitution indirection such as n${x}pm and
 * $(printf n)pm is outside the spelling check.
 */
export const EXACT_BLOCK_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    text: "bun --no-install scripts/check-npm-pin-release-age.mjs",
    reason: "release npm pin age gate block",
  },
  {
    text: [
      "echo \"::notice::If stage publishing is interrupted, check pending packages before re-running:\"",
      "echo \"::notice::  npm stage list\"",
      "echo \"::notice::  npm stage view <stage-id>\"",
      "echo \"::notice::Reject pending stages for this version with npm stage reject <stage-id> before re-running,\"",
      "echo \"::notice::or approve them and re-run to stage the remaining packages.\"",
    ].join("\n"),
    reason: "release stage interruption recovery notice block",
  },
  {
    text: [
      "set -euo pipefail",
      "VERSION=\"${GITHUB_REF_NAME#v}\"",
      "STAGED=()",
      "SKIPPED=()",
      "stage_recovery() {",
      "  echo \"::error::RECOVERY, from a machine logged in to npm:\"",
      "  echo \"::error::  npm stage list                        # see what is pending\"",
      "  echo \"::error::  npm stage view <stage-id>              # confirm version + contents\"",
      "  echo \"::error::then EITHER reject every pending stage for this version and re-run\"",
      "  echo \"::error::the tag clean:\"",
      "  echo \"::error::  npm stage reject <stage-id>            # for each staged package\"",
      "  echo \"::error::OR approve the ones already staged and let this re-run stage only\"",
      "  echo \"::error::the remainder — the already-PUBLISHED branch above will skip them.\"",
      "  echo \"::error::\"",
      "  echo \"::error::Do NOT leave a partial stage pending: packages/cli pins the platform\"",
      "  echo \"::error::binaries at exact versions, so a half-approved set publishes a CLI\"",
      "  echo \"::error::whose dependencies do not exist. All six go together.\"",
      "}",
      "disclose_pending() {",
      "  if [ \"${#STAGED[@]}\" -gt 0 ]; then",
      "    echo \"::error::PARTIAL STAGE: ${#STAGED[@]} package(s) were staged before this failure and\"",
      "    echo \"::error::are still pending:\"",
      "    echo \"::error::  ${STAGED[*]}\"",
      "    echo \"::error::Clear or approve them BEFORE re-running, or the re-run fails at the first\"",
      "    echo \"::error::already-staged package with an E409 collision, never reaching this one.\"",
      "    echo \"::error::\"",
      "  fi",
      "}",
      "for p in cli-darwin-arm64 cli-darwin-x64 cli-linux-arm64 cli-linux-x64 agent cli; do",
      "  nm=\"$(node -p \"require('./packages/$p/package.json').name\")\"",
      "  echo \"::group::npm stage publish — $nm (packages/$p)\"",
      "  # Capture npm's OWN output, so the failure branch below can branch on the",
      "  # error CODE npm reports rather than on the exit status alone. Exit status",
      "  # cannot tell an auth failure from a stage collision, and naming the wrong",
      "  # cause sends an operator hunting for a pending stage that does not exist.",
      "  set +e",
      "  out=\"$( cd \"packages/$p\" && npm stage publish --tag staged --access public 2>&1 )\"",
      "  rc=$?",
      "  set -e",
      "  printf '%s\\n' \"$out\"",
      "  if [ \"$rc\" -eq 0 ]; then",
      "    echo \"  staged $nm@$VERSION\"",
      "    STAGED+=(\"$nm\")",
      "  elif npm view \"$nm@$VERSION\" version >/dev/null 2>&1; then",
      "    # Already live. The old token path had this skip and the first draft of",
      "    # this step dropped it, which would have made a re-run after a partial",
      "    # failure die at the first package — the exact situation this workflow",
      "    # has to survive, since v0.6.0 failed mid-flight.",
      "    echo \"  already PUBLISHED $nm@$VERSION — skipping\"",
      "    SKIPPED+=(\"$nm\")",
      "  else",
      "    codes=\"$(printf '%s\\n' \"$out\" | awk '/npm error code /{print $4}' | sort -u | paste -sd, -)\"",
      "    if printf '%s\\n' \"$out\" | grep -qE 'ENEEDAUTH|E401|E403'; then",
      "      # Authentication failure for THIS package: npm never got far enough to",
      "      # look at the stage index, so the remedy is the trust relationship, not",
      "      # the staging area. Disclosure comes first (pending packages are",
      "      # cause-independent); then the recovery procedure, then the per-package",
      "      # registration checklist.",
      "      disclose_pending",
      "      echo \"::error::stage publish failed for $nm@$VERSION and it is not published.\"",
      "      echo \"::error::npm reported an authentication failure (${codes:-no error code parsed}) — OIDC\"",
      "      echo \"::error::did not authenticate for this package.\"",
      "      echo \"::error::\"",
      "      if [ \"${#STAGED[@]}\" -gt 0 ]; then",
      "        stage_recovery",
      "        echo \"::error::\"",
      "      fi",
      "      echo \"::error::Check, for THIS exact package name ($nm):\"",
      "      echo \"::error::  - a Trusted Publisher registration exists for $nm on npmjs.com,\"",
      "      echo \"::error::    with repository + workflow filename matching this job (trust is\"",
      "      echo \"::error::    per package, so a missing registration affects only $nm)\"",
      "      echo \"::error::  - this job declares permissions: id-token: write (it mints the\"",
      "      echo \"::error::    OIDC token npm swaps for a short-lived publish credential)\"",
      "      echo \"::error::  - npm is new enough — OIDC trusted publishing needs >= 11.5.1 and\"",
      "      echo \"::error::    the stage subcommands need >= 11.15.0 (see the npm upgrade step\"",
      "      echo \"::error::    for the current pin)\"",
      "      echo \"::error::\"",
      "      echo \"::error::Fix the registration or the OIDC claim, then re-run this tag.\"",
      "      exit 1",
      "    elif printf '%s\\n' \"$out\" | grep -qE 'E409|EPUBLISHCONFLICT|already exists|already staged'; then",
      "      # A stage collision — the case this recovery block is written for.",
      "      # npm-stage(1): staged versions share the semver unique index with",
      "      # published ones, so re-staging errors. CI cannot resolve it itself",
      "      # because a token issued through a trust relationship cannot run the",
      "      # `npm stage` subcommands (list/view/reject/approve) AT ALL. That is a",
      "      # separate rule from 2FA — per npm-stage(1) only approve and reject",
      "      # need interactive proof-of-presence; list and view do not — but the",
      "      # trust-relationship rule covers all four, so CI cannot inspect or",
      "      # reject a stage. Name the ambiguity instead of guessing at it.",
      "      disclose_pending",
      "      echo \"::error::stage publish failed for $nm@$VERSION and it is not published.\"",
      "      echo \"::error::npm reported ${codes:-a conflict} — most likely it is ALREADY STAGED from\"",
      "      echo \"::error::a previous run of this tag.\"",
      "      echo \"::error::\"",
      "      echo \"::error::Why CI cannot resolve this itself: npm-stage(1) shares the semver\"",
      "      echo \"::error::unique index between staged and published versions, and a token issued\"",
      "      echo \"::error::through a trust relationship cannot run the stage subcommands\"",
      "      echo \"::error::(list/view/reject/approve) at all — so this workflow cannot inspect or\"",
      "      echo \"::error::reject a staged package from CI. (2FA is not the reason: list and view\"",
      "      echo \"::error::need no proof-of-presence; only approve and reject do.)\"",
      "      echo \"::error::\"",
      "      stage_recovery",
      "      exit 1",
      "    else",
      "      # No diagnosis for this code. Say so rather than asserting the",
      "      # stage-collision cause, which is what the first real run proved wrong.",
      "      # Disclose any pending packages AND hand over the recovery procedure:",
      "      # both are cause-independent. Only the COLLISION DIAGNOSIS is withheld —",
      "      # we have not established a collision and must not claim one.",
      "      disclose_pending",
      "      echo \"::error::stage publish failed for $nm@$VERSION and it is not published.\"",
      "      echo \"::error::npm error code(s): ${codes:-none reported in npm output}\"",
      "      echo \"::error::The cause is UNCLASSIFIED — this workflow has no diagnosis for this\"",
      "      echo \"::error::code. Read the npm output above and diagnose from it; do not assume a\"",
      "      echo \"::error::staged collision. The collision diagnosis deliberately does not run.\"",
      "      echo \"::error::\"",
      "      if [ \"${#STAGED[@]}\" -gt 0 ]; then",
      "        stage_recovery",
      "        echo \"::error::\"",
      "      fi",
      "      exit 1",
      "    fi",
      "  fi",
      "  echo \"::endgroup::\"",
      "done",
      "{",
      "  echo \"staged_count=${#STAGED[@]}\"",
      "  echo \"skipped_count=${#SKIPPED[@]}\"",
      "} >> \"$GITHUB_OUTPUT\"",
    ].join("\n"),
    reason: "release stage publishing and error handling block",
  },
  {
    text: [
      "VERSION=\"${GITHUB_REF_NAME#v}\"",
      "STAGED_COUNT=\"${STAGED_COUNT:-0}\"",
      "SKIPPED_COUNT=\"${SKIPPED_COUNT:-0}\"",
      "{",
      "  echo \"### 📦 v$VERSION staged (tag: staged)\"",
      "  echo \"\"",
      "  echo \"**$STAGED_COUNT staged**, **$SKIPPED_COUNT skipped** (six packages attempted).\"",
      "  if [ \"$SKIPPED_COUNT\" -eq 0 ]; then",
      "    echo \"\"",
      "    echo \"**Nothing is live yet.**\"",
      "  else",
      "    echo \"\"",
      "    echo \"The $SKIPPED_COUNT skipped packages were already published — those are live.\"",
      "  fi",
      "  # Approval only applies when something was staged. Promotion, however, is",
      "  # the remaining step whenever ANY package exists for this version — including",
      "  # the re-run where all six were already published (STAGED=0, SKIPPED=6) and",
      "  # `latest` still points at the previous version. The two instructions have",
      "  # different preconditions, so they must not share one condition.",
      "  if [ \"$STAGED_COUNT\" -gt 0 ]; then",
      "    echo \"\"",
      "    echo \"**Approve:** a maintainer approves the staged release in npm (2FA). The version\"",
      "    echo \"then becomes public **under the \\`staged\\` dist-tag** — \\`latest\\` does NOT move.\"",
      "  fi",
      "  if [ \"$STAGED_COUNT\" -gt 0 ] || [ \"$SKIPPED_COUNT\" -gt 0 ]; then",
      "    echo \"\"",
      "    echo \"**Promote:** to make \\`npm install\\` serve this version, a maintainer runs, per package:\"",
      "    echo \"  \\`npm dist-tag add @tpsdev-ai/cli@$VERSION latest\\`\"",
      "    echo \"\"",
      "    echo \"Until that promote, \\`npm install -g @tpsdev-ai/cli\\` keeps serving the previous version.\"",
      "  fi",
      "} >> \"$GITHUB_STEP_SUMMARY\"",
    ].join("\n"),
    reason: "release summary block",
  },
  {
    text: [
      "iso_home=\"$(mktemp -d)\"",
      "HOME=\"$iso_home\" TPS_TEST_REQUIRE_NPM=1 bun run test",
      "if [ -e \"$iso_home/.tps\" ]; then",
      "  echo \"::error::the suite wrote $iso_home/.tps — HOME is not isolated\"",
      "  exit 1",
      "fi",
    ].join("\n"),
    reason: "HOME-isolated required-npm test block",
  },
  {
    text: [
      "npm run build             # tsc — REQUIRED: the node-load tests read the built dist/src/index.js",
      "bun run test              # the isolated launcher (see scripts/run-tests.mjs)",
    ].join("\n"),
    reason: "openclaw-tps-mail build and test block",
  },
  {
    text: [
      "npm run build",
      "npm run typecheck:test",
      "bun run test",
    ].join("\n"),
    reason: "openclaw-github-review build, typecheck and test block",
  },
  {
    text: [
      "npm run build           # tsc is GREEN after cli#393 — a compile failure MUST fail the job, never be swallowed",
      "test -f dist/src/index.js",
    ].join("\n"),
    reason: "openclaw-tps-mail node-load build block",
  },
  {
    text: [
      "set -euo pipefail",
      "pin=\"$(node scripts/heartbeat-real-openclaw-lane.mjs --pin)\"",
      "prefix=\"$RUNNER_TEMP/openclaw-$pin\"",
      "bash scripts/npm-ci-tracked-lock.sh --via sfw test/fixtures/heartbeat-openclaw \"$prefix\" --ignore-scripts --no-audit --no-fund",
      "echo \"OPENCLAW_BIN_DIR=$prefix/node_modules/.bin\" >> \"$GITHUB_ENV\"",
    ].join("\n"),
    reason: "pinned OpenClaw tracked-lock installation block",
  },
  {
    text: [
      "npm run build",
      "npm run typecheck:test",
      "test -f dist/src/index.js",
    ].join("\n"),
    reason: "openclaw-github-review gateway build block",
  },
];

function containsNpm(line: string): boolean {
  return line.toLowerCase().replace(/[\\'"]/g, "").includes("npm");
}

function hasUnbalancedLineQuotes(lines: PhysicalLine[]): boolean {
  for (const { text } of lines) {
    let quote = "";
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === "\\" && quote !== "'") {
        index++;
      } else if (quote === "") {
        if (char === "'" || char === '"') quote = char;
      } else if (char === quote) {
        quote = "";
      }
    }
    if (quote !== "") return true;
  }
  return false;
}

/** Check physical run-step lines containing npm against approved blocks and shapes. */
export function npmCiLockDirs(run: string, workdir: string, label: string): string[] {
  const lines = physicalLines(run);
  const refuse = (entry: PhysicalLine, reason: string): never => {
    throw new Error(`${label}: cannot establish the npm ci directory: ${reason}: ${entry.text} (physical line ${entry.line})`);
  };
  const approved = EXACT_BLOCK_ALLOWLIST.some((entry) => entry.text === run.replace(/\n+$/, ""));
  const flagged = lines.filter((entry) => containsNpm(entry.text));
  if (!approved && flagged.length > 0 &&
      (run.includes("`") || run.includes("$(") || hasUnbalancedLineQuotes(lines))) {
    refuse(lines.find((entry) => entry.text.includes("$(")) ?? flagged[0], "unapproved run block has a shell wrapper");
  }
  const helpers: PhysicalLine[] = [];
  for (const entry of lines) {
    if (!containsNpm(entry.text)) continue;
    if (approved) {
      if (HELPER_CALL.test(entry.text)) helpers.push(entry);
      continue;
    }
    if (isAcceptedGlobalToolInstall(entry.text)) continue;
    if (HELPER_CALL.test(entry.text)) {
      helpers.push(entry);
      continue;
    }
    refuse(entry, "a run block containing npm is refused unless the whole block is an exact allowlist entry in test/helpers/npm-ci-workflow-guard.ts (add one with its reason), or its flagged lines are tracked-lock helper calls or bounded global tool installs");
  }
  if (!approved && flagged.length > 0 && helpers.length === 0 &&
      lines.some((entry) => !isAcceptedGlobalToolInstall(entry.text))) {
    refuse(flagged[0], "unsupported global-install run block");
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

/* ─────────── workflow-invoked scripts and local composite actions (#820) ─────────── */

export type WorkflowTreeReport = {
  /** npm installs bound to a tracked lockfile (direct run lines and followed scripts). */
  installs: number;
  /** Repository-relative paths of every script and local action the scan followed. */
  followed: string[];
  /** Script invocations a followed script could not resolve to one repository file. */
  unresolved: string[];
};

export type UnresolvedInvocationAllowlistEntry = {
  script: string;
  line: number;
  token: string;
  reason: string;
};

/**
 * Computed script paths reviewed by hand because the scan cannot resolve them to
 * one repository file. Keyed by script path, physical line and exact token; an
 * entry whose line no longer holds that token is stale and fails the scan.
 */
export const UNRESOLVED_INVOCATION_ALLOWLIST: readonly UnresolvedInvocationAllowlistEntry[] = [
  // scripts/check-nono-pin.sh (a shell pin gate; no npm install).
  { script: "scripts/test-check-nono-pin.sh", line: 81, token: '"$gate"', reason: "$gate is scripts/check-nono-pin.sh" },
  // scripts/assert-bun-version.sh (a shell version check; no npm install).
  { script: "scripts/test-docker-bun-version.sh", line: 83, token: '"$assert"', reason: "$assert is scripts/assert-bun-version.sh" },
  // scripts/assert-bun-version.sh (a shell version check; no npm install).
  { script: "scripts/test-docker-bun-version.sh", line: 84, token: '"$assert"', reason: "$assert is scripts/assert-bun-version.sh" },
  // A generated fixture writer in the test's mktemp directory; it writes JSON and has no npm install.
  { script: "scripts/test-promote-latest.sh", line: 765, token: '"$work/mkstate.mjs"', reason: "$work/mkstate.mjs is a generated fixture writer" },
  // A generated fixture reader in the test's mktemp directory; it reads JSON and has no npm install.
  { script: "scripts/test-promote-latest.sh", line: 767, token: '"$work/latest.mjs"', reason: "$work/latest.mjs is a generated fixture reader" },
  // A generated reviewer driver in the scratch host module; it runs the fixture, not an npm install.
  { script: "scripts/reviewer/per-job-isolation-checks.sh", line: 172, token: '"$HOSTMOD/scripts/reviewer/evidence-harness.mjs"', reason: "$HOSTMOD is the scratch host module generated by this test" },
];

type UnresolvedEntry = { script: string; line: number; token: string };

type TreeContext = {
  root: string;
  tracked: Set<string>;
  installs: number;
  followed: string[];
  unresolved: string[];
  unresolvedEntries: UnresolvedEntry[];
  visiting: Set<string>;
};

const SCRIPT_FILE = String.raw`(?:\.\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:sh|bash|mjs|cjs|js|ts)`;
const COMMAND_START = String.raw`(?:^|[;&|{]\s*|\bthen\s+|\bdo\s+|\belse\s+)`;
const INSTALL_VERBS = new Set(["ci", "install", "i", "add"]);

function stripOuterQuotes(value: string): string {
  if (value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Physical lines with comment lines and here-document bodies removed. A
 * here-document body is data a script writes, not a command it runs, so an
 * install or an invocation inside one is not executed by the script.
 */
function shellLines(text: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  const rawLines = text.split("\n");
  let delimiter: string | null = null;
  let stripTabs = false;
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index].replace(/\r$/, "");
    if (delimiter !== null) {
      const candidate = stripTabs ? raw.replace(/^\t+/, "") : raw;
      if (candidate === delimiter) delimiter = null;
      continue;
    }
    const textLine = raw.trim();
    if (textLine === "" || textLine.startsWith("#")) continue;
    lines.push({ text: textLine, line: index + 1 });
    const heredoc = raw.match(/<<(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (heredoc !== null) {
      delimiter = heredoc[3];
      stripTabs = heredoc[1] === "-";
    }
  }
  return lines;
}

function isShellScript(rel: string, content: string): boolean {
  if (/\.(?:sh|bash)$/i.test(rel)) return true;
  const first = content.split("\n")[0] ?? "";
  return /^#!.*\b(?:ba)?sh\b/.test(first);
}

function scriptExists(ctx: TreeContext, rel: string): boolean {
  try {
    return readFileSync(join(ctx.root, rel), "utf8") !== null;
  } catch {
    return false;
  }
}

/** Resolve the literal suffix of a computed script path to one repository file. */
function resolveDynamicSuffix(ctx: TreeContext, token: string): string | null {
  const value = stripOuterQuotes(token);
  const variable = value.match(/^\$(?:\{?[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?(?:[%#][^}]*)?\}?|\([^)]*\)|`[^`]*`)/);
  if (variable === null) return null;
  let suffix = value.slice(variable[0].length);
  if (suffix.startsWith("/")) suffix = suffix.slice(1);
  if (suffix === "" || !/\.(?:sh|bash|mjs|cjs|js|ts)$/.test(suffix)) return null;
  const rel = suffix.replace(/^\.\//, "");
  return scriptExists(ctx, rel) ? rel : null;
}

type Invocation = { rel: string } | { dynamic: string };
type ShellToken = { text: string; quoted: boolean };

/**
 * Split one shell line into words, keeping quoted spans whole and honoring
 * backslash escapes and $(...)/backtick substitutions. Text inside a quote is
 * never emitted as a separate word, so prose such as an echo argument cannot
 * look like a command invocation.
 */
function shellTokens(line: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === "#") break; // A comment starts only at a word boundary.
    if (/[;&|(){}]/.test(char)) {
      tokens.push({ text: char, quoted: false });
      index++;
      continue;
    }
    let text = "";
    let quoted = false;
    while (index < line.length) {
      const next = line[index];
      if (/\s/.test(next) || /[;&|(){}]/.test(next)) break;
      if (next === "\\") {
        text += next;
        index++;
        if (index < line.length) text += line[index++];
        continue;
      }
      if (next === "'" || next === '"') {
        const quote = next;
        quoted = true;
        text += quote;
        index++;
        while (index < line.length) {
          const inner = line[index];
          if (inner === "\\" && quote === '"') {
            text += inner;
            index++;
            if (index < line.length) text += line[index++];
            continue;
          }
          text += inner;
          index++;
          if (inner === quote) break;
        }
        continue;
      }
      if (next === "$" && line[index + 1] === "(") {
        text += next;
        index++;
        let depth = 0;
        while (index < line.length) {
          const inner = line[index++];
          text += inner;
          if (inner === "(") depth++;
          else if (inner === ")" && --depth === 0) break;
        }
        continue;
      }
      if (next === "$" && line[index + 1] === "{") {
        text += next;
        index++;
        let depth = 0;
        while (index < line.length) {
          const inner = line[index++];
          text += inner;
          if (inner === "{") depth++;
          else if (inner === "}" && --depth === 0) break;
        }
        continue;
      }
      if (next === "`") {
        text += next;
        index++;
        while (index < line.length) {
          const inner = line[index++];
          text += inner;
          if (inner === "`") break;
        }
        continue;
      }
      text += next;
      index++;
    }
    tokens.push({ text, quoted });
  }
  return tokens;
}

function isCommandPosition(tokens: ShellToken[], index: number): boolean {
  if (index === 0) return true;
  const previous = tokens[index - 1].text;
  if (/^(?:;|&|\||\(|\)|\{|\})$/.test(previous)) return true;
  return previous === "then" || previous === "do" || previous === "else";
}

/** Literal and computed repository-script invocations written in one shell line. */
function invocationsIn(line: string, found: Invocation[] = [], seen = new Set<string>()): Invocation[] {
  const add = (rel: string) => {
    const normalized = rel.replace(/^\.\//, "");
    if (seen.has(normalized)) return;
    seen.add(normalized);
    found.push({ rel: normalized });
  };
  const tokens = shellTokens(line);
  const scriptFile = new RegExp(String.raw`^${SCRIPT_FILE}$`);
  const isCommandWord = (token: ShellToken) => !token.quoted && /^(?:bash|sh|node|bun)$/.test(token.text);
  const isScriptWord = (token: ShellToken | undefined) => token !== undefined && !token.quoted && scriptFile.test(token.text);
  for (const [index, token] of tokens.entries()) {
    if (isCommandWord(token)) {
      const argument = tokens[index + 1];
      if (argument === undefined || /^[;&|(){}]$/.test(argument.text)) continue;
      if (/[$`]/.test(argument.text)) {
        if (!isCommandPosition(tokens, index)) continue;
        const key = `dynamic\0${argument.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ dynamic: argument.text });
        }
      } else if (isScriptWord(argument)) {
        add(argument.text);
      }
      continue;
    }
    if (!isCommandPosition(tokens, index)) continue;
    if (!token.quoted && (token.text === "source" || token.text === ".")) {
      const argument = tokens[index + 1];
      if (isScriptWord(argument)) add(argument.text);
      continue;
    }
    if (!token.quoted && token.text.startsWith("./") && scriptFile.test(token.text)) {
      add(token.text);
      continue;
    }
    if ((token.quoted || /^\$/.test(token.text)) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)) {
      const argument = tokens[index + 1];
      if (argument !== undefined && !argument.quoted &&
          /^(?:\.\/|scripts\/|\.github\/scripts\/)/.test(argument.text) && scriptFile.test(argument.text)) {
        add(argument.text);
      }
    }
  }
  return found;
}

/** Remove C-style comments from a JavaScript/TypeScript body, preserving line numbers. */
function stripCStyleComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      out += char;
      index++;
      while (index < text.length) {
        const inner = text[index];
        if (inner === "\\") {
          out += inner;
          index++;
          if (index < text.length) out += text[index++];
          continue;
        }
        out += inner;
        index++;
        if (inner === quote) break;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        out += " ";
        index++;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      out += "  ";
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        out += text[index] === "\n" ? "\n" : " ";
        index++;
      }
      if (index < text.length) {
        out += "  ";
        index += 2;
      }
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

function addFollowed(ctx: TreeContext, rel: string) {
  if (!ctx.followed.includes(rel)) ctx.followed.push(rel);
}

function followScript(ctx: TreeContext, rel: string, cwd: string, label: string, chain: string[]) {
  if (ctx.visiting.has(rel)) return;
  if (!scriptExists(ctx, rel)) return;
  addFollowed(ctx, rel);
  const content = readFileSync(join(ctx.root, rel), "utf8");
  ctx.visiting.add(rel);
  try {
    scanScript(ctx, rel, content, cwd, label, [...chain, rel]);
  } finally {
    ctx.visiting.delete(rel);
  }
}

function scanScript(ctx: TreeContext, rel: string, content: string, cwd: string, label: string, chain: string[]) {
  const pathText = chain.join(" -> ");
  const shellScript = isShellScript(rel, content);
  const scanText = shellScript ? content : stripCStyleComments(content);
  let directory = resolveRepoDir("", cwd, `${label}: script ${rel}`);
  let directoryUnresolved = false;
  let staged = false;
  for (const entry of shellLines(scanText)) {
    const line = entry.text;
    const at = `${label}: script ${rel} (invocation ${pathText}, line ${entry.line})`;
    if (shellScript) {
      const cd = line.match(/^(?:\(\s*)?cd\s+(.+?)(?:\s*&&.*)?$/);
      if (cd !== null) {
        const target = stripOuterQuotes(cd[1].trim());
        if (target === "" || /[$`~*?]/.test(target) || target === "-" || target === "--") {
          directoryUnresolved = true;
        } else {
          directory = resolveRepoDir(directory, target.replace(/^--\s+/, ""), at);
        }
        continue;
      }
      if (/^(?:pushd|popd)\b/.test(line)) directoryUnresolved = true;
      if (/^(?:cp|mv|ln|install|rsync|tee)\s/.test(line) && /(?:package-lock\.json|npm-shrinkwrap\.json)/.test(line)) staged = true;
      if (/^(?:sed\s+-i|perl\s+-i)/.test(line) && /(?:package-lock\.json|npm-shrinkwrap\.json)/.test(line)) staged = true;
      if (/(?:^|[^0-9])>{1,2}\s*[^;&|]*package-lock\.json/.test(line)) staged = true;
      if (/^eval\b/.test(line)) throw new Error(`${at}: eval is refused: ${line}`);
      const source = line.match(/^(?:source|\.)\s+(\S+)/);
      if (source !== null && /[$`]/.test(source[1])) {
        throw new Error(`${at}: source of a computed path is refused: ${line}`);
      }
      if (line.startsWith("bash scripts/npm-ci-tracked-lock.sh") || line.startsWith("bash ./scripts/npm-ci-tracked-lock.sh")) {
        const helper = line.match(HELPER_CALL);
        if (helper === null) throw new Error(`${at}: tracked-lock helper call is not the literal accepted shape: ${line}`);
        const dir = helper[3];
        if (dir.startsWith("/") || dir === "-") throw new Error(`${at}: tracked-lock helper directory is not relative: ${line}`);
        const resolved = resolveRepoDir(directory, dir, at);
        const lockfile = resolved === "" ? "package-lock.json" : `${resolved}/package-lock.json`;
        if (!ctx.tracked.has(lockfile)) throw new Error(`${at}: ${lockfile} is not a tracked lockfile the gate reads: ${line}`);
        ctx.installs++;
        continue;
      }
      const npmCommand = line.match(new RegExp(String.raw`${COMMAND_START}(?:sfw\s+)?npm\b(.*)$`));
      if (npmCommand !== null) {
        const args = npmCommand[1].trim().split(/\s+/).filter(Boolean);
        if (args.some((arg) => INSTALL_VERBS.has(arg))) {
          if (directoryUnresolved) {
            throw new Error(`${at}: cannot bind an npm install after a non-literal directory change: ${line}`);
          }
          if (staged) {
            throw new Error(`${at}: cannot bind an npm install after the script stages or copies a different lockfile before installing: ${line}`);
          }
          if (args.some((arg) => arg === "-g" || arg === "--global" || arg.startsWith("--prefix") || arg === "-C" || arg === "--pref" || arg.startsWith("--location"))) {
            if (isAcceptedGlobalToolInstall(line)) continue;
            throw new Error(`${at}: npm install changes the install directory or is global: ${line}`);
          }
          const lockfile = directory === "" ? "package-lock.json" : `${directory}/package-lock.json`;
          if (!ctx.tracked.has(lockfile)) {
            throw new Error(`${at}: cannot bind the npm install to a tracked lockfile: ${lockfile} is not a lockfile the gate reads: ${line}`);
          }
          ctx.installs++;
          continue;
        }
      }
    }
    for (const invocation of invocationsIn(line)) {
      if ("dynamic" in invocation) {
        const resolved = resolveDynamicSuffix(ctx, invocation.dynamic);
        if (resolved !== null) followScript(ctx, resolved, directory, label, chain);
        else {
          ctx.unresolvedEntries.push({ script: rel, line: entry.line, token: invocation.dynamic });
          ctx.unresolved.push(`${rel} (line ${entry.line}): ${invocation.dynamic}`);
        }
        continue;
      }
      const resolved = resolveRepoDir(directory, invocation.rel, at);
      const fromRoot = resolved === invocation.rel ? null : resolveRepoDir("", invocation.rel, at);
      if (scriptExists(ctx, resolved)) followScript(ctx, resolved, directory, label, chain);
      else if (fromRoot !== null && scriptExists(ctx, fromRoot)) followScript(ctx, fromRoot, directory, label, chain);
      else if (/^(?:\.\/)?(?:scripts|\.github\/scripts)\//.test(invocation.rel)) {
        throw new Error(`${at}: invoked script is not a repository file: ${invocation.rel}`);
      }
    }
  }
}

function scanRunBlock(ctx: TreeContext, run: string, cwd: string, label: string) {
  for (const entry of shellLines(run)) {
    const at = `${label}: ${entry.text} (physical line ${entry.line})`;
    for (const invocation of invocationsIn(entry.text)) {
      if ("dynamic" in invocation) {
        const resolved = resolveDynamicSuffix(ctx, invocation.dynamic);
        if (resolved !== null) followScript(ctx, resolved, cwd, label, []);
        else throw new Error(`${label}: cannot resolve a dynamic script path to one repository file: ${invocation.dynamic} (physical line ${entry.line})`);
        continue;
      }
      const resolved = resolveRepoDir(cwd, invocation.rel, at);
      const fromRoot = resolved === invocation.rel ? null : resolveRepoDir("", invocation.rel, at);
      if (scriptExists(ctx, resolved)) followScript(ctx, resolved, cwd, label, []);
      else if (fromRoot !== null && scriptExists(ctx, fromRoot)) followScript(ctx, fromRoot, cwd, label, []);
      else if (/^(?:\.\/)?(?:scripts|\.github\/scripts)\//.test(invocation.rel)) {
        throw new Error(`${label}: invoked script is not a repository file: ${invocation.rel} (physical line ${entry.line})`);
      }
    }
  }
}

function followAction(ctx: TreeContext, actionPath: string, label: string) {
  const rel = actionPath.replace(/^\.\//, "").replace(/\/$/, "");
  let source: string | null = null;
  for (const name of ["action.yml", "action.yaml"]) {
    try {
      source = readFileSync(join(ctx.root, rel, name), "utf8");
      break;
    } catch {
      // try the other spelling
    }
  }
  if (source === null) throw new Error(`${label}: local action ${rel} has no action.yml or action.yaml`);
  addFollowed(ctx, rel);
  const action = load(source) as { runs?: { steps?: WorkflowStep[] } };
  const steps = action.runs?.steps ?? [];
  for (const [index, step] of steps.entries()) {
    const stepLabel = `${label} action ${rel} step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
    if (step.uses?.startsWith("./")) {
      followAction(ctx, step.uses, stepLabel);
      continue;
    }
    if (step.run === undefined) continue;
    const workdir = step["working-directory"] ?? "";
    const direct = npmCiLockDirs(step.run, workdir, stepLabel);
    ctx.installs += direct;
    scanRunBlock(ctx, step.run, workdir, stepLabel);
  }
}

function unresolvedKey(entry: { script: string; line: number; token: string }): string {
  return `${entry.script}\0${entry.line}\0${entry.token}`;
}

/** Refuse an unresolved invocation the reviewed allowlist does not name, and a stale entry. */
function assertUnresolvedInvocationsKnown(
  ctx: TreeContext,
  allowlist: readonly UnresolvedInvocationAllowlistEntry[],
) {
  const observed = new Map<string, UnresolvedEntry>();
  for (const entry of ctx.unresolvedEntries) observed.set(unresolvedKey(entry), entry);
  const followed = new Set(ctx.followed);
  const stale = allowlist.filter((entry) => followed.has(entry.script) && !observed.has(unresolvedKey(entry)));
  if (stale.length > 0) {
    const entry = stale[0];
    throw new Error(
      `assertNpmCiWorkflowTree: stale UNRESOLVED_INVOCATION_ALLOWLIST entry: ${entry.script} line ${entry.line} no longer holds ${entry.token}`,
    );
  }
  const allowed = new Set(allowlist.map(unresolvedKey));
  for (const entry of observed.values()) {
    if (allowed.has(unresolvedKey(entry))) continue;
    throw new Error(
      `assertNpmCiWorkflowTree: unresolved script invocation in ${entry.script} (line ${entry.line}) token ${entry.token}: not on UNRESOLVED_INVOCATION_ALLOWLIST in test/helpers/npm-ci-workflow-guard.ts; a computed path is refused until reviewed`,
    );
  }
}

/**
 * Scan a workflow, the repository scripts its steps invoke by a literal path
 * (recursively), and the local composite actions it uses. Direct run-line
 * decisions stay with
 * assertNpmCiLockfilesRead; this adds the installs found in followed files.
 */
export function assertNpmCiWorkflowTree(
  source: string,
  tracked: Set<string>,
  repoRoot: string,
  workflowName?: string,
  unresolvedAllowlist: readonly UnresolvedInvocationAllowlistEntry[] = UNRESOLVED_INVOCATION_ALLOWLIST,
): WorkflowTreeReport {
  const ctx: TreeContext = { root: repoRoot, tracked, installs: 0, followed: [], unresolved: [], unresolvedEntries: [], visiting: new Set() };
  ctx.installs += assertNpmCiLockfilesRead(source, tracked, workflowName);
  const workflow = parseWorkflow(source);
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const defaultWorkdir = job.defaults?.run?.["working-directory"] ?? workflow.defaults?.run?.["working-directory"] ?? "";
    for (const [index, step] of job.steps.entries()) {
      const label = `${workflowName === undefined ? "" : `workflow ${workflowName} `}job ${jobName} step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
      if (step.uses?.startsWith("./")) {
        followAction(ctx, step.uses, label);
        continue;
      }
      if (step.run === undefined) continue;
      scanRunBlock(ctx, step.run, step["working-directory"] ?? defaultWorkdir, label);
    }
  }
  assertUnresolvedInvocationsKnown(ctx, unresolvedAllowlist);
  return { installs: ctx.installs, followed: ctx.followed, unresolved: ctx.unresolved };
}
