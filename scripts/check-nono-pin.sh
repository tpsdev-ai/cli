#!/usr/bin/env bash
# cli#341 S4 — fail-first gate: the Docker image must pin nono to a tagged
# release + sha256, and must never fetch nono from a moving branch.
#
# Rules:
#   1. .nono-version exists and is well-formed (version=<x.y.z>, sha256=<64-hex>).
#   2. docker/Dockerfile does not fetch nono from a branch (master|main|HEAD,
#      refs/heads/, --branch) and does not `git clone` it.
#   3. docker/Dockerfile consumes the pin: it reads .nono-version (so the version
#      is not hardcoded elsewhere) and verifies the sha256 (sha256sum -c).
#
# On the pre-S4 Dockerfile (`git clone --depth 1 .../nono.git /tmp/nono ...`)
# rules 1, 2 and 3 all fire; after S4 the run is clean.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pin_file="$root/.nono-version"
dockerfile="$root/docker/Dockerfile"
fail=0

err() { printf 'check-nono-pin: %s\n' "$1" >&2; fail=1; }

# ── Rule 1: pin file present + well-formed ────────────────────────────────────
version=""
sha256=""
if [ ! -f "$pin_file" ]; then
  err "missing pin file: .nono-version"
else
  version="$(sed -n 's/^version=//p' "$pin_file" | head -n1)"
  sha256="$(sed -n 's/^sha256=//p' "$pin_file" | head -n1)"
  [ -n "$version" ] || err ".nono-version: missing 'version=' line"
  [ -n "$sha256" ] || err ".nono-version: missing 'sha256=' line"
  if [ -n "$version" ] && ! printf '%s' "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    err ".nono-version: version '$version' is not a bare x.y.z (no leading 'v', no suffix)"
  fi
  if [ -n "$sha256" ] && ! printf '%s' "$sha256" | grep -qE '^[0-9a-f]{64}$'; then
    err ".nono-version: sha256 '$sha256' is not a 64-char lowercase hex digest"
  fi
fi

# ── Rules 2 & 3: the Dockerfile ───────────────────────────────────────────────
if [ ! -f "$dockerfile" ]; then
  err "missing docker/Dockerfile"
else
  # Rule 2 — no branch/HEAD fetch. Word boundaries so 'domain'/'maintainer' don't match.
  if grep -nIE '(^|[^A-Za-z0-9_-])(master|main|HEAD)([^A-Za-z0-9_-]|$)' "$dockerfile"; then
    err "docker/Dockerfile references a branch (master|main|HEAD) — pin a tag instead"
  fi
  if grep -nIE 'refs/heads/|--branch([[:space:]]|=)' "$dockerfile"; then
    err "docker/Dockerfile fetches a branch (refs/heads or --branch) — pin a tag instead"
  fi
  if grep -nIE 'git[[:space:]]+clone|git[[:space:]]+checkout' "$dockerfile"; then
    err "docker/Dockerfile clones/checks out nono from git — fetch the pinned tagged tarball instead"
  fi
  if grep -nIE 'nono/(archive|releases)[^"'"'"' ]*v[0-9]+\.[0-9]+\.[0-9]+' "$dockerfile"; then
    err "docker/Dockerfile hardcodes a nono version — it must come from .nono-version"
  fi

  # Rule 3 — the Dockerfile consumes the pin.
  if ! grep -qE '(^|[^A-Za-z0-9_-])\.nono-version([^A-Za-z0-9_-]|$)' "$dockerfile"; then
    err "docker/Dockerfile does not read .nono-version (version would be hardcoded)"
  fi
  if ! grep -qE 'sha256sum[[:space:]]+-c' "$dockerfile"; then
    err "docker/Dockerfile does not verify the pinned sha256 (no 'sha256sum -c')"
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf 'check-nono-pin: FAILED\n' >&2
  exit 1
fi
printf 'check-nono-pin: OK (nono %s, sha256 %s…)\n' "$version" "${sha256:0:12}"
