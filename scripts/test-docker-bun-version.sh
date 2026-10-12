#!/usr/bin/env bash
# Fixtures for scripts/docker-bun-version.sh and scripts/assert-bun-version.sh.
# HELPER overrides the helper under test (used to run a mutant).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="${HELPER:-$here/docker-bun-version.sh}"
assert="$here/assert-bun-version.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
npass=0
nfail=0

check() { # name wanted-exit actual-exit
  if [ "$2" = "$3" ]; then printf 'PASS  %s\n' "$1"; npass=$((npass + 1))
  else printf 'FAIL  %s (exit %s, wanted %s)\n' "$1" "$3" "$2"; nfail=$((nfail + 1)); fi
}
pin_of() { # fixture-name package.json-text; sets out, err and rc
  mkdir -p "$work/$1"; printf '%s' "$2" >"$work/$1/package.json"
  out="$(DOCKER_BUN_VERSION_ROOT="$work/$1" bash "$helper" 2>"$work/$1/stderr")"; rc=$?
  err="$(cat "$work/$1/stderr")"
}

remedy='root package.json packageManager must be exactly one bun@<x.y.z>'
refused() { # name package.json-text, then needles the refusal must name
  name="$1"; text="$2"; shift 2
  pin_of "$name" "$text"
  if [ "$rc" = 0 ]; then printf 'FAIL  %s (accepted, exit 0)\n' "$name"; nfail=$((nfail + 1)); return; fi
  case "$err" in
    *"$remedy"*) : ;;
    *) printf 'FAIL  %s (refusal lacks the remedy: %s)\n' "$name" "$err"; nfail=$((nfail + 1)); return ;;
  esac
  for needle in "$@"; do
    case "$err" in
      *"$needle"*) : ;;
      *) printf 'FAIL  %s (refusal does not name %s: %s)\n' "$name" "$needle" "$err"; nfail=$((nfail + 1)); return ;;
    esac
  done
  printf 'PASS  %s\n' "$name"; npass=$((npass + 1))
}

pin_of root-pin '{"packageManager": "bun@1.3.10"}'
check "root pin: exits 0" 0 "$rc"
[ "$out" = "1.3.10" ]; check "root pin: prints it" 0 "$?"

pin_of nested-only '{
  "name": "x",
  "config": {
    "packageManager": "bun@9.9.9"
  }
}'
check "nested-only packageManager fails" 1 "$rc"
pin_of non-bun '{"packageManager": "npm@10.0.0"}'
check "non-bun manager fails" 1 "$rc"
pin_of malformed '{"packageManager": "bun@1.3.10",'
check "malformed JSON fails" 1 "$rc"

refused "two pins are refused" '{"packageManager": "bun@1.3.10\nbun@1.3.11"}' 'bun@1.3.10<newline>bun@1.3.11'
refused "a second line that is not a pin is refused" '{"packageManager": "bun@1.3.10\nbun@latest"}' 'bun@1.3.10<newline>bun@latest'
refused "a trailing newline is refused" '{"packageManager": "bun@1.3.10\n"}' 'bun@1.3.10<newline>'
refused "a short pin is refused" '{"packageManager": "bun@1.3"}' 'bun@1.3'
refused "a tag is refused" '{"packageManager": "bun@latest"}' 'bun@latest'
refused "a range is refused" '{"packageManager": "bun@^1.3.10"}' 'bun@^1.3.10'
refused "a prerelease is refused" '{"packageManager": "bun@1.3.10-canary"}' 'bun@1.3.10-canary'
refused "a four-part version is refused" '{"packageManager": "bun@1.3.10.5"}' 'bun@1.3.10.5'
refused "trailing text is refused" '{"packageManager": "bun@1.3.10 "}' 'bun@1.3.10 '
refused "a missing pin is refused" '{"name": "x"}' '<missing>'

bash "$assert" 1.3.10 1.3.10 svc >/dev/null 2>&1; check "comparison: match passes" 0 "$?"
bash "$assert" 1.3.10 1.4.0 svc >/dev/null 2>&1; check "comparison: mismatch fails" 1 "$?"

printf '\ntest-docker-bun-version: %d passed, %d failed\n' "$npass" "$nfail"
[ "$nfail" = 0 ]
