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
      "      echo \"::error::    the stage subcommands need >= 11.15.0 (the upgrade step pins\"",
      "      echo \"::error::    ^11.15.0)\"",
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
