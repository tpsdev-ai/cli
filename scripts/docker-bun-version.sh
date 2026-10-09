#!/usr/bin/env bash
# Print the Bun version this repository pins, from package.json's
# "packageManager" (e.g. 1.3.10). This is the single source of truth for the
# Docker integration image's Bun (cli#578): docker-compose.yml forwards it as
# the BUN_VERSION build arg and .github/workflows/test.yml's Docker Integration
# job derives it here, so the CI image is built from the repository's pin.
# scripts/check-bun-pin.sh checks that wiring.
#
# Refuses anything but bun@<x.y.z>, so a malformed pin fails loudly instead of
# producing an unusable build arg.
#
# Usage: BUN_VERSION="$(scripts/docker-bun-version.sh)" docker compose build
set -euo pipefail

root="${DOCKER_BUN_VERSION_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

fail() { printf 'docker-bun-version: %s\n' "$1" >&2; exit 1; }

[ -f "$root/package.json" ] || fail "missing $root/package.json"

n="$(grep -c '"packageManager"' "$root/package.json" || true)"
[ "$n" = "1" ] || fail "package.json must carry exactly one \"packageManager\" field (found $n)"

pm="$(sed -n 's/^[[:space:]]*"packageManager"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/package.json")"
printf '%s' "$pm" | grep -qE '^bun@[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "package.json packageManager must be bun@<x.y.z> (got: ${pm:-<missing>})"

printf '%s\n' "${pm#bun@}"
