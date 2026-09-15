#!/usr/bin/env bash
# cli#341 S4 — fail-first gate: the Docker image must pin nono to an immutable
# commit and must never fetch a moving ref (branch, tag, or generated archive).
#
# This gate WHITELISTS. It asserts that one specific, known-good shape is present
# rather than enumerating bad refs to reject: a blacklist lets a fork's branch
# name, an unlisted tag, or a `--depth 1` clone slip through. Concretely it
# requires:
#
#   1. .nono-version exists and has EXACTLY two keys — `version` (informational,
#      a bare x.y.z) and `commit` (the pin: a 40-char lowercase hex commit id).
#      No other keys, no duplicate assignments.
#   2. docker/Dockerfile's nono stage sources .nono-version and checks out
#      ${commit} from the canonical repo, then asserts `git rev-parse HEAD` is
#      exactly ${commit}.
#   3. Nothing ELSE in that stage names a ref: no --branch/--depth, no
#      refs/heads|tags, no generated-archive URL, no tag name, no master/main/HEAD
#      (the rev-parse assertion, which must read HEAD, is the one allowed use).
#
# Pre-S4 (`git clone --depth 1 .../nono.git /tmp/nono`, no pin file) fails rules
# 1–3; a `--branch v0.74.0` fetch fails rule 3.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pin_file="$root/.nono-version"
dockerfile="$root/docker/Dockerfile"
fail=0

err() { printf 'check-nono-pin: %s\n' "$1" >&2; fail=1; }

# ── Rule 1: the pin file has exactly two keys, both well-formed ───────────────
version=""
commit=""
if [ ! -f "$pin_file" ]; then
  err "missing pin file: .nono-version"
else
  # Every non-comment, non-blank line must be `version=` or `commit=`.
  while IFS= read -r line; do
    case "$line" in
      '' | \#*) continue ;;
    esac
    key="${line%%=*}"
    case "$key" in
      version | commit) ;;
      *) err ".nono-version: unexpected line '${line}' (only version= and commit= are allowed)" ;;
    esac
  done <"$pin_file"

  count_key() { grep -cE "^$1=" "$pin_file" || true; }

  if [ "$(count_key version)" != "1" ]; then
    err ".nono-version: expected exactly one 'version=' line, found $(count_key version)"
  fi
  if [ "$(count_key commit)" != "1" ]; then
    err ".nono-version: expected exactly one 'commit=' line, found $(count_key commit)"
  fi

  version="$(sed -n 's/^version=//p' "$pin_file" | head -n1)"
  commit="$(sed -n 's/^commit=//p' "$pin_file" | head -n1)"

  if [ -n "$version" ] && ! printf '%s' "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    err ".nono-version: version '$version' is not a bare x.y.z (no leading 'v', no suffix)"
  fi
  if ! printf '%s' "$commit" | grep -qE '^[0-9a-f]{40}$'; then
    err ".nono-version: commit '$commit' is not a 40-char lowercase hex commit id"
  fi
fi

# ── Rules 2 & 3: the Dockerfile's nono stage ──────────────────────────────────
if [ ! -f "$dockerfile" ]; then
  err "missing docker/Dockerfile"
else
  stage="$(awk '
    /^FROM[[:space:]]/ {
      if ($0 ~ /AS[[:space:]]+nono-builder([[:space:]]|$)/) { f = 1; print; next }
      f = 0
    }
    f { print }
  ' "$dockerfile")"

  if [ -z "$stage" ]; then
    err "docker/Dockerfile: no 'FROM ... AS nono-builder' stage found"
  else
    # Full-line comments are prose; they must not trip the ref scan.
    code="$(printf '%s\n' "$stage" | grep -vE '^[[:space:]]*#')"

    # Rule 2 — the required positive shape.
    printf '%s\n' "$code" | grep -qF 'COPY .nono-version' \
      || err "nono stage does not COPY .nono-version — the pin must be sourced from the repo file"
    printf '%s\n' "$code" | grep -qF '. /tmp/.nono-version' \
      || err "nono stage does not source .nono-version — \${commit} would be undefined"
    printf '%s\n' "$code" | grep -qF 'https://github.com/nolabs-ai/nono' \
      || err "nono stage does not clone the canonical repo https://github.com/nolabs-ai/nono"
    printf '%s\n' "$code" | grep -qF 'checkout "${commit}"' \
      || err "nono stage does not contain the pinned checkout: git -C /tmp/nono checkout \"\${commit}\""
    printf '%s\n' "$code" | grep -qF 'test "$(git -C /tmp/nono rev-parse HEAD)" = "${commit}"' \
      || err "nono stage does not assert the checkout: test \"\$(git -C /tmp/nono rev-parse HEAD)\" = \"\${commit}\""

    # Rule 3 — whitelist: drop the one allowed assertion line, then reject any
    # remaining ref. A blacklist of branch names is not enough; anything that
    # *names* a ref (rather than the commit id) is a fail.
    scan="$(printf '%s\n' "$code" | grep -vF 'rev-parse HEAD')"
    if printf '%s\n' "$scan" | grep -qIE '(^|[^A-Za-z0-9_-])(master|main|HEAD)([^A-Za-z0-9_-]|$)'; then
      err "nono stage names a branch/HEAD ref — only the pinned commit id may be referenced"
    fi
    if printf '%s\n' "$scan" | grep -qIE 'refs/heads/|refs/tags/|--branch([[:space:]]|=)|--depth([[:space:]]|=)'; then
      err "nono stage fetches a ref (refs/*, --branch, --depth) — pin the commit instead"
    fi
    if printf '%s\n' "$scan" | grep -qIE 'archive/refs|releases/download'; then
      err "nono stage fetches a generated archive (mutable bytes) — clone and check out the commit"
    fi
    if printf '%s\n' "$scan" | grep -qIE 'v[0-9]+\.[0-9]+\.[0-9]+'; then
      err "nono stage names a tag (mutable) — the commit id is the pin"
    fi
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf 'check-nono-pin: FAILED\n' >&2
  exit 1
fi
printf 'check-nono-pin: OK (nono %s @ %s)\n' "$version" "$commit"
