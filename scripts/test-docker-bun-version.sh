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
pin_of() { # fixture-name package.json-text; sets out and rc
  mkdir -p "$work/$1"; printf '%s' "$2" >"$work/$1/package.json"
  out="$(DOCKER_BUN_VERSION_ROOT="$work/$1" bash "$helper" 2>/dev/null)"; rc=$?
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

bash "$assert" 1.3.10 1.3.10 svc >/dev/null 2>&1; check "comparison: match passes" 0 "$?"
bash "$assert" 1.3.10 1.4.0 svc >/dev/null 2>&1; check "comparison: mismatch fails" 1 "$?"

printf '\ntest-docker-bun-version: %d passed, %d failed\n' "$npass" "$nfail"
[ "$nfail" = 0 ]
