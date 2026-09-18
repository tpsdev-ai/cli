#!/usr/bin/env bash
#
# promote-latest.sh — move the `latest` dist-tag of all six @tpsdev-ai packages
# to one released version, together, and prove the registry actually moved.
#
# Runs under bash 3.2 — the bash shipped on the machine that drives releases
# (macOS still ships 3.2.57). It uses only bash 3.2 features; the version guard
# below states the floor explicitly so a future bash-4 construct fails with a
# sentence here, not with a parse error mid-release.
#
# ── THE INVARIANT THIS DELIVERS — READ THIS BEFORE TRUSTING THE ALL-SIX CHECK ─
#
# This tool delivers "NO PARTIAL PROMOTE": either all six `latest` tags move to V,
# or none do. It does NOT deliver "the promoted set is trustworthy". It checks only
# that each package EXISTS at V — it never checks that the four platform packages
# at V were built from the same commit as cli at V. A trojaned
# @tpsdev-ai/cli-linux-x64@V next to a clean @tpsdev-ai/cli@V passes every check in
# this script and would be promoted. Bounding the promoted set to one tested,
# sha-identified build (a canary-gated, sha-bound promote) is the larger half of
# cli#366 and is deliberately NOT built here. Do not read the all-six check as that
# stronger guarantee.
#
# WHY THIS EXISTS (cli#366)
#
# After a tag push, release.yml stage-publishes six packages under the `staged`
# dist-tag. A maintainer approves them in npm (2FA) and the versions become public
# — but approval CANNOT move `latest`: `--tag` is an immutable property of a staged
# package and `npm stage approve` has no tag flag. So `latest` stays on the previous
# version until someone runs, by hand and per package:
#
#     npm dist-tag add @tpsdev-ai/<pkg>@<version> latest
#
# That step is manual, unrecorded and easy to forget — and a forgotten promote is
# indistinguishable from a failed release: the version is public, `npm install`
# still serves the old one, and nothing anywhere says why. This script is that step,
# made explicit and checked.
#
# WHAT IT GUARANTEES
#
#   1. It verifies BEFORE it acts: every one of the six packages must exist at the
#      target version on the registry. If any is missing it refuses and names which.
#      A partial promote would move `latest` for the packages that exist and leave
#      the rest behind, and packages/cli pins the four platform packages at exact
#      versions — so a `latest` CLI would resolve pinned binaries that do not exist.
#   2. It shows the current `latest` for every package and what it will do, then
#      requires an explicit confirmation ("yes"). `--dry-run` stops before any move;
#      `--yes` skips the prompt for a scripted run.
#   3. After each move it RE-READS the registry (`npm view <pkg> dist-tags.latest`)
#      to confirm the tag moved. It does not trust `npm dist-tag add`'s exit code:
#      a command that "succeeded" without moving `latest` is the exact bug this
#      issue is about.
#   4. It moves all six or none: if a move fails, does not land, or the process is
#      interrupted (SIGINT/SIGTERM/SIGHUP) mid-move, the packages already moved are
#      rolled back to their previous `latest`. The attempted-flag is set BEFORE each
#      `dist-tag add`, so a signal landing immediately after a tag change still rolls
#      that package back.
#   5. A target that is not a forward release — older than the current `latest` (a
#      DOWNGRADE) or a pre-release — is allowed (a downgrade is a legitimate
#      rollback) but never silently: it is called out loudly and needs the distinct
#      `--allow-downgrade` acknowledgement, which `--yes` does NOT imply.
#   6. It prints a final table — package, previous latest, new latest, and whether
#      the move was verified against the registry.
#
# Every npm call is pinned with `--registry` (NPM_REGISTRY, default
# https://registry.npmjs.org) so the one path that publishes cannot be redirected
# by an npm config on the machine it runs from.
#
# USAGE
#
#     scripts/promote-latest.sh [VERSION] [--dry-run] [--yes] [--allow-downgrade]
#
#     VERSION             Version to promote. Defaults to the `version` in
#                         packages/cli/package.json.
#     --dry-run           Print the plan and stop; change nothing.
#     --yes               Skip the confirmation prompt (for a scripted run).
#     --allow-downgrade   Acknowledge a non-forward promote: the target is older
#                         than the current `latest` (a downgrade), or is a
#                         pre-release. `--yes` does NOT imply this.
#     --help              Show usage.
#
# ENVIRONMENT
#
#     NPM_BIN        npm binary to use (default: `npm`). Overridable so the
#                    test harness can inject a fake registry.
#     NPM_REGISTRY   Registry to pin every npm call to (default
#                    https://registry.npmjs.org).
#     PROMOTE_ROOT   Repo root to read package.json files from (default: the
#                    script's own parent directory). Set only by the test harness.
#
# EXIT CODES
#
#     0  every package's `latest` is the target (moved, or already there)
#     1  usage error, or an unsupported bash
#     2  refused before acting (a package is not published at the target, or its
#        current `latest` could not be read)
#     3  the operator did not confirm (including a downgrade without
#        --allow-downgrade)
#     4  the promote did not complete for all six — failed, not landed, or
#        interrupted (rolled back where possible)
#     5  the promote failed AND a rollback did not restore the registry
set -euo pipefail

# ── bash version guard ───────────────────────────────────────────────────────
# Fail with a sentence rather than a raw parse error. This script must run on the
# release driver, where bash is 3.2.
BASH_MAJOR="${BASH_VERSINFO[0]:-0}"
BASH_MINOR="${BASH_VERSINFO[1]:-0}"
if [ "$BASH_MAJOR" -lt 3 ] || { [ "$BASH_MAJOR" -eq 3 ] && [ "$BASH_MINOR" -lt 2 ]; }; then
  printf 'promote-latest: bash %s.%s found, but bash 3.2 or newer is required.\n' "$BASH_MAJOR" "$BASH_MINOR" >&2
  exit 1
fi

NPM_BIN="${NPM_BIN:-npm}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
root="${PROMOTE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# The six published packages, in dependency order: the four platform binaries
# first, then the agent runtime, then the CLI last (it pins the platform packages).
PKG_DIRS=(cli-darwin-arm64 cli-darwin-x64 cli-linux-arm64 cli-linux-x64 agent cli)
NPKG="${#PKG_DIRS[@]}"

EXIT_USAGE=1
EXIT_REFUSED=2
EXIT_ABORTED=3
EXIT_INCOMPLETE=4
EXIT_ROLLBACK_FAILED=5

die() { printf 'promote-latest: %s\n' "$1" >&2; exit "${2:-$EXIT_USAGE}"; }

usage() {
  cat <<'EOF'
Usage: scripts/promote-latest.sh [VERSION] [--dry-run] [--yes] [--allow-downgrade]

Move the `latest` dist-tag of every @tpsdev-ai package to VERSION. All six move
together; the script refuses if any is not published at VERSION.

  VERSION             Version to promote (default: packages/cli/package.json).
  --dry-run           Print the plan and stop, changing nothing.
  --yes               Skip the confirmation prompt (for a scripted run).
  --allow-downgrade   Acknowledge a non-forward promote: an older target (a
                      downgrade) or a pre-release. `--yes` does NOT imply this.
  --help              Show this help.

Environment: NPM_BIN (default `npm`); NPM_REGISTRY (default
https://registry.npmjs.org) pins every npm call.
EOF
}

# trim surrounding whitespace/newlines from stdin
trim() { printf '%s' "$1" | tr -d '[:space:]'; }

# Zero-padded numeric core of a version, so it can be string-compared. Handles a
# pre-release suffix (0.6.0-rc.1 -> 0.6.0) and a build suffix (0.6.0+b1 -> 0.6.0).
core_num() { printf '%s' "$1" | awk -F. '{printf "%04d%04d%04d", $1 + 0, $2 + 0, $3 + 0}'; }

# 1 if the version has a pre-release part (a '-' before any '+'), else 0.
is_prerelease() {
  local v="${1%%+*}" # strip build metadata first: SemVer allows hyphens there
  case "$v" in
    *-*) printf '1' ;;
    *) printf '0' ;;
  esac
}

# ── arguments ────────────────────────────────────────────────────────────────
version=""
dry_run=0
assume_yes=0
allow_downgrade=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --yes | -y) assume_yes=1 ;;
    --allow-downgrade) allow_downgrade=1 ;;
    --help | -h)
      usage
      exit 0
      ;;
    --) shift; break ;;
    -*)
      usage >&2
      die "unknown option: $1"
      ;;
    *)
      [ -z "$version" ] || die "version given more than once ($version and $1)"
      version="$1"
      ;;
  esac
  shift
done
[ "$#" -eq 0 ] || die "unexpected argument: $1"

command -v node >/dev/null 2>&1 || die "node is required to read package.json files"
command -v "$NPM_BIN" >/dev/null 2>&1 || die "npm binary not found: $NPM_BIN"

# ── resolve version and package names ────────────────────────────────────────
if [ -z "$version" ]; then
  cli_pkg="$root/packages/cli/package.json"
  [ -f "$cli_pkg" ] || die "no packages/cli/package.json under $root to read the default version from"
  version="$(node -p "require(process.argv[1]).version" "$cli_pkg")"
fi

# Reject anything that is not a plausible semver, so a typo cannot reach npm.
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  die "invalid version: $version"
fi

# Parallel indexed arrays, one slot per package (bash 3.2 has no associative
# arrays). `i` is the package index throughout.
names=()
prev_latest=()
new_latest=()
view_out=()
moved=()
for ((i = 0; i < NPKG; i++)); do
  d="${PKG_DIRS[i]}"
  f="$root/packages/$d/package.json"
  [ -f "$f" ] || die "missing $f — this script promotes the six @tpsdev-ai packages"
  names[i]="$(node -p "require(process.argv[1]).name" "$f")"
  prev_latest[i]=""
  new_latest[i]=""
  view_out[i]=""
  moved[i]=0
done

printf 'Promoting the "latest" dist-tag to %s\n' "$version"

# ── 1. verify BEFORE acting: all six exist at this version ───────────────────
missing=()
for ((i = 0; i < NPKG; i++)); do
  set +e
  out="$("$NPM_BIN" view "${names[i]}@${version}" version --registry "$NPM_REGISTRY" 2>&1)"
  rc=$?
  set -e
  view_out[i]="$out"
  if [ "$rc" -ne 0 ] || [ "$(trim "$out")" != "$version" ]; then
    missing+=("$i")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  {
    printf 'promote-latest: REFUSED — not all six packages are published at %s.\n' "$version"
    printf '\nMissing at %s:\n' "$version"
    for i in "${missing[@]}"; do
      printf '  - %s\n' "${names[i]}"
    done
    printf '\nA promote moves "latest" for every package, and packages/cli pins the four\n'
    printf 'platform packages at exact versions — promoting a version that is missing\n'
    printf 'anywhere would publish a "latest" CLI whose pinned dependencies do not resolve.\n'
    printf 'All six must exist first. Nothing was changed.\n'
    printf '\nRegistry output for the missing packages:\n'
    for i in "${missing[@]}"; do
      printf '  %s@%s:\n' "${names[i]}" "$version"
      if [ -n "${view_out[i]}" ]; then
        printf '%s\n' "${view_out[i]}" | sed 's/^/    /'
      else
        printf '    (npm produced no output)\n'
      fi
    done
  } >&2
  exit "$EXIT_REFUSED"
fi

# ── 2. read the current `latest` for each, and build the plan ────────────────
plan_moves=0
downgrades=()
for ((i = 0; i < NPKG; i++)); do
  set +e
  cur="$("$NPM_BIN" view "${names[i]}" dist-tags.latest --registry "$NPM_REGISTRY" 2>&1)"
  rc=$?
  set -e
  cur="$(trim "$cur")"
  if [ "$rc" -ne 0 ] || [ -z "$cur" ]; then
    die "cannot read the current \`latest\` dist-tag for ${names[i]} (needed to plan the move and to roll it back): $cur" "$EXIT_REFUSED"
  fi
  prev_latest[i]="$cur"
  new_latest[i]="$cur"
  [ "$cur" = "$version" ] || plan_moves=$((plan_moves + 1))
  if [ "$(core_num "$version")" \< "$(core_num "$cur")" ]; then
    downgrades+=("$i")
  fi
done

printf '\n%-30s %-10s %-10s %s\n' "PACKAGE" "LATEST" "TARGET" "ACTION"
for ((i = 0; i < NPKG; i++)); do
  if [ "${prev_latest[i]}" = "$version" ]; then
    action="already latest"
  else
    action="move"
  fi
  printf '%-30s %-10s %-10s %s\n' "${names[i]}" "${prev_latest[i]}" "$version" "$action"
done

# ── 2b. direction guard: loud, but not a refusal ─────────────────────────────
prerelease_target=0
[ "$(is_prerelease "$version")" = 1 ] && prerelease_target=1
nonstandard=0
if [ "${#downgrades[@]}" -gt 0 ] || [ "$prerelease_target" -eq 1 ]; then
  nonstandard=1
  printf '\n#####################################################################\n' >&2
  printf '# WARNING — this is NOT a forward promote.\n' >&2
  printf '#####################################################################\n' >&2
  if [ "${#downgrades[@]}" -gt 0 ]; then
    printf 'DOWNGRADE: "latest" would move BACKWARD for %d package(s):\n' "${#downgrades[@]}" >&2
    for i in "${downgrades[@]}"; do
      printf '  %s: %s -> %s\n' "${names[i]}" "${prev_latest[i]}" "$version" >&2
    done
  fi
  if [ "$prerelease_target" -eq 1 ]; then
    printf 'PRE-RELEASE target: %s is a pre-release version.\n' "$version" >&2
  fi
  printf 'This is allowed (a downgrade is a legitimate rollback), but never silently:\n' >&2
  printf 'a real promote needs --allow-downgrade. --yes does NOT confirm this.\n' >&2
fi

if [ "$dry_run" -eq 1 ]; then
  if [ "$plan_moves" -eq 0 ]; then
    printf '\nDRY RUN — nothing was changed. Nothing to do: latest is already %s for all six packages.\n' "$version"
  else
    printf '\nDRY RUN — nothing was changed. %d package(s) would move to %s.\n' "$plan_moves" "$version"
  fi
  exit 0
fi

if [ "$plan_moves" -eq 0 ]; then
  printf '\nNothing to do: latest is already %s for all six packages.\n' "$version"
  exit 0
fi

if [ "$nonstandard" -eq 1 ] && [ "$allow_downgrade" -ne 1 ]; then
  printf '\npromote-latest: refusing to move "latest" without an explicit acknowledgement.\n' >&2
  printf 'promote-latest: re-run with --allow-downgrade to acknowledge (--yes does not confirm this).\n' >&2
  printf 'promote-latest: nothing was changed.\n' >&2
  exit "$EXIT_ABORTED"
fi

# ── 3. explicit confirmation ─────────────────────────────────────────────────
if [ "$assume_yes" -ne 1 ]; then
  printf '\nMove "latest" to %s for %d package(s)? Type "yes" to proceed: ' "$version" "$plan_moves" >&2
  reply=""
  if ! IFS= read -r reply; then
    printf '\npromote-latest: no confirmation read (stdin is not a terminal?); re-run with --yes for a scripted run.\n' >&2
    exit "$EXIT_ABORTED"
  fi
  reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
  if [ "$reply" != "yes" ]; then
    printf '\npromote-latest: aborted — expected "yes", got "%s". Nothing was changed.\n' "$reply" >&2
    exit "$EXIT_ABORTED"
  fi
fi

# ── helpers used by the move loop, the failure path, and the signal handler ──
rollback_failed=0

rollback_moved() {
  printf '\npromote-latest: the promote did not complete — rolling back so the end state is all-six or none.\n' >&2
  # Reverse dependency order: restore the CLI first, then agent, then the platform
  # binaries — so there is no window with a new CLI beside previous platform tags.
  for ((i = NPKG - 1; i >= 0; i--)); do
    [ "${moved[i]}" = 1 ] || continue
    set +e
    rb_out="$("$NPM_BIN" dist-tag add "${names[i]}@${prev_latest[i]}" latest --registry "$NPM_REGISTRY" 2>&1)"
    rb_rc=$?
    set -e
    [ -z "$rb_out" ] || printf '%s\n' "$rb_out" >&2
    set +e
    back="$("$NPM_BIN" view "${names[i]}" dist-tags.latest --registry "$NPM_REGISTRY" 2>&1)"
    brc=$?
    set -e
    back="$(trim "$back")"
    new_latest[i]="$back"
    if [ "$rb_rc" -ne 0 ] || [ "$brc" -ne 0 ] || [ "$back" != "${prev_latest[i]}" ]; then
      rollback_failed=1
      printf 'promote-latest: ROLLBACK FAILED for %s — it reports %s, expected %s. Restore it by hand: npm dist-tag add %s@%s latest\n' \
        "${names[i]}" "${back:-<unreadable>}" "${prev_latest[i]}" "${names[i]}" "${prev_latest[i]}" >&2
    else
      printf 'promote-latest: rolled back %s to %s\n' "${names[i]}" "${prev_latest[i]}" >&2
    fi
  done
}

print_final_table() {
  printf '\n%-30s %-10s %-10s %s\n' "PACKAGE" "PREVIOUS" "NEW" "VERIFIED MOVED"
  for ((i = 0; i < NPKG; i++)); do
    if [ "${new_latest[i]}" = "$version" ]; then
      if [ "${prev_latest[i]}" = "$version" ]; then
        verified="already latest"
      else
        verified="yes"
      fi
    else
      verified="NO"
    fi
    printf '%-30s %-10s %-10s %s\n' "${names[i]}" "${prev_latest[i]}" "${new_latest[i]:-<unreadable>}" "$verified"
  done
}

# ── 4. interrupt handling ────────────────────────────────────────────────────
# Installed only now: before this point nothing has moved, so the default signal
# action is harmless. A signal during the move loop must roll back, not leave a
# partial promote — the exact failure this tool exists to remove.
# shellcheck disable=SC2317  # on_signal is invoked indirectly, from the traps below
on_signal() {
  sig="$1"
  # Ignore further termination signals at once. A second signal must NOT abandon
  # the rollback (which is what an `exit` here did), and ignoring makes re-entry
  # impossible, so no separate guard is needed.
  trap '' TERM INT HUP
  failure=1
  printf '\npromote-latest: received SIG%s — rolling back so the end state is all-six or none.\n' "$sig" >&2
  rollback_moved
  print_final_table
  if [ "$rollback_failed" -ne 0 ]; then
    printf '\npromote-latest: FAILED — interrupted (SIG%s) and a rollback did not restore the registry. Manual action needed.\n' "$sig" >&2
    exit "$EXIT_ROLLBACK_FAILED"
  fi
  printf '\npromote-latest: FAILED — interrupted (SIG%s); the registry was restored to the previous "latest".\n' "$sig" >&2
  exit "$EXIT_INCOMPLETE"
}
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT
trap 'on_signal HUP' HUP

# ── 5. move, re-reading the registry after each package ──────────────────────
failure=0
for ((i = 0; i < NPKG; i++)); do
  if [ "${prev_latest[i]}" = "$version" ]; then
    new_latest[i]="$version"
    printf '\n-> %s: already latest (%s), no move needed\n' "${names[i]}" "$version"
    continue
  fi

  # Mark the attempt BEFORE the mutation: a signal (or a crash) landing between
  # the tag change and any later flag would otherwise leave a moved-but-unflagged
  # package that the rollback skips.
  moved[i]=1
  printf '\n-> %s: npm dist-tag add %s@%s latest\n' "${names[i]}" "${names[i]}" "$version"
  set +e
  out="$("$NPM_BIN" dist-tag add "${names[i]}@${version}" latest --registry "$NPM_REGISTRY" 2>&1)"
  rc=$?
  set -e
  [ -z "$out" ] || printf '%s\n' "$out"

  # Do NOT trust the exit code: re-read the registry and confirm the tag moved.
  set +e
  post="$("$NPM_BIN" view "${names[i]}" dist-tags.latest --registry "$NPM_REGISTRY" 2>&1)"
  prc=$?
  set -e
  post="$(trim "$post")"
  new_latest[i]="$post"

  if [ "$rc" -ne 0 ] || [ "$prc" -ne 0 ] || [ "$post" != "$version" ]; then
    failure=1
    printf 'promote-latest: %s did NOT move to %s (dist-tag add exited %s; registry now reports %s).\n' \
      "${names[i]}" "$version" "$rc" "${post:-<unreadable>}" >&2
    break
  fi
done

# ── 6. all-six-or-none: select the branch, THEN stop handling termination ─────
# The handlers are still active here. Clearing them BEFORE this branch is what
# left a window in which a signal killed the script mid-rollback. Select the
# branch first: on failure, IGNORE further signals while the rollback runs (a
# second signal must never abandon the remaining restorations); on success, clear
# the handlers so a late signal cannot roll back a promote that did succeed.
if [ "$failure" -ne 0 ]; then
  trap '' TERM INT HUP
  rollback_moved
else
  trap - TERM INT HUP
fi

print_final_table

all_ok=1
for ((i = 0; i < NPKG; i++)); do
  [ "${new_latest[i]}" = "$version" ] || all_ok=0
done

if [ "$failure" -eq 0 ] && [ "$all_ok" -eq 1 ]; then
  printf '\npromote-latest: OK — "latest" is now %s for all six packages (verified against the registry).\n' "$version"
  exit 0
fi

if [ "$rollback_failed" -ne 0 ]; then
  printf '\npromote-latest: FAILED — the promote did not complete and a rollback did not restore the registry. Manual action needed (see ROLLBACK FAILED above).\n' >&2
  exit "$EXIT_ROLLBACK_FAILED"
fi

printf '\npromote-latest: FAILED — the promote did not complete for all six packages; the registry was restored to the previous "latest".\n' >&2
exit "$EXIT_INCOMPLETE"
