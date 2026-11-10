import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

type WorkflowStep = { name?: string; run?: string; uses?: string; "working-directory"?: string; env?: Record<string, unknown> };
type WorkflowJob = {
  steps: WorkflowStep[];
  defaults?: { run?: { "working-directory"?: string } };
  env?: Record<string, unknown>;
};

export function parseWorkflow(source: string) {
  return load(source) as { jobs: Record<string, WorkflowJob>; defaults?: WorkflowJob["defaults"]; env?: Record<string, unknown> };
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
  /** Repository file the reviewed token resolves to, or the script that generates it. */
  target: string;
  /** Exact assignment (or here-document header) that creates the target; must appear once. */
  assignment: string;
  /** Repository file whose content is copied into a generated target; scanned like a followed script. */
  source?: string;
  reason: string;
};

/**
 * Computed script paths reviewed by hand because the scan cannot resolve them to
 * one repository file. Keyed by script path, physical line and exact token; the
 * variable's single assignment must equal the pinned text, its target must exist
 * and is followed, and an entry whose line no longer holds that token or
 * assignment is stale and fails the scan.
 */
export const UNRESOLVED_INVOCATION_ALLOWLIST: readonly UnresolvedInvocationAllowlistEntry[] = [
  { script: "scripts/test-promote-latest.sh", line: 367, token: '"$registry_js"', target: "scripts/test-promote-latest.sh", assignment: 'registry_js="$work/registry.js"', reason: "$registry_js is the generated registry fixture written by this script (no npm install)" },
  { script: "scripts/test-promote-latest.sh", line: 765, token: '"$work/mkstate.mjs"', target: "scripts/test-promote-latest.sh", assignment: "cat >\"$work/mkstate.mjs\" <<'MK'", reason: "$work/mkstate.mjs is the generated fixture writer written by this script (no npm install)" },
  { script: "scripts/test-promote-latest.sh", line: 767, token: '"$work/latest.mjs"', target: "scripts/test-promote-latest.sh", assignment: "cat >\"$work/latest.mjs\" <<'LM'", reason: "$work/latest.mjs is the generated fixture reader written by this script (no npm install)" },
  { script: "scripts/reviewer/image-checks.sh", line: 434, token: "-c", target: "scripts/reviewer/image-checks.sh", assignment: `gitcreds="$(docker run --rm "$IMG" sh -c 'git config --list --show-origin 2>/dev/null | grep -iE "credential|extraheader|authorization|://[^/@[:space:]]+@"' 2>/dev/null)"`, reason: "reads the image's git config in a container; the payload runs no npm install" },
  { script: "scripts/reviewer/per-job-isolation-checks.sh", line: 170, token: '"$HOSTMOD/scripts/reviewer/evidence-harness.mjs"', target: "scripts/reviewer/per-job-isolation-checks.sh", assignment: "cat >\"$HOSTMOD/scripts/reviewer/evidence-harness.mjs\" <<'JS'", reason: "$HOSTMOD is the scratch host module generated by this test (no npm install)" },
  { script: "scripts/test-tps-office-supervisor.sh", line: 142, token: "-c", target: "scripts/test-tps-office-supervisor.sh", assignment: 'part_c_gate_output="$(su -s /bin/bash nobody -c "TPS_TEST_REQUIRE_NONO=1 TPS_TEST_NONROOT_GATE_FIXTURE=1 bash \'$repo_root/scripts/test-tps-office-supervisor.sh\'" 2>&1)"', reason: "runs this test script again as an unprivileged user (no npm install)" },
  { script: "scripts/test-tps-office-supervisor.sh", line: 158, token: '"$hook_fixture/startup.sh"', target: "scripts/test-tps-office-supervisor.sh", source: "docker/tps-office-supervisor.sh", assignment: "sed -n '1,/^validate_control_values$/p' \"$sup\" >\"$hook_fixture/startup.sh\"", reason: "generated supervisor slice written by this test (no npm install)" },
  { script: "scripts/test-tps-office-supervisor.sh", line: 166, token: '"$hook_fixture/startup.sh"', target: "scripts/test-tps-office-supervisor.sh", source: "docker/tps-office-supervisor.sh", assignment: "sed -n '1,/^validate_control_values$/p' \"$sup\" >\"$hook_fixture/startup.sh\"", reason: "generated supervisor slice written by this test (no npm install)" },
  { script: "scripts/test-tps-office-supervisor.sh", line: 173, token: '"$hook_fixture/startup.sh"', target: "scripts/test-tps-office-supervisor.sh", source: "docker/tps-office-supervisor.sh", assignment: "sed -n '1,/^validate_control_values$/p' \"$sup\" >\"$hook_fixture/startup.sh\"", reason: "generated supervisor slice written by this test (no npm install)" },
  { script: "scripts/test-tps-office-supervisor.sh", line: 197, token: '"$secret_fixture/startup.sh"', target: "scripts/test-tps-office-supervisor.sh", source: "docker/tps-office-supervisor.sh", assignment: "sed -n '/^SECRETS_DIR=/,/^validate_control_values$/p' \"$sup\" | sed \"s|^SECRETS_DIR=.*|SECRETS_DIR=\\\"$secret_fixture/secrets\\\"|\"", reason: "generated supervisor slice written by this test's group from $sup (no npm install)" },
  { script: "scripts/test-tps-office-supervisor.sh", line: 251, token: '"$shutdown_fixture/run.sh"', target: "scripts/test-tps-office-supervisor.sh", assignment: "cat >\"$shutdown_fixture/run.sh\" <<'RUN'", reason: "$shutdown_fixture/run.sh is the generated supervisor fixture written by this script (no npm install)" },
  { script: "docker/tps-office-supervisor.sh", line: 351, token: "-c", target: "docker/tps-office-supervisor.sh", assignment: 'su -s /bin/bash "$user" -c "echo probe > \'$probe_file\'" >/dev/null 2>&1', reason: "inline landlock probe run as another user; no npm install" },
  { script: "docker/tps-office-supervisor.sh", line: 357, token: "-c", target: "docker/tps-office-supervisor.sh", assignment: 'su -s /bin/bash "$user" -c "exec nono run --profile \\"$NONO_PROFILE\\" --allow \'$workdir\' --allow \'$tmpdir\' -- bash -lc \'cat \\"$probe_file\\" >/dev/null\'" >/dev/null 2>&1', reason: "inline landlock probe run as another user; no npm install" },
  { script: "docker/tps-office-supervisor.sh", line: 359, token: "-c", target: "docker/tps-office-supervisor.sh", assignment: 'su -s /bin/bash "$user" -c "rm -f \'$probe_file\'" >/dev/null 2>&1 || true', reason: "inline probe cleanup run as another user; no npm install" },
  { script: "docker/tps-office-supervisor.sh", line: 487, token: "-c", target: "docker/tps-office-supervisor.sh", assignment: 'su -m -s /bin/bash "$user" -c "HOME=\'$AGENT_HOME\' exec nono ${launch_args[*]} -- tps-agent start --id \'$id\' --config \'$config_path\'" &', reason: "inline agent launch run as another user; no npm install" },
];

/** Exact non-install shell lines the install classifier flags (help or fixture text), reviewed by hand. */
export type ReviewedScriptLineEntry = { script: string; line: number; text: string; reason: string };

export const REVIEWED_SCRIPT_LINE_ALLOWLIST: readonly ReviewedScriptLineEntry[] = [
  { script: "scripts/reviewer/image-checks.sh", line: 380, text: "for kv in HOME=/tmp/review/home TMPDIR=/tmp/review/tmp XDG_CACHE_HOME=/tmp/review/cache XDG_CONFIG_HOME=/tmp/review/config       npm_config_cache=/tmp/review/cache/npm BUN_INSTALL_CACHE_DIR=/tmp/review/cache/bun CI=true       home_fs=tmpfs tmp_fs=tmpfs cache_fs=tmpfs writable=yes; do", reason: "loop over environment assignments; npm_config_cache and CI are variables, not an install" },
  { script: "scripts/test-promote-latest.sh", line: 476, text: "fail('npm error code E401\\nnpm error fake npm: rollback add refused');", reason: "assertion fixture string; no command is run" },
  { script: "scripts/test-promote-latest.sh", line: 1256, text: "assert_contains \"AD add-timeout: command and bound\" \"$ERR\" \"timed out after 1 seconds: npm dist-tag add @tpsdev-ai/cli-linux-arm64@0.5.4\"", reason: "assertion fixture string; no command is run" },
  { script: "scripts/test-promote-latest.sh", line: 1389, text: "assert_contains \"AJ real npm PUT hang: timed out\" \"$ERR\" \"timed out after 1 seconds: npm dist-tag add @tpsdev-ai/cli-darwin-arm64@0.5.4\"", reason: "assertion fixture string; no command is run" },
];

/**
 * Exact run-block logical lines whose wrapped interpreter payload is a
 * non-literal string. The line is reviewed as a whole; its payload is not
 * parsed, so a wrapped interpreter anywhere else is refused.
 */
export type ReviewedWrappedPayloadEntry = { text: string; reason: string };

export const REVIEWED_WRAPPED_PAYLOAD_ALLOWLIST: readonly ReviewedWrappedPayloadEntry[] = [
  {
    text: "docker run --rm -v \"$HOME/.local/nono-pin-bookworm:/out\" -e COMMIT=\"${{ steps.pin.outputs.commit }}\" rust:bookworm bash -c '",
    reason: "builds the pinned nono in a bookworm container: the payload installs distro packages and builds Rust, and runs no npm or npx",
  },
];

type UnresolvedEntry = { script: string; line: number; token: string; label: string; chain: string[] };

type TreeContext = {
  root: string;
  tracked: Set<string>;
  installs: number;
  followed: string[];
  unresolved: string[];
  unresolvedEntries: UnresolvedEntry[];
  reviewedLines: string[];
  visiting: Set<string>;
  visitingActions: Set<string>;
  /** Workflow, job and step env names that reach each followed script. */
  scriptEnv: Map<string, Set<string>>;
  /** Env names on the current workflow/action step path. */
  envNames: Set<string>;
};

const SCRIPT_FILE = String.raw`(?:\.\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:sh|bash|mjs|cjs|js|ts)`;
const PREFIX_COMMANDS = new Set(["env", "command", "exec", "sudo", "xargs", "nohup", "time"]);
const SHELL_KEYWORDS = new Set(["then", "elif", "else", "do", "!"]);
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const JS_INTERPRETERS = new Set(["node", "bun", "deno", "tsx"]);
const INTERPRETERS = new Set([...SHELL_INTERPRETERS, ...JS_INTERPRETERS]);
const SCRIPT_EXTENSION = /\.(?:sh|bash|mjs|cjs|js|ts)$/;
const INSTALL_VERB = /(?:^|[^A-Za-z0-9_-])(?:ci|install|i|add|exec|x)(?![A-Za-z0-9_-])/;
const BUN_SUBCOMMANDS = new Set(["run", "test", "install", "i", "add", "remove", "rm", "update", "audit", "build", "x", "pm", "link", "unlink", "publish", "init", "create", "upgrade", "repl", "exec", "outdated", "why", "patch", "prune"]);
const DENO_SUBCOMMANDS = new Set(["run", "test", "task", "install", "cache", "check", "lint", "fmt", "bench", "doc", "info", "eval", "repl", "publish", "compile", "coverage"]);
const VERSION_FLAGS = new Set(["--version", "-v", "--help", "-h", "--revision"]);
const EMBEDDED_WRAPPERS = new Set(["docker", "su", "setsid", "timeout", "nice", "chroot", "stdbuf"]);

function stripOuterQuotes(value: string): string {
  if (value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** The literal word a token spells once quotes are dropped and escapes removed. */
function literalWord(text: string): string {
  return text.replace(/\\(.)/g, "$1").replace(/['"]/g, "");
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
function resolveDynamicSuffix(ctx: TreeContext, token: string, bases: string[] = []): string | null {
  const value = stripOuterQuotes(token);
  const variable = value.match(/^\$(?:\{?[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?(?:[%#][^}]*)?\}?|\([^)]*\)|`[^`]*`)/);
  if (variable === null) return null;
  let suffix = value.slice(variable[0].length);
  if (suffix.startsWith("/")) suffix = suffix.slice(1);
  if (suffix === "" || !SCRIPT_EXTENSION.test(suffix)) return null;
  const rel = suffix.replace(/^\.\//, "");
  for (const base of ["", ...bases]) {
    const candidate = base === "" ? rel : resolveRepoDir(base, rel, "dynamic suffix");
    if (scriptExists(ctx, candidate)) return candidate;
  }
  return null;
}

type Invocation = { rel: string } | { dynamic: string; cwdUnknown?: true; missing?: true };
type ShellToken = { text: string; quoted: boolean };
type LogicalLine = { text: string; line: number; body: boolean };
type Clause = { tokens: ShellToken[]; piped: boolean };

/** Split a line into words, keeping quoted spans whole and honoring escapes and substitutions. */
function shellTokens(line: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === "#") break;
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

/** Strip a word-boundary comment, preserving `#` inside quoted spans and URLs. */
function stripWordBoundaryComment(line: string): string {
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "\\" && quote !== "'") {
      index++;
      continue;
    }
    if (quote === "") {
      if (char === "'" || char === '"') quote = char;
      else if (char === "#" && (index === 0 || /\s|[;&|(){}]/.test(line[index - 1]))) return line.slice(0, index);
    } else if (char === quote) quote = "";
  }
  return line;
}

/**
 * Physical-line positions that begin inside a multi-line quote. Command scanning
 * skips these lines: they are string data, not shell words.
 */
function quoteStartMask(raw: string[]): boolean[] {
  const mask: boolean[] = [];
  let quote = "";
  let delimiter: string | null = null;
  let stripTabs = false;
  for (const rawLine of raw) {
    const physical = rawLine.replace(/\r$/, "");
    if (delimiter !== null) {
      const candidate = stripTabs ? physical.replace(/^\t+/, "") : physical;
      mask.push(true);
      if (candidate === delimiter) delimiter = null;
      continue;
    }
    mask.push(quote !== "");
    const line = quote === "" ? stripWordBoundaryComment(physical) : physical;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (quote === "") {
        if (char === "\\") {
          index++;
          continue;
        }
        if (char === "'" || char === '"') quote = char;
      } else if (char === "\\" && quote === '"') {
        index++;
      } else if (char === quote) quote = "";
    }
    if (quote === "") {
      // Unknown => refuse: a here-document header is matched after the comment
      // is stripped, so `# <<EOF` prose cannot swallow the lines below it.
      const heredoc = line.match(/<<(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
      if (heredoc !== null) {
        delimiter = heredoc[3];
        stripTabs = heredoc[1] === "-";
      }
    }
  }
  return mask;
}

/**
 * Join continuations, strip word-boundary comments and mark here-document body
 * lines. Bodies are kept for the install classifier (a heredoc fed to a shell
 * runs its text); command scanning ignores body lines.
 */
function logicalShellLines(text: string): LogicalLine[] {
  const raw = text.split("\n");
  const mask = quoteStartMask(raw);
  const lines: LogicalLine[] = [];
  let buffer = "";
  let start = 0;
  let delimiter: string | null = null;
  let stripTabs = false;
  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed !== "") lines.push({ text: trimmed, line: start, body: false });
    buffer = "";
  };
  for (let index = 0; index < raw.length; index++) {
    const physical = raw[index].replace(/\r$/, "");
    if (delimiter !== null) {
      const candidate = stripTabs ? physical.replace(/^\t+/, "") : physical;
      if (candidate === delimiter) {
        delimiter = null;
        continue;
      }
      const trimmed = physical.trim();
      if (trimmed !== "") lines.push({ text: trimmed, line: index + 1, body: true });
      continue;
    }
    if (mask[index]) {
      buffer = "";
      continue;
    }
    const line = stripWordBoundaryComment(physical);
    if (buffer === "") start = index + 1;
    if (/\\$/.test(line)) {
      buffer += line.slice(0, -1);
      continue;
    }
    buffer += line;
    flush();
    const heredoc = line.match(/<<(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (heredoc !== null) {
      delimiter = heredoc[3];
      stripTabs = heredoc[1] === "-";
    }
  }
  flush();
  return lines;
}

function splitClauses(line: string): Clause[] {
  const clauses: Clause[] = [];
  let current: ShellToken[] = [];
  let piped = false;
  let nextPiped = false;
  for (const token of shellTokens(line)) {
    if (/^(?:;|&|\||\(|\)|\{|\})$/.test(token.text)) {
      if (current.length > 0) clauses.push({ tokens: current, piped });
      current = [];
      piped = nextPiped;
      nextPiped = token.text === "|";
    } else current.push(token);
  }
  if (current.length > 0) clauses.push({ tokens: current, piped });
  return clauses;
}

/** Skip VAR=val assignments and env/command/exec/sudo/xargs/nohup/time prefixes. */
function commandWord(tokens: ShellToken[]): { index: number; token: ShellToken } | null {
  let index = 0;
  let sawPrefix = false;
  while (index < tokens.length) {
    const token = tokens[index];
    const text = stripOuterQuotes(token.text);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)) {
      index++;
      continue;
    }
    if (!token.quoted && (PREFIX_COMMANDS.has(text) || SHELL_KEYWORDS.has(text))) {
      sawPrefix = sawPrefix || PREFIX_COMMANDS.has(text);
      index++;
      continue;
    }
    if (sawPrefix && !token.quoted && text.startsWith("-") && text !== "-") {
      index++;
      continue;
    }
    return { index, token };
  }
  return null;
}

function firstNonFlag(tokens: ShellToken[]): ShellToken | undefined {
  for (const token of tokens) {
    const text = stripOuterQuotes(token.text);
    if (!token.quoted && text.startsWith("-") && text !== "-") continue;
    if (!token.quoted && /^(?:\d*)?[<>]/.test(text)) continue;
    return token;
  }
  return undefined;
}

type SpanMatch = { end: number } | { unparsed: string };

/**
 * One backtick command substitution starting at `start`: its closing backtick,
 * with `\`` and `\\` escaped and `$(...)` spans skipped. A span with no
 * reliable close is returned as unparsed, never guessed.
 */
function backtickSpan(line: string, start: number): SpanMatch {
  let index = start + 1;
  while (index < line.length) {
    const char = line[index];
    if (char === "\\") {
      if (index + 1 >= line.length) return { unparsed: line.slice(start) };
      index += 2;
      continue;
    }
    if (char === "$" && line[index + 1] === "(") {
      const inner = parenSpan(line, index + 1);
      if (inner === null) return { unparsed: line.slice(start) };
      if ("unparsed" in inner) return inner;
      index = inner.end + 1;
      continue;
    }
    if (char === "`") return { end: index };
    index++;
  }
  return { unparsed: line.slice(start) };
}

/** One `$(...)` span starting at its `(`, skipping backtick spans inside it. */
function parenSpan(line: string, open: number): SpanMatch | null {
  let depth = 0;
  let quote = "";
  for (let index = open; index < line.length; index++) {
    const char = line[index];
    if (quote !== "") {
      if (char === "\\" && quote === '"') {
        index++;
        continue;
      }
      if (char === "`" && quote === '"') {
        const inner = backtickSpan(line, index);
        if ("unparsed" in inner) return inner;
        index = inner.end;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`") {
      const inner = backtickSpan(line, index);
      if ("unparsed" in inner) return inner;
      index = inner.end;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return { end: index };
    }
  }
  return null;
}

/** Positions inside a single-quoted span, where a backtick is literal. */
function singleQuoteMask(line: string): boolean[] {
  const mask: boolean[] = [];
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    mask.push(quote === "'");
    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }
    if (char === "\\") {
      index++;
      if (index < line.length) mask.push(false);
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      continue;
    }
    if (char === "'" || char === '"') quote = char;
  }
  return mask;
}

/**
 * Outermost command substitution bodies in one line: `$(...)` and backtick
 * spans, each returned once; nested bodies are left to the recursive scan of the
 * body. A backtick span with no reliable close is returned as unparsed so the
 * caller can refuse it.
 */
function commandSubstitutions(line: string): { bodies: string[]; unparsed: string[] } {
  const bodies: string[] = [];
  const unparsed: string[] = [];
  const singleQuoted = singleQuoteMask(line);
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "$" && line[index + 1] === "(") {
      const match = parenSpan(line, index + 1);
      if (match === null) continue;
      if ("unparsed" in match) {
        unparsed.push(match.unparsed);
        break;
      }
      bodies.push(line.slice(index + 2, match.end));
      index = match.end;
      continue;
    }
    if (char === "`" && !singleQuoted[index]) {
      const match = backtickSpan(line, index);
      if ("unparsed" in match) {
        unparsed.push(match.unparsed);
        break;
      }
      // Inside backticks, `\`` becomes a nested delimiter and `\\` a backslash.
      bodies.push(line.slice(index + 1, match.end).replace(/\\([$`\\])/g, "$1"));
      index = match.end;
    }
  }
  return { bodies, unparsed };
}

function pushUnresolved(ctx: TreeContext, rel: string, line: number, token: string, label: string, chain: string[]) {
  const entry = { script: rel, line, token, label, chain };
  const key = `${rel}\0${line}\0${token}`;
  if (ctx.unresolvedEntries.some((existing) => `${existing.script}\0${existing.line}\0${existing.token}` === key)) return;
  ctx.unresolvedEntries.push(entry);
  ctx.unresolved.push(`${rel} (line ${line}): ${token}`);
}

type VariableBinding = { text: string; value: string };

const ASSIGNMENT_PREFIXES = new Set(["export", "local", "readonly", "declare", "typeset"]);
const ENV_OVERRIDABLE = /\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=]/;

function assignmentToken(text: string): { name: string; value: string } | null {
  const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/s);
  return match === null ? null : { name: match[1], value: match[2] };
}

/** Variable bindings in one shell script: assignments with their prefixes, read/mapfile, and for-loop names. */
function collectBindings(content: string): Map<string, VariableBinding[]> {
  const bindings = new Map<string, VariableBinding[]>();
  const add = (name: string, text: string, value: string) => {
    const list = bindings.get(name) ?? [];
    list.push({ text, value });
    bindings.set(name, list);
  };
  for (const entry of logicalShellLines(content)) {
    if (entry.body) continue;
    for (const clause of splitClauses(entry.text)) {
      const tokens = clause.tokens;
      let index = 0;
      let sawPrefix = false;
      while (index < tokens.length) {
        const token = tokens[index];
        const text = stripOuterQuotes(token.text);
        const assignment = assignmentToken(token.text);
        if (assignment !== null) {
          add(assignment.name, text, assignment.value);
          index++;
          continue;
        }
        if (!token.quoted && ASSIGNMENT_PREFIXES.has(text)) {
          sawPrefix = true;
          index++;
          continue;
        }
        if (sawPrefix && !token.quoted && text.startsWith("-")) {
          index++;
          continue;
        }
        if (sawPrefix && !token.quoted && /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
          add(text, token.text, "");
          index++;
          continue;
        }
        break;
      }
      for (let at = 0; at < tokens.length; at++) {
        if (tokens[at].quoted) continue;
        const text = stripOuterQuotes(tokens[at].text);
        if (/^(?:read|mapfile|readarray)$/.test(text)) {
          for (let argument = at + 1; argument < tokens.length; argument++) {
            const name = stripOuterQuotes(tokens[argument].text);
            if (name.startsWith("-")) {
              if (/^-(?:p|d|n|t|u|a|N|i)$/.test(name)) argument++;
              continue;
            }
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) add(name, tokens[argument].text, "");
          }
        }
        if (text === "for" && tokens[at + 1] !== undefined) {
          const name = stripOuterQuotes(tokens[at + 1].text);
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) add(name, tokens[at + 1].text, "");
        }
      }
    }
  }
  return bindings;
}

/** The repo directory a `$(dirname "$0")`/`$here` expression names, or null. */
function scriptDirBase(
  value: string,
  scriptDir: string,
  bindings: Map<string, VariableBinding[]>,
  seen = new Set<string>(),
): string | null {
  const raw = stripOuterQuotes(value.trim());
  if (!/[$`]/.test(raw)) return null;
  const cd = raw.match(/^\$\(\s*cd\s+"(.*)"\s*&&\s*pwd\s*\)$/);
  const path = cd === null ? null : cd[1];
  if (path !== null) {
    const alias = path.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(\/.*)?$/);
    if (alias !== null) {
      const name = alias[1];
      if (seen.has(name)) return null;
      const list = bindings.get(name) ?? [];
      if (list.length !== 1) return null;
      const base = scriptDirBase(list[0].value, scriptDir, bindings, new Set([...seen, name]));
      return base === null ? null : resolveRepoDir(base, alias[2] ?? "", "script dir");
    }
    const dirname = path.match(/^\$\(dirname\s+(?:"\$0"|"\$\{?BASH_SOURCE(?:\[0\])?\}?")\s*\)(.*)$/);
    if (dirname !== null && !/[$`]/.test(dirname[1])) return resolveRepoDir(scriptDir, dirname[1], "script dir");
    return null;
  }
  const direct = raw.match(/^\$\(dirname\s+(?:"\$0"|"\$\{?BASH_SOURCE(?:\[0\])?\}?")\s*\)(.*)$/);
  if (direct !== null && !/[$`]/.test(direct[1])) return resolveRepoDir(scriptDir, direct[1], "script dir");
  const alias = raw.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(\/.*)?$/);
  if (alias !== null) {
    const name = alias[1];
    if (seen.has(name)) return null;
    const list = bindings.get(name) ?? [];
    if (list.length !== 1) return null;
    const base = scriptDirBase(list[0].value, scriptDir, bindings, new Set([...seen, name]));
    return base === null ? null : resolveRepoDir(base, alias[2] ?? "", "script dir");
  }
  return null;
}

function tokenVariableName(token: string): string | null {
  const value = stripOuterQuotes(token);
  const match = value.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(?:\/|$)/);
  return match === null ? null : (match[1] ?? match[2]);
}

function tokenVariableSuffix(token: string): string {
  const value = stripOuterQuotes(token);
  const match = value.match(/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)(.*)$/s);
  return match === null ? "" : match[1];
}

function joinVariableSuffix(base: string, suffix: string): string {
  const tail = suffix.replace(/^\//, "");
  if (tail === "") return base;
  return base === "" ? tail : `${base}/${tail}`;
}

type ResolvedAssignment = { kind: "scriptDir" | "cwd" | "absolute"; path: string };

/**
 * Resolve a variable whose script binds it exactly once to a literal path, or to
 * a path relative to the script's own directory. Anything else is unresolved.
 */
function resolveAssignmentReference(
  name: string,
  bindings: Map<string, VariableBinding[]>,
  scriptDir: string,
): ResolvedAssignment | null {
  const list = bindings.get(name) ?? [];
  if (list.length !== 1) return null;
  const raw = stripOuterQuotes(list[0].value.trim());
  if (raw === "" || ENV_OVERRIDABLE.test(raw)) return null;
  const scriptDirPath = scriptDirBase(raw, scriptDir, bindings);
  if (scriptDirPath !== null) return { kind: "scriptDir", path: scriptDirPath };
  if (raw.startsWith("/")) return /[$`]/.test(raw) ? null : { kind: "absolute", path: raw };
  if (/[$`~*?]/.test(raw)) return null;
  return { kind: "cwd", path: raw };
}

function repoRelativePath(ctx: TreeContext, value: string): string | null {
  const normalized = value.replace(/\/+$/, "");
  if (normalized === ctx.root) return "";
  if (!normalized.startsWith(`${ctx.root}/`)) return null;
  const rel = normalized.slice(ctx.root.length + 1);
  return rel === "" || rel.split("/").some((segment) => segment === "..") ? null : rel;
}

/**
 * How a cd target anchors: `absolute` (a repository path spelled in full),
 * `scriptDir` (the followed script's own directory, or a path derived from it)
 * or `cwd` (relative to the directory the script is in at that point).
 */
type CdTarget = { kind: "absolute" | "scriptDir" | "cwd"; path: string };

/**
 * A cd target that resolves to a repository directory, with the kind of anchor
 * it used. `null` means the target cannot be resolved, so the cwd is unknown.
 * A literal relative target is `cwd`-anchored; a literal absolute target inside
 * the repository is `absolute`; a target anchored to the script directory or to
 * `git rev-parse --show-toplevel` is `absolute`/`scriptDir`. An absolute target
 * outside the repository is unknown, never a repository-relative path.
 */
function resolveCdTarget(
  ctx: TreeContext,
  target: string,
  directory: string,
  scriptDir: string,
  bindings: Map<string, VariableBinding[]> | undefined,
  at: string,
): CdTarget | null {
  if (target === "" || target === "-" || target === "--" || /[~*?]/.test(target)) return null;
  const toplevel = target.match(/^\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)(.*)$/s);
  if (toplevel !== null) {
    const suffix = toplevel[1];
    if (/[$`]/.test(suffix)) return null;
    const rel = joinVariableSuffix("", suffix);
    const path = rel === "" ? "" : resolveRepoDir("", rel, at);
    return path.startsWith("..") ? null : { kind: "absolute", path };
  }
  if (!/[$`]/.test(target)) {
    if (target.startsWith("/")) {
      const rel = repoRelativePath(ctx, target);
      return rel === null ? null : { kind: "absolute", path: rel };
    }
    return { kind: "cwd", path: resolveRepoDir(directory, target, at) };
  }
  if (bindings === undefined) return null;
  const name = tokenVariableName(target);
  if (name === null) return null;
  const suffix = tokenVariableSuffix(target);
  if (/[$`]/.test(suffix)) return null;
  const resolved = resolveAssignmentReference(name, bindings, scriptDir);
  if (resolved === null) return null;
  if (resolved.kind === "scriptDir") {
    return { kind: "scriptDir", path: joinVariableSuffix(resolved.path, suffix) };
  }
  if (resolved.kind === "absolute") {
    const rel = repoRelativePath(ctx, joinVariableSuffix(resolved.path, suffix));
    return rel === null ? null : { kind: "absolute", path: rel };
  }
  return { kind: "cwd", path: resolveRepoDir(directory, joinVariableSuffix(resolved.path, suffix), at) };
}

function resolveScriptArgument(ctx: TreeContext, token: ShellToken, directory: string, at: string, scriptDir = "", rootOnly = false, bindings?: Map<string, VariableBinding[]>): Invocation {
  const value = stripOuterQuotes(token.text);
  if (/[$`]/.test(value)) {
    const name = tokenVariableName(token.text);
    if (name !== null && bindings !== undefined && bindings.has(name)) {
      const resolved = resolveAssignmentReference(name, bindings, scriptDir);
      const suffix = tokenVariableSuffix(token.text);
      if (resolved === null || /[$`]/.test(suffix)) return { dynamic: token.text };
      if (resolved.kind === "scriptDir") {
        const path = joinVariableSuffix(resolved.path, suffix);
        return scriptExists(ctx, path) ? { rel: path } : { dynamic: token.text };
      }
      if (resolved.kind === "absolute") {
        const rel = repoRelativePath(ctx, joinVariableSuffix(resolved.path, suffix));
        return rel !== null && scriptExists(ctx, rel) ? { rel } : { dynamic: token.text };
      }
      if (rootOnly) return { dynamic: token.text };
      const rel = resolveRepoDir(directory, joinVariableSuffix(resolved.path, suffix), at);
      return scriptExists(ctx, rel) ? { rel } : { dynamic: token.text };
    }
    const bases = rootOnly ? [scriptDir] : scriptDir === "" ? [directory] : [scriptDir, directory];
    const resolved = resolveDynamicSuffix(ctx, token.text, bases);
    return resolved !== null ? { rel: resolved } : { dynamic: token.text };
  }
  if (value === "" || value === "-") return { dynamic: token.text };
  if (value.startsWith("/")) {
    const rel = repoRelativePath(ctx, value);
    if (rel !== null && scriptExists(ctx, rel)) return { rel };
    return { dynamic: token.text };
  }
  if (rootOnly) return { dynamic: token.text };
  {
    const resolved = resolveRepoDir(directory, value, at);
    if (scriptExists(ctx, resolved)) return { rel: resolved };
  }
  const fromRoot = resolveRepoDir("", value, at);
  if (scriptExists(ctx, fromRoot)) return { rel: fromRoot };
  return { dynamic: token.text };
}

type InvocationSource = "run-block" | "followed-script";

/** Where one shell unit starts: directory, unknown flag, message label and invocation path. */
type ShellOrigin = { cwd: string; cwdUnknown: boolean; label: string; chain: string[] };

/** One shell text being scanned, plus how its invocations and installs are judged. */
type ShellState = ShellOrigin & {
  /** Repository file being scanned; empty for a workflow or action run block. */
  file: string;
  /** The scanned file's own directory, the anchor for a script-directory path. */
  scriptDir: string;
  bindings?: Map<string, VariableBinding[]>;
  source: InvocationSource;
  /** A run block's own install lines stay with rule 1; a followed file's are judged here. */
  classifyInstalls: boolean;
  rule1Exempt: boolean;
  staged: boolean;
  /** Physical line reported for every invocation inside a command substitution. */
  lineOverride?: number;
  /** Command-substitution nesting depth. */
  depth: number;
};

function scanAt(state: ShellState): string {
  if (state.source === "run-block") return state.label;
  return `${state.label}: script ${state.file} (invocation ${state.chain.join(" -> ")})`;
}

function lineAt(state: ShellState, line: number): string {
  return `${scanAt(state)}, line ${line}`;
}

/**
 * Resolve one script argument against the scan state. A target that needs the
 * cwd and finds it unknown is marked, so every caller refuses it; an absolute
 * or script-directory anchor still resolves.
 */
function resolveInvocation(
  ctx: TreeContext,
  state: ShellState,
  token: ShellToken,
  at: string,
): Invocation {
  const result = resolveScriptArgument(ctx, token, state.cwd, at, state.scriptDir, state.cwdUnknown, state.bindings);
  if ("rel" in result) return result;
  const value = stripOuterQuotes(token.text);
  if (state.cwdUnknown && !value.startsWith("/")) return { dynamic: token.text, cwdUnknown: true };
  if (state.source === "run-block" && !/[$`]/.test(value) && !value.startsWith("/") && (SCRIPT_EXTENSION.test(value) || value.includes("/"))) {
    return { dynamic: value, missing: true };
  }
  return { dynamic: token.text };
}

type DynamicInvocation = { dynamic: string; cwdUnknown?: true; missing?: true };

/**
 * Refuse a script the scan cannot follow: a run block throws, a followed file
 * records the token for the unresolved-invocation allowlist.
 */
function refuseInvocation(
  ctx: TreeContext,
  state: ShellState,
  invocation: DynamicInvocation,
  entryText: string,
  number: number,
): void {
  if (state.source === "followed-script") {
    pushUnresolved(ctx, state.file, number, invocation.dynamic, state.label, state.chain);
    return;
  }
  if (invocation.cwdUnknown === true) {
    throw new Error(
      `${state.label}: cannot resolve a script invocation after a non-literal directory change: ${entryText} (physical line ${number})`,
    );
  }
  if (invocation.missing === true) {
    throw new Error(`${state.label}: invoked script is not a repository file: ${invocation.dynamic} (physical line ${number})`);
  }
  throw new Error(
    `${state.label}: cannot resolve a dynamic script path to one repository file: ${invocation.dynamic} (physical line ${number})`,
  );
}

function followInvocation(
  ctx: TreeContext,
  state: ShellState,
  invocation: Invocation,
  entryText: string,
  number: number,
): void {
  if ("rel" in invocation) {
    followScript(ctx, invocation.rel, { cwd: state.cwd, cwdUnknown: state.cwdUnknown, label: state.label, chain: state.chain });
    return;
  }
  refuseInvocation(ctx, state, invocation, entryText, number);
}

type ClauseInvocation = { invocation: Invocation; embedded: boolean };

/**
 * The script invocations one clause names: its command word (interpreter,
 * source, script file) and any interpreter wrapped in a known wrapper.
 */
function clauseInvocations(
  ctx: TreeContext,
  state: ShellState,
  clause: Clause,
  entryText: string,
  number: number,
): ClauseInvocation[] {
  const at = state.source === "run-block" ? `${state.label}: ${entryText}` : lineAt(state, number);
  const found: ClauseInvocation[] = [];
  const embedded = (): ClauseInvocation[] => {
    for (const invocation of embeddedInvocations(clause)) {
      const token = "rel" in invocation ? { text: invocation.rel, quoted: false } : { text: invocation.dynamic, quoted: false };
      found.push({ invocation: resolveInvocation(ctx, state, token, at), embedded: true });
    }
    return found;
  };
  const word = commandWord(clause.tokens);
  if (word === null) return embedded();
  const quote = word.token.text[0];
  if ((quote === "'" || quote === '"') && !word.token.text.endsWith(quote)) return embedded();
  const command = stripOuterQuotes(word.token.text);
  const base = command.split("/").pop() ?? command;
  if (!word.token.quoted && (command === "source" || command === ".")) {
    const argument = firstNonFlag(clause.tokens.slice(word.index + 1));
    found.push({ invocation: argument === undefined ? { dynamic: command } : resolveInvocation(ctx, state, argument, at), embedded: false });
    return found;
  }
  if (!word.token.quoted && command === "eval") return [{ invocation: { dynamic: "eval" }, embedded: false }];
  if (!word.token.quoted && (command === "cd" || command === "pushd" || command === "popd")) return [];
  if (!word.token.quoted && (base === "npm" || base === "npx")) return [];
  if (!word.token.quoted && command === "su") {
    const args = clause.tokens.slice(word.index + 1).map((token) => stripOuterQuotes(token.text));
    return args.includes("-c") ? [{ invocation: { dynamic: "-c" }, embedded: false }] : [];
  }
  if (INTERPRETERS.has(base)) {
    const args = clause.tokens.slice(word.index + 1);
    const texts = args.map((token) => stripOuterQuotes(token.text));
    if (clause.piped) return [{ invocation: { dynamic: args[0]?.text ?? "stdin" }, embedded: false }];
    const heredoc = texts.find((text) => text.includes("<<"));
    if (heredoc !== undefined) {
      return SHELL_INTERPRETERS.has(base) ? [{ invocation: { dynamic: heredoc }, embedded: false }] : [];
    }
    const inline = texts.find((text) => text === "-c" || text === "-s");
    if (inline !== undefined) return [{ invocation: { dynamic: inline }, embedded: false }];
    if (JS_INTERPRETERS.has(base) && texts.some((text) => text === "-e" || text === "-p")) return [];
    if (texts.some((text) => VERSION_FLAGS.has(text))) return [];
    if (base === "bun" || base === "deno") {
      const subcommands = base === "bun" ? BUN_SUBCOMMANDS : DENO_SUBCOMMANDS;
      const first = args[0] === undefined ? "" : stripOuterQuotes(args[0].text);
      if (args.length === 0 || subcommands.has(first)) {
        if (first !== "run") return [];
        const rest: ShellToken[] = [];
        for (let argIndex = 1; argIndex < args.length; argIndex++) {
          const value = stripOuterQuotes(args[argIndex].text);
          if (value === "--filter" || value === "--cwd" || value === "--env-file") {
            argIndex++;
            continue;
          }
          rest.push(args[argIndex]);
        }
        const script = firstNonFlag(rest);
        if (script === undefined) return [];
        const value = stripOuterQuotes(script.text);
        if (!SCRIPT_EXTENSION.test(value) && !value.includes("/") && !value.startsWith(".")) return [];
        return [{ invocation: resolveInvocation(ctx, state, script, at), embedded: false }];
      }
    }
    const argument = firstNonFlag(args);
    if (argument === undefined) return [{ invocation: { dynamic: "stdin" }, embedded: false }];
    return [{ invocation: resolveInvocation(ctx, state, argument, at), embedded: false }];
  }
  if (SCRIPT_EXTENSION.test(command)) {
    return [{ invocation: resolveInvocation(ctx, state, word.token, at), embedded: false }];
  }
  return embedded();
}

/**
 * Scan one shell unit — a workflow or action run block, or a followed shell
 * file — with one set of rules. Clause splitting, cd tracking, command
 * substitutions (each with its own cd and nested state), wrapped interpreters,
 * here-document bodies, the install classifier and script resolution all live
 * here; the two callers differ only in their initial state.
 */
function scanShellText(ctx: TreeContext, initial: ShellState, text: string): void {
  const state: ShellState = { ...initial };
  for (const entry of logicalShellLines(text)) {
    const number = state.lineOverride ?? entry.line;
    if (entry.body) {
      if (state.classifyInstalls && !state.rule1Exempt && isInstallLine(entry.text)) {
        handleInstall(ctx, state.file, entry.text, entry.text, number, lineAt(state, number), state.cwd, state.cwdUnknown, state.staged);
      }
      continue;
    }
    if (state.classifyInstalls) {
      if (/^(?:cp|mv|ln|install|rsync|tee)\s/.test(entry.text) && /(?:package-lock\.json|npm-shrinkwrap\.json)/.test(entry.text)) state.staged = true;
      if (/^(?:sed\s+-i|perl\s+-i)/.test(entry.text) && /(?:package-lock\.json|npm-shrinkwrap\.json)/.test(entry.text)) state.staged = true;
      if (/(?:^|[^0-9])>{1,2}\s*[^;&|]*package-lock\.json/.test(entry.text)) state.staged = true;

      // A tracked-lock helper call is a whole-line shape. Unknown cwd => refuse:
      // its directory argument is resolved against the cwd the helper runs in.
      const helper = entry.text.match(HELPER_CALL);
      if (helper !== null) {
        if (!state.rule1Exempt) {
          const dir = helper[3];
          if (dir.startsWith("/") || dir === "-") throw new Error(`${lineAt(state, number)}: tracked-lock helper directory is not relative: ${entry.text}`);
          if (state.cwdUnknown) {
            throw new Error(`${lineAt(state, number)}: cannot bind the tracked-lock helper after a non-literal directory change: ${entry.text}`);
          }
          const resolved = resolveRepoDir(state.cwd, dir, lineAt(state, number));
          const lockfile = resolved === "" ? "package-lock.json" : `${resolved}/package-lock.json`;
          if (!ctx.tracked.has(lockfile)) throw new Error(`${lineAt(state, number)}: ${lockfile} is not a tracked lockfile the gate reads: ${entry.text}`);
          ctx.installs++;
          const helperRel = resolveRepoDir(state.cwd, "scripts/npm-ci-tracked-lock.sh", lineAt(state, number));
          if (scriptExists(ctx, helperRel)) {
            followScript(ctx, helperRel, { cwd: state.cwd, cwdUnknown: state.cwdUnknown, label: state.label, chain: state.chain });
          }
        }
        continue;
      }
      if (entry.text.startsWith("bash scripts/npm-ci-tracked-lock.sh") || entry.text.startsWith("bash ./scripts/npm-ci-tracked-lock.sh")) {
        throw new Error(`${lineAt(state, number)}: tracked-lock helper call is not the literal accepted shape: ${entry.text}`);
      }
    }

    let clauseInstall = false;
    const reviewedWrapped = state.source === "run-block" && REVIEWED_WRAPPED_PAYLOAD_ALLOWLIST.some((reviewed) => reviewed.text === entry.text);
    for (const clause of splitClauses(entry.text)) {
      const word = commandWord(clause.tokens);
      if (word !== null) {
        const command = stripOuterQuotes(word.token.text);
        if (!word.token.quoted && command === "cd") {
          const argument = firstNonFlag(clause.tokens.slice(word.index + 1));
          const target = argument === undefined ? "" : stripOuterQuotes(argument.text).replace(/^--\s*/, "");
          const at = state.source === "run-block" ? `${state.label}: ${entry.text}` : lineAt(state, number);
          const resolved = resolveCdTarget(ctx, target, state.cwd, state.scriptDir, state.bindings, at);
          if (resolved === null) {
            state.cwdUnknown = true;
          } else if (state.cwdUnknown && resolved.kind === "cwd") {
            // Unknown => sticky: a cwd-relative cd cannot re-anchor an unknown
            // cwd; only an absolute-in-repository or script-directory anchor can.
          } else {
            state.cwd = resolved.path;
            state.cwdUnknown = false;
          }
          continue;
        }
        if (!word.token.quoted && (command === "pushd" || command === "popd")) {
          state.cwdUnknown = true;
          continue;
        }
      }
      // Every install clause on the line is judged, in order, so an earlier
      // install cannot consume the check for a later one.
      const clauseText = clause.tokens.map((token) => token.text).join(" ");
      if (state.classifyInstalls && !state.rule1Exempt && isInstallLine(clauseText)) {
        handleInstall(ctx, state.file, entry.text, clauseText, number, lineAt(state, number), state.cwd, state.cwdUnknown, state.staged);
        clauseInstall = true;
      }
      // A clause that is one assignment whose value holds a command
      // substitution is judged by that substitution's own scan below; the
      // substitution's nested quotes make the clause's words unreliable.
      const assignmentClause =
        clause.tokens[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=.*\$\(/.test(clause.tokens[0].text);
      if (!assignmentClause) {
        for (const item of clauseInvocations(ctx, state, clause, entry.text, number)) {
          if (item.embedded && reviewedWrapped) continue;
          followInvocation(ctx, state, item.invocation, entry.text, number);
        }
      }
    }
    if (state.classifyInstalls && !state.rule1Exempt && !clauseInstall && isInstallLine(entry.text)) {
      handleInstall(ctx, state.file, entry.text, entry.text, number, lineAt(state, number), state.cwd, state.cwdUnknown, state.staged);
    }
    if (state.depth >= 8) continue;
    // A command substitution runs in its own subshell: it starts from the
    // enclosing state and keeps its own cd and nested substitutions. A backtick
    // span the line cannot parse reliably is refused as unresolved, never skipped.
    const substitutions = commandSubstitutions(entry.text);
    for (const token of substitutions.unparsed) {
      if (state.source === "followed-script") {
        pushUnresolved(ctx, state.file, number, token, state.label, state.chain);
      } else {
        throw new Error(
          `${state.label}: unresolved backtick command substitution: ${entry.text} (physical line ${number})`,
        );
      }
    }
    for (const body of substitutions.bodies) {
      scanShellText(ctx, { ...state, depth: state.depth + 1, classifyInstalls: false, lineOverride: number }, body);
    }
  }
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
  const env = ctx.scriptEnv.get(rel) ?? new Set<string>();
  for (const name of ctx.envNames) env.add(name);
  ctx.scriptEnv.set(rel, env);
}

function followScript(ctx: TreeContext, rel: string, origin: ShellOrigin) {
  if (ctx.visiting.has(rel)) return;
  if (!scriptExists(ctx, rel)) return;
  addFollowed(ctx, rel);
  const content = readFileSync(join(ctx.root, rel), "utf8");
  ctx.visiting.add(rel);
  try {
    scanScript(ctx, rel, content, origin);
  } finally {
    ctx.visiting.delete(rel);
  }
}

function normalizeNpmText(line: string): string {
  return line.toLowerCase().replace(/[\\'"]/g, "");
}

/** Rule 1: npx as a word, or npm as a word followed later by an install verb word. */
function isInstallLine(line: string): boolean {
  const normalized = normalizeNpmText(line);
  const word = (name: string) => new RegExp(`(?:^|[^A-Za-z0-9_-])${name}(?![A-Za-z0-9_-])`, "g");
  if (word("npx").test(normalized)) return true;
  for (const match of normalized.matchAll(word("npm"))) {
    const after = normalized.slice((match.index ?? 0) + match[0].length);
    if (INSTALL_VERB.test(after)) return true;
  }
  return false;
}

function reviewedLineKey(entry: ReviewedScriptLineEntry): string {
  return `${entry.script}\0${entry.line}\0${entry.text}`;
}

const NPM_DIRECTORY_FLAGS = new Set(["--prefix", "-C", "--workspace", "-w"]);
const NPM_VALUE_FLAGS = new Set([
  ...NPM_DIRECTORY_FLAGS,
  "--registry",
  "--tag",
  "--access",
  "--userconfig",
  "--globalconfig",
  "--cache",
  "--otp",
  "--scope",
  "--omit",
  "--include",
  "--loglevel",
  "--depth",
  "--save-prefix",
  "--install-strategy",
  "--location",
  "--before",
  "--audit-level",
]);

function npmTokens(line: string): { command: string; args: string[] } | null {
  const tokens = shellTokens(line);
  for (let index = 0; index < tokens.length; index++) {
    // A quoted or backslash-escaped command word is still a literal `npm` when
    // its shell value is exactly `npm`/`npx`; anything else (e.g. `$NPM`) is not
    // a shape this scanner can read, and handleInstall refuses it.
    const text = literalWord(tokens[index].text);
    if (text !== "npm" && text !== "npx") continue;
    return { command: text, args: tokens.slice(index + 1).map((token) => stripOuterQuotes(token.text)) };
  }
  return null;
}

function npmSubcommand(args: string[]): string {
  for (let index = 0; index < args.length; index++) {
    const text = args[index];
    if (text.startsWith("-")) {
      if (NPM_VALUE_FLAGS.has(text)) index++;
      continue;
    }
    return text;
  }
  return "";
}

/** The shape of an npm/npx invocation, or null when the line holds none. */
function npmInstallShape(line: string): "npx" | "exec" | "run" | "install" | null {
  const parsed = npmTokens(line);
  if (parsed === null) return null;
  if (parsed.command === "npx") return "npx";
  const subcommand = npmSubcommand(parsed.args);
  if (subcommand === "exec" || subcommand === "x") return "exec";
  if (subcommand === "run" || subcommand === "run-script") return "run";
  if (subcommand === "ci" || subcommand === "install" || subcommand === "i" || subcommand === "add") return "install";
  return null;
}

/** npm's effective install directory after `--prefix`, `-C` and `--workspace`/`-w`. */
function npmInstallDirectory(line: string, directory: string, at: string): string {
  const parsed = npmTokens(line);
  if (parsed === null) return directory;
  let base = directory;
  let sawDirectoryFlag = false;
  for (let index = 0; index < parsed.args.length; index++) {
    const text = parsed.args[index];
    const equals = text.match(/^(--prefix|-C|--workspace|-w)=(.*)$/);
    const flag = equals !== null ? equals[1] : NPM_DIRECTORY_FLAGS.has(text) ? text : null;
    if (flag === null) continue;
    if (sawDirectoryFlag) {
      throw new Error(`${at}: an npm install repeats a directory flag (${flag}); the effective directory is refused: ${line}`);
    }
    sawDirectoryFlag = true;
    let value: string | null;
    if (equals !== null) value = equals[2];
    else {
      value = parsed.args[index + 1] ?? null;
      index++;
    }
    if (value === null || value === "" || value.startsWith("-") || /[$`~*?]/.test(value)) {
      throw new Error(`${at}: cannot bind an npm install: directory flag ${flag} is not a literal repository path: ${line}`);
    }
    base = resolveRepoDir(base, value, at);
  }
  return base;
}

function handleInstall(
  ctx: TreeContext,
  rel: string,
  line: string,
  shapeLine: string,
  number: number,
  at: string,
  directory: string,
  directoryUnresolved: boolean,
  staged: boolean,
) {
  const reviewed = REVIEWED_SCRIPT_LINE_ALLOWLIST.find(
    (entry) => entry.script === rel && entry.line === number && entry.text === line,
  );
  if (reviewed !== undefined) ctx.reviewedLines.push(reviewedLineKey(reviewed));
  if (reviewed !== undefined) return;
  const shape = npmInstallShape(shapeLine);
  // Unknown => refuse: an install-classified line whose command word or flags
  // the parser cannot read is never bound to the cwd lockfile.
  if (shape === null) {
    throw new Error(
      `${at}: an npm install line whose npm/npx shape cannot be read is refused: ${shapeLine}`,
    );
  }
  if (shape === "run") return;
  if (shape === "npx" || shape === "exec") {
    throw new Error(
      `${at}: ${shape === "npx" ? "npx" : "npm exec/x"} does not read the lockfile and is refused: ${line}`,
    );
  }
  if (line.includes("--no-package-lock")) throw new Error(`${at}: npm install with --no-package-lock is refused: ${line}`);
  if (directoryUnresolved) throw new Error(`${at}: cannot bind an npm install after a non-literal directory change: ${line}`);
  if (staged) throw new Error(`${at}: cannot bind an npm install after the script stages or copies a different lockfile before installing: ${line}`);
  if (isAcceptedGlobalToolInstall(shapeLine)) return;
  const installDirectory = npmInstallDirectory(shapeLine, directory, at);
  const lockfile = installDirectory === "" ? "package-lock.json" : `${installDirectory}/package-lock.json`;
  if (!ctx.tracked.has(lockfile)) {
    throw new Error(`${at}: cannot bind the npm install to a tracked lockfile: ${lockfile} is not a lockfile the gate reads: ${line}`);
  }
  ctx.installs++;
}

function embeddedInvocations(clause: Clause): Invocation[] {
  const tokens = clause.tokens;
  const word = commandWord(tokens);
  const wordIndex = word === null ? -1 : word.index;
  const found: Invocation[] = [];
  const base = word === null ? "" : (stripOuterQuotes(word.token.text).split("/").pop() ?? "");
  if (word !== null && (word.token.quoted || /^\$/.test(word.token.text))) {
    const argument = tokens[wordIndex + 1];
    if (argument !== undefined && !argument.quoted && /^(?:\.\/|scripts\/|\.github\/scripts\/)/.test(argument.text) && SCRIPT_EXTENSION.test(argument.text)) {
      found.push({ rel: argument.text });
    }
  }
  if (!EMBEDDED_WRAPPERS.has(base)) return found;
  for (const [index, token] of tokens.entries()) {
    if (index <= wordIndex || token.quoted) continue;
    const text = stripOuterQuotes(token.text);
    if (!/^(?:bash|sh|node|bun)$/.test(text)) continue;
    const argument = tokens[index + 1];
    // Unknown => refuse: a wrapped interpreter whose payload is absent,
    // `-c`/`-s`, or a here-document cannot be resolved to one repository file.
    if (argument === undefined) {
      found.push({ dynamic: `${text} stdin` });
      continue;
    }
    const value = stripOuterQuotes(argument.text);
    if (value === "-c" || value === "-s") {
      found.push({ dynamic: value });
    } else if (value.includes("<<")) {
      if (SHELL_INTERPRETERS.has(text)) found.push({ dynamic: value });
    } else if (/[$`]/.test(value)) found.push({ dynamic: argument.text });
    else if (SCRIPT_EXTENSION.test(value)) found.push({ rel: value });
  }
  return found;
}

function scanNonShellScript(ctx: TreeContext, rel: string, content: string, origin: ShellOrigin) {
  const chain = [...origin.chain, rel];
  const at = `${origin.label}: script ${rel} (invocation ${chain.join(" -> ")})`;
  const directory = resolveRepoDir("", origin.cwd, at);
  const text = stripCStyleComments(content);
  for (const entry of physicalLines(text)) {
    for (const invocation of invocationsIn(entry.text)) {
      // Unknown => refuse: a path in this file resolves against the cwd the
      // process was started in, which a non-literal directory change cannot name.
      if (origin.cwdUnknown) {
        throw new Error(`${at}, line ${entry.line}: cannot resolve a script invocation after a non-literal directory change: ${entry.text}`);
      }
      if ("dynamic" in invocation) {
        const resolved = resolveDynamicSuffix(ctx, invocation.dynamic);
        if (resolved !== null) {
          followScript(ctx, resolved, { cwd: directory, cwdUnknown: false, label: origin.label, chain });
        } else {
          pushUnresolved(ctx, rel, entry.line, invocation.dynamic, origin.label, chain);
        }
        continue;
      }
      const resolved = resolveRepoDir(directory, invocation.rel, at);
      const fromRoot = resolved === invocation.rel ? null : resolveRepoDir("", invocation.rel, at);
      if (scriptExists(ctx, resolved)) followScript(ctx, resolved, { cwd: directory, cwdUnknown: false, label: origin.label, chain });
      else if (fromRoot !== null && scriptExists(ctx, fromRoot)) {
        followScript(ctx, fromRoot, { cwd: directory, cwdUnknown: false, label: origin.label, chain });
      } else pushUnresolved(ctx, rel, entry.line, invocation.rel, origin.label, chain);
    }
  }
}

function scanScript(ctx: TreeContext, rel: string, content: string, origin: ShellOrigin) {
  if (!isShellScript(rel, content)) {
    scanNonShellScript(ctx, rel, content, origin);
    return;
  }
  scanShellText(
    ctx,
    {
      cwd: resolveRepoDir("", origin.cwd, `${origin.label}: script ${rel}`),
      cwdUnknown: origin.cwdUnknown,
      label: origin.label,
      chain: [...origin.chain, rel],
      file: rel,
      scriptDir: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
      bindings: collectBindings(content),
      source: "followed-script",
      classifyInstalls: true,
      rule1Exempt: rel === "scripts/npm-ci-tracked-lock.sh",
      staged: false,
      depth: 0,
    },
    content,
  );
}

function scanRunBlock(ctx: TreeContext, run: string, cwd: string, label: string) {
  scanShellText(
    ctx,
    {
      cwd: resolveRepoDir("", cwd, label),
      cwdUnknown: false,
      label,
      chain: [],
      file: "",
      scriptDir: "",
      source: "run-block",
      classifyInstalls: false,
      rule1Exempt: false,
      staged: false,
      depth: 0,
    },
    run,
  );
}

/** Literal and computed repository-script invocations written in one non-shell line. */
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
  const isCommandPosition = (index: number): boolean => {
    if (index === 0) return true;
    const previous = tokens[index - 1].text;
    if (/^(?:;|&|\||\(|\)|\{|\})$/.test(previous)) return true;
    return previous === "then" || previous === "do" || previous === "else";
  };
  for (const [index, token] of tokens.entries()) {
    if (isCommandWord(token)) {
      const argument = tokens[index + 1];
      if (argument === undefined || /^[;&|(){}]$/.test(argument.text)) continue;
      if (/[$`]/.test(argument.text)) {
        if (!isCommandPosition(index)) continue;
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
    if (!isCommandPosition(index)) continue;
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
      if (argument !== undefined && !argument.quoted && /^(?:\.\/|scripts\/|\.github\/scripts\/)/.test(argument.text) && scriptFile.test(argument.text)) {
        add(argument.text);
      }
    }
  }
  return found;
}

function resolveStaticInvocation(token: ShellToken): Invocation {
  const value = stripOuterQuotes(token.text);
  if (/[$`]/.test(value)) return { dynamic: token.text };
  if (value.startsWith("/")) return { dynamic: token.text };
  return { rel: value };
}

function followAction(ctx: TreeContext, actionPath: string, label: string, inheritedEnv: Set<string> = ctx.envNames) {
  const rel = actionPath.replace(/^\.\//, "").replace(/\/$/, "");
  if (ctx.visitingActions.has(rel)) return;
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
  ctx.visitingActions.add(rel);
  const outerEnv = ctx.envNames;
  try {
    const action = load(source) as { runs?: { steps?: WorkflowStep[] } };
    const steps = action.runs?.steps ?? [];
    for (const [index, step] of steps.entries()) {
      const stepLabel = `${label} action ${rel} step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
      ctx.envNames = new Set(inheritedEnv);
      for (const name of Object.keys(step.env ?? {})) ctx.envNames.add(name);
      if (step.uses?.startsWith("./")) {
        followAction(ctx, step.uses, stepLabel, ctx.envNames);
        continue;
      }
      if (step.run === undefined) continue;
      const workdir = step["working-directory"] ?? "";
      const direct = npmCiLockDirs(step.run, workdir, stepLabel);
      for (const dir of direct) {
        const lockfile = dir === "" ? "package-lock.json" : `${dir}/package-lock.json`;
        if (!ctx.tracked.has(lockfile)) {
          throw new Error(`${stepLabel}: ${lockfile} is not a tracked lockfile the gate reads`);
        }
        ctx.installs++;
      }
      scanRunBlock(ctx, step.run, workdir, stepLabel);
    }
  } finally {
    ctx.envNames = outerEnv;
    ctx.visitingActions.delete(rel);
  }
}
function unresolvedKey(entry: { script: string; line: number; token: string }): string {
  return `${entry.script}\0${entry.line}\0${entry.token}`;
}

function assignmentToVariable(assignment: string, name: string): boolean {
  return (
    new RegExp(`^(?:export|local|readonly|declare|typeset)\\s+(?:-[A-Za-z]+\\s+)*${name}=`).test(assignment) ||
    new RegExp(`^${name}\\+?=`).test(assignment)
  );
}

/**
 * The repository files a pinned assignment names. A variable is resolved through
 * the script's single assignment; a literal path is taken as written. Unknown
 * => absent: a `source` the pinned text does not derive is refused.
 */
function assignmentSourcePaths(
  ctx: TreeContext,
  assignment: string,
  content: string,
  script: string,
): Set<string> {
  const bindings = collectBindings(content);
  const scriptDir = script.includes("/") ? script.slice(0, script.lastIndexOf("/")) : "";
  const out = new Set<string>();
  const addLiteral = (value: string) => {
    const rel = value.replace(/^\.\//, "");
    if (/^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/.test(rel) && scriptExists(ctx, rel)) out.add(rel);
  };
  for (const token of shellTokens(assignment)) {
    const value = stripOuterQuotes(token.text);
    if (!/[$`]/.test(value)) {
      addLiteral(value);
      continue;
    }
    for (const match of token.text.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
      const name = match[1] ?? match[2];
      const resolved = resolveAssignmentReference(name, bindings, scriptDir);
      if (resolved === null) continue;
      if (resolved.kind === "scriptDir") {
        if (scriptExists(ctx, resolved.path)) out.add(resolved.path);
      } else if (resolved.kind === "absolute") {
        const rel = repoRelativePath(ctx, resolved.path);
        if (rel !== null && scriptExists(ctx, rel)) out.add(rel);
      }
    }
  }
  return out;
}

/** Verify one reviewed entry: its single assignment, env reach, target and source. */
function verifyAllowlistEntry(ctx: TreeContext, entry: UnresolvedInvocationAllowlistEntry, observed: UnresolvedEntry) {
  let content: string;
  try {
    content = readFileSync(join(ctx.root, entry.script), "utf8");
  } catch {
    throw new Error(`assertNpmCiWorkflowTree: stale UNRESOLVED_INVOCATION_ALLOWLIST entry: ${entry.script} line ${entry.line} is not readable`);
  }
  const variable = tokenVariableName(entry.token);
  if (variable !== null && assignmentToVariable(entry.assignment, variable)) {
    const bindings = collectBindings(content).get(variable) ?? [];
    if (bindings.length !== 1) {
      throw new Error(
        `assertNpmCiWorkflowTree: stale UNRESOLVED_INVOCATION_ALLOWLIST entry: ${entry.script} line ${entry.line} assigns ${variable} ${bindings.length} times, expected exactly one`,
      );
    }
    if (bindings[0].text !== entry.assignment) {
      throw new Error(
        `assertNpmCiWorkflowTree: stale UNRESOLVED_INVOCATION_ALLOWLIST entry: ${entry.script} line ${entry.line} assignment to ${variable} does not match the pinned text`,
      );
    }
  } else {
    const occurrences = content.split(entry.assignment).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `assertNpmCiWorkflowTree: stale UNRESOLVED_INVOCATION_ALLOWLIST entry: ${entry.script} line ${entry.line} assignment text appears ${occurrences} times, expected exactly once`,
      );
    }
  }
  // Unknown => refuse: `${VAR:-default}` and `${VAR-default}` depend on the
  // runtime environment the scan cannot see, so no reviewed entry may pin one.
  if (ENV_OVERRIDABLE.test(entry.assignment)) {
    throw new Error(
      `assertNpmCiWorkflowTree: UNRESOLVED_INVOCATION_ALLOWLIST entry ${entry.script} line ${entry.line} pins an env-overridable default (${entry.assignment}); an unresolved value may not be pinned`,
    );
  }
  if (!scriptExists(ctx, entry.target)) {
    throw new Error(
      `assertNpmCiWorkflowTree: stale UNRESOLVED_INVOCATION_ALLOWLIST entry: ${entry.script} line ${entry.line} target ${entry.target} is not a repository file`,
    );
  }
  if (entry.source !== undefined) {
    if (!scriptExists(ctx, entry.source)) {
      throw new Error(
        `assertNpmCiWorkflowTree: stale UNRESOLVED_INVOCATION_ALLOWLIST entry: ${entry.script} line ${entry.line} source ${entry.source} is not a repository file`,
      );
    }
    // Unknown => refuse: the source must be tied to the pinned assignment text,
    // not merely declared next to it.
    const derived = assignmentSourcePaths(ctx, entry.assignment, content, entry.script);
    if (!derived.has(entry.source)) {
      throw new Error(
        `assertNpmCiWorkflowTree: UNRESOLVED_INVOCATION_ALLOWLIST entry ${entry.script} line ${entry.line} source ${entry.source} is not derived from the pinned assignment ${entry.assignment}`,
      );
    }
    followScript(ctx, entry.source, { cwd: "", cwdUnknown: false, label: observed.label, chain: observed.chain });
  }
  if (entry.target !== entry.script) {
    followScript(ctx, entry.target, { cwd: "", cwdUnknown: false, label: observed.label, chain: observed.chain });
  }
}

/** Verify each reviewed entry and follow its target and source (including nested entries). */
function followAllowlistTargets(ctx: TreeContext, allowlist: readonly UnresolvedInvocationAllowlistEntry[]) {
  const verified = new Set<string>();
  const rounds = allowlist.length + 1;
  for (let round = 0; round < rounds; round++) {
    let progressed = false;
    for (const entry of allowlist) {
      const key = unresolvedKey(entry);
      if (verified.has(key)) continue;
      if (!ctx.followed.includes(entry.script)) continue;
      if (!ctx.unresolvedEntries.some((observed) => unresolvedKey(observed) === key)) continue;
      const observed = ctx.unresolvedEntries.find((entry) => unresolvedKey(entry) === key);
      if (observed === undefined) continue;
      verifyAllowlistEntry(ctx, entry, observed);
      verified.add(key);
      progressed = true;
    }
    if (!progressed) break;
  }
  for (const entry of allowlist) {
    const key = unresolvedKey(entry);
    if (!ctx.followed.includes(entry.script)) continue;
    if (!ctx.unresolvedEntries.some((observed) => unresolvedKey(observed) === key)) continue;
    if (!verified.has(key)) {
      throw new Error(
        `assertNpmCiWorkflowTree: UNRESOLVED_INVOCATION_ALLOWLIST entry ${entry.script} line ${entry.line} was never verified`,
      );
    }
  }
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

/** Refuse a reviewed install-classifier line that no longer holds its exact text. */
function assertReviewedScriptLinesKnown(ctx: TreeContext) {
  const followed = new Set(ctx.followed);
  const observed = new Set(ctx.reviewedLines);
  for (const entry of REVIEWED_SCRIPT_LINE_ALLOWLIST) {
    if (!followed.has(entry.script)) continue;
    if (observed.has(reviewedLineKey(entry))) continue;
    throw new Error(
      `assertNpmCiWorkflowTree: stale REVIEWED_SCRIPT_LINE_ALLOWLIST entry: ${entry.script} line ${entry.line} no longer holds the reviewed text`,
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
  const ctx: TreeContext = { root: repoRoot, tracked, installs: 0, followed: [], unresolved: [], unresolvedEntries: [], reviewedLines: [], visiting: new Set(), visitingActions: new Set(), scriptEnv: new Map(), envNames: new Set() };
  ctx.installs += assertNpmCiLockfilesRead(source, tracked, workflowName);
  const workflow = parseWorkflow(source);
  const workflowEnv = new Set(Object.keys(workflow.env ?? {}));
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const defaultWorkdir = job.defaults?.run?.["working-directory"] ?? workflow.defaults?.run?.["working-directory"] ?? "";
    const jobEnv = new Set(workflowEnv);
    for (const name of Object.keys(job.env ?? {})) jobEnv.add(name);
    for (const [index, step] of job.steps.entries()) {
      const label = `${workflowName === undefined ? "" : `workflow ${workflowName} `}job ${jobName} step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
      ctx.envNames = new Set(jobEnv);
      for (const name of Object.keys(step.env ?? {})) ctx.envNames.add(name);
      if (step.uses?.startsWith("./")) {
        followAction(ctx, step.uses, label);
        continue;
      }
      if (step.run === undefined) continue;
      scanRunBlock(ctx, step.run, step["working-directory"] ?? defaultWorkdir, label);
    }
  }
  ctx.envNames = new Set();
  followAllowlistTargets(ctx, unresolvedAllowlist);
  assertUnresolvedInvocationsKnown(ctx, unresolvedAllowlist);
  assertReviewedScriptLinesKnown(ctx);
  return { installs: ctx.installs, followed: ctx.followed, unresolved: ctx.unresolved };
}
