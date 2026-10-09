#!/usr/bin/env bash
# check-bun-pin.sh — the Docker integration image must run the Bun this
# repository pins, not a hard-coded floating tag (cli#578). cli#575's TOML
# cases passed under the pin and failed under the newer floating image, so the
# image the Docker Integration job runs is built from the same pin the rest of
# the pipeline uses.
#
# This gate WHITELISTS one known-good wiring rather than enumerating bad tags,
# the same shape as scripts/check-nono-pin.sh (cli#341 S4). It requires:
#
#   1. package.json's "packageManager" is bun@<x.y.z> — the pin — and
#      scripts/docker-bun-version.sh prints exactly that version from it.
#   2. Dockerfile.test declares `ARG BUN_VERSION` with NO default and its base
#      stage is exactly `FROM oven/bun:${BUN_VERSION}-slim`. A default would let
#      a build silently choose its own version; with no default an omitted arg
#      expands the reference to the invalid `oven/bun:-slim`, a loud build
#      failure rather than a floating tag. No literal oven/bun tag may appear
#      anywhere in the file.
#   3. docker-compose.yml forwards BUN_VERSION into EVERY Dockerfile.test build,
#      and each forward is a REQUIRED expansion (`${BUN_VERSION:?...}`), so an
#      unset value is refused by compose before any build.
#   4. .github/workflows/test.yml derives BUN_VERSION from package.json through
#      scripts/docker-bun-version.sh and exports it for the build, and does not
#      hardcode the version — the workflow's container Bun is the repository
#      pin, not a literal.
#
# SCRIPTS_ROOT overrides the tree under test (fixtures in
# scripts/test-check-bun-pin.sh); it is unset in CI, where the gate reads the
# repository it lives in.
set -euo pipefail

root="${SCRIPTS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
pkg="$root/package.json"
helper="$root/scripts/docker-bun-version.sh"
dockerfile="$root/Dockerfile.test"
compose="$root/docker-compose.yml"
workflow="$root/.github/workflows/test.yml"
fail=0
err() { printf 'check-bun-pin: %s\n' "$1" >&2; fail=1; }

# ── Rule 1: the pin, and the helper that publishes it ────────────────────────
pin=""
if [ ! -f "$pkg" ]; then
  err "missing package.json"
else
  pin="$(sed -n 's/^[[:space:]]*"packageManager"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg")"
  printf '%s' "$pin" | grep -qE '^bun@[0-9]+\.[0-9]+\.[0-9]+$' \
    || err "package.json packageManager must be bun@<x.y.z> (got: '${pin:-<missing>}')"
  pin="${pin#bun@}"
fi
if [ ! -f "$helper" ]; then
  err "missing scripts/docker-bun-version.sh — the workflow derives BUN_VERSION through it"
else
  helper_out="$(DOCKER_BUN_VERSION_ROOT="$root" bash "$helper" 2>&1)" || {
    err "scripts/docker-bun-version.sh failed: $helper_out"
    helper_out=""
  }
  [ "$helper_out" = "$pin" ] \
    || err "scripts/docker-bun-version.sh printed '$helper_out', package.json pins '$pin'"
fi

# ── Rule 2: Dockerfile.test ──────────────────────────────────────────────────
if [ ! -f "$dockerfile" ]; then
  err "missing Dockerfile.test"
else
  narg="$(grep -cE '^[[:space:]]*ARG[[:space:]]+BUN_VERSION' "$dockerfile" || true)"
  [ "$narg" = "1" ] \
    || err "Dockerfile.test must declare 'ARG BUN_VERSION' exactly once (found $narg)"
  if grep -qE '^[[:space:]]*ARG[[:space:]]+BUN_VERSION[[:space:]]*=' "$dockerfile"; then
    err "Dockerfile.test gives BUN_VERSION a default — a build could then silently choose its own version instead of the repository pin"
  fi
  nfrom="$(grep -cxF 'FROM oven/bun:${BUN_VERSION}-slim' "$dockerfile" || true)"
  [ "$nfrom" = "1" ] \
    || err "Dockerfile.test's base stage must be exactly 'FROM oven/bun:\${BUN_VERSION}-slim' (found $nfrom)"

  # No literal oven/bun tag anywhere (full-line comments are prose, skipped): the
  # base must follow the arg.
  literals="$(grep -vE '^[[:space:]]*#' "$dockerfile" | grep -oE 'oven/bun:[^[:space:]"]*' | grep -v -F -x 'oven/bun:${BUN_VERSION}-slim' || true)"
  if [ -n "$literals" ]; then
    err "Dockerfile.test names a literal oven/bun tag ('$(printf '%s' "$literals" | tr '\n' ' ')') — the version must come from BUN_VERSION"
  fi
fi

# ── Rule 3: docker-compose.yml forwards the arg, as a required expansion ─────
if [ ! -f "$compose" ]; then
  err "missing docker-compose.yml"
else
  nbuild="$(grep -cE '^[[:space:]]*dockerfile:[[:space:]]*Dockerfile\.test[[:space:]]*$' "$compose" || true)"
  nargline="$(grep -cE '^[[:space:]]*BUN_VERSION:' "$compose" || true)"
  [ "${nbuild:-0}" -ge 1 ] \
    || err "docker-compose.yml has no Dockerfile.test build to pin"
  [ "$nbuild" = "$nargline" ] \
    || err "docker-compose.yml has $nbuild Dockerfile.test build(s) but $nargline BUN_VERSION arg(s) — every one must forward the pin"
  optional="$(grep -E '^[[:space:]]*BUN_VERSION:' "$compose" | grep -vE '\$\{BUN_VERSION[:\?]' || true)"
  if [ -n "$optional" ]; then
    err "docker-compose.yml forwards BUN_VERSION without a required expansion (\${BUN_VERSION:?...}): $(printf '%s' "$optional" | tr '\n' ' ')"
  fi
fi

# ── Rule 4: the workflow derives the version from package.json ───────────────
if [ ! -f "$workflow" ]; then
  err "missing .github/workflows/test.yml"
else
  grep -qE 'docker-bun-version\.sh' "$workflow" \
    || err ".github/workflows/test.yml does not derive the container Bun through scripts/docker-bun-version.sh"
  grep -qE 'BUN_VERSION=' "$workflow" \
    || err ".github/workflows/test.yml does not export BUN_VERSION for the Docker build"
  grep -qE 'GITHUB_ENV' "$workflow" \
    || err ".github/workflows/test.yml does not export BUN_VERSION to the build's environment (GITHUB_ENV)"
  if grep -qE 'BUN_VERSION:[[:space:]]*["0-9]' "$workflow"; then
    err ".github/workflows/test.yml hardcodes BUN_VERSION — it must be derived from package.json"
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf 'check-bun-pin: FAILED\n' >&2
  exit 1
fi
printf 'check-bun-pin: OK (Docker integration image pins Bun %s)\n' "$pin"
