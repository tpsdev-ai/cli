#!/usr/bin/env bash
#
# promote-latest.sh — move the `latest` dist-tag of all six @tpsdev-ai packages
# to one released version, together, and prove the registry actually moved.
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
#   4. It moves all six or none: if a move fails or does not land, the packages
#      already moved are rolled back to their previous `latest`.
#   5. It prints a final table — package, previous latest, new latest, and whether
#      the move was verified against the registry.
#
# It is deliberately NOT sha-bound: a canary-gated promote (promote only the exact
# artifact a canary exercised) is the larger half of cli#366 and is not built here.
# This script automates the promote step that exists today.
#
# USAGE
#
#     scripts/promote-latest.sh [VERSION] [--dry-run] [--yes]
#
#     VERSION    Version to promote. Defaults to the `version` in
#                packages/cli/package.json.
#     --dry-run  Print the plan and stop; change nothing.
#     --yes      Skip the confirmation prompt (for a scripted run).
#     --help     Show usage.
#
# ENVIRONMENT
#
#     NPM_BIN        npm binary to use (default: `npm`). Overridable so the
#                    test harness can inject a fake registry.
#     PROMOTE_ROOT   Repo root to read package.json files from (default: the
#                    script's own parent directory). Set only by the test harness.
#
# EXIT CODES
#
#     0  every package's `latest` is the target (moved, or already there)
#     1  usage error
#     2  refused before acting (a package is not published at the target, or its
#        current `latest` could not be read)
#     3  the operator did not confirm
#     4  the promote did not complete for all six (rolled back where possible)
#     5  the promote failed AND a rollback did not restore the registry
set -euo pipefail

NPM_BIN="${NPM_BIN:-npm}"
root="${PROMOTE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# The six published packages, in dependency order: the four platform binaries
# first, then the agent runtime, then the CLI last (it pins the platform packages).
PKG_DIRS=(cli-darwin-arm64 cli-darwin-x64 cli-linux-arm64 cli-linux-x64 agent cli)

EXIT_USAGE=1
EXIT_REFUSED=2
EXIT_ABORTED=3
EXIT_INCOMPLETE=4
EXIT_ROLLBACK_FAILED=5

die() { printf 'promote-latest: %s\n' "$1" >&2; exit "${2:-$EXIT_USAGE}"; }

usage() {
  cat <<'EOF'
Usage: scripts/promote-latest.sh [VERSION] [--dry-run] [--yes]

Move the `latest` dist-tag of every @tpsdev-ai package to VERSION. All six move
together; the script refuses if any is not published at VERSION.

  VERSION    Version to promote (default: packages/cli/package.json's version).
  --dry-run  Print the plan and stop, changing nothing.
  --yes      Skip the confirmation prompt (for a scripted run).
  --help     Show this help.

Environment: NPM_BIN (default `npm`) selects the npm binary.
EOF
}

# trim surrounding whitespace/newlines from stdin
trim() { printf '%s' "$1" | tr -d '[:space:]'; }

# ── arguments ────────────────────────────────────────────────────────────────
version=""
dry_run=0
assume_yes=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --yes | -y) assume_yes=1 ;;
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
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.]+)?$ ]]; then
  die "invalid version: $version"
fi

declare -A name_of=()
for d in "${PKG_DIRS[@]}"; do
  f="$root/packages/$d/package.json"
  [ -f "$f" ] || die "missing $f — this script promotes the six @tpsdev-ai packages"
  name_of[$d]="$(node -p "require(process.argv[1]).name" "$f")"
done

printf 'Promoting the "latest" dist-tag to %s\n' "$version"

# ── 1. verify BEFORE acting: all six exist at this version ───────────────────
missing=()
declare -A view_out=()
for d in "${PKG_DIRS[@]}"; do
  name="${name_of[$d]}"
  set +e
  out="$("$NPM_BIN" view "${name}@${version}" version 2>&1)"
  rc=$?
  set -e
  view_out[$d]="$out"
  if [ "$rc" -ne 0 ] || [ "$(trim "$out")" != "$version" ]; then
    missing+=("$d")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  {
    printf 'promote-latest: REFUSED — not all six packages are published at %s.\n' "$version"
    printf '\nMissing at %s:\n' "$version"
    for d in "${missing[@]}"; do
      printf '  - %s\n' "${name_of[$d]}"
    done
    printf '\nA promote moves "latest" for every package, and packages/cli pins the four\n'
    printf 'platform packages at exact versions — promoting a version that is missing\n'
    printf 'anywhere would publish a "latest" CLI whose pinned dependencies do not resolve.\n'
    printf 'All six must exist first. Nothing was changed.\n'
    printf '\nRegistry output for the missing packages:\n'
    for d in "${missing[@]}"; do
      printf '  %s@%s:\n' "${name_of[$d]}" "$version"
      if [ -n "${view_out[$d]}" ]; then
        printf '%s\n' "${view_out[$d]}" | sed 's/^/    /'
      else
        printf '    (npm produced no output)\n'
      fi
    done
  } >&2
  exit "$EXIT_REFUSED"
fi

# ── 2. read the current `latest` for each, and build the plan ────────────────
declare -A prev_latest=()
plan_moves=0
for d in "${PKG_DIRS[@]}"; do
  name="${name_of[$d]}"
  set +e
  cur="$("$NPM_BIN" view "$name" dist-tags.latest 2>&1)"
  rc=$?
  set -e
  cur="$(trim "$cur")"
  if [ "$rc" -ne 0 ] || [ -z "$cur" ]; then
    die "cannot read the current \`latest\` dist-tag for $name (needed to plan the move and to roll it back): $cur" "$EXIT_REFUSED"
  fi
  prev_latest[$d]="$cur"
  [ "$cur" = "$version" ] || plan_moves=$((plan_moves + 1))
done

printf '\n%-30s %-10s %-10s %s\n' "PACKAGE" "LATEST" "TARGET" "ACTION"
for d in "${PKG_DIRS[@]}"; do
  name="${name_of[$d]}"
  cur="${prev_latest[$d]}"
  if [ "$cur" = "$version" ]; then
    action="already latest"
  else
    action="move"
  fi
  printf '%-30s %-10s %-10s %s\n' "$name" "$cur" "$version" "$action"
done

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

# ── 4. move, re-reading the registry after each package ──────────────────────
declare -A new_latest=()
declare -A moved=()
for d in "${PKG_DIRS[@]}"; do
  new_latest[$d]="${prev_latest[$d]}"
done

failure=0
for d in "${PKG_DIRS[@]}"; do
  name="${name_of[$d]}"
  cur="${prev_latest[$d]}"
  if [ "$cur" = "$version" ]; then
    new_latest[$d]="$version"
    printf '\n-> %s: already latest (%s), no move needed\n' "$name" "$version"
    continue
  fi

  printf '\n-> %s: npm dist-tag add %s@%s latest\n' "$name" "$name" "$version"
  set +e
  out="$("$NPM_BIN" dist-tag add "${name}@${version}" latest 2>&1)"
  rc=$?
  set -e
  [ -z "$out" ] || printf '%s\n' "$out"
  moved[$d]=1

  # Do NOT trust the exit code: re-read the registry and confirm the tag moved.
  set +e
  post="$("$NPM_BIN" view "$name" dist-tags.latest 2>&1)"
  prc=$?
  set -e
  post="$(trim "$post")"
  new_latest[$d]="$post"

  if [ "$rc" -ne 0 ] || [ "$prc" -ne 0 ] || [ "$post" != "$version" ]; then
    failure=1
    printf 'promote-latest: %s did NOT move to %s (dist-tag add exited %s; registry now reports %s).\n' \
      "$name" "$version" "$rc" "${post:-<unreadable>}" >&2
    break
  fi
done

# ── 5. all-six-or-none: roll back if the promote did not complete ────────────
rollback_failed=0
if [ "$failure" -ne 0 ]; then
  printf '\npromote-latest: the promote did not complete — rolling back so the end state is all-six or none.\n' >&2
  for d in "${PKG_DIRS[@]}"; do
    [ "${moved[$d]:-0}" = 1 ] || continue
    name="${name_of[$d]}"
    prev="${prev_latest[$d]}"
    set +e
    rb_out="$("$NPM_BIN" dist-tag add "${name}@${prev}" latest 2>&1)"
    rb_rc=$?
    set -e
    [ -z "$rb_out" ] || printf '%s\n' "$rb_out" >&2
    set +e
    back="$("$NPM_BIN" view "$name" dist-tags.latest 2>&1)"
    brc=$?
    set -e
    back="$(trim "$back")"
    new_latest[$d]="$back"
    if [ "$rb_rc" -ne 0 ] || [ "$brc" -ne 0 ] || [ "$back" != "$prev" ]; then
      rollback_failed=1
      printf 'promote-latest: ROLLBACK FAILED for %s — it reports %s, expected %s. Restore it by hand: npm dist-tag add %s@%s latest\n' \
        "$name" "${back:-<unreadable>}" "$prev" "$name" "$prev" >&2
    else
      printf 'promote-latest: rolled back %s to %s\n' "$name" "$prev" >&2
    fi
  done
fi

# ── 6. final table ───────────────────────────────────────────────────────────
printf '\n%-30s %-10s %-10s %s\n' "PACKAGE" "PREVIOUS" "NEW" "VERIFIED MOVED"
for d in "${PKG_DIRS[@]}"; do
  name="${name_of[$d]}"
  prev="${prev_latest[$d]}"
  new="${new_latest[$d]}"
  if [ "$new" = "$version" ]; then
    if [ "$prev" = "$version" ]; then
      verified="already latest"
    else
      verified="yes"
    fi
  else
    verified="NO"
  fi
  printf '%-30s %-10s %-10s %s\n' "$name" "$prev" "${new:-<unreadable>}" "$verified"
done

all_ok=1
for d in "${PKG_DIRS[@]}"; do
  [ "${new_latest[$d]}" = "$version" ] || all_ok=0
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
