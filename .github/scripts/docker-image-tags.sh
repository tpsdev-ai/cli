#!/usr/bin/env bash
# docker-image-tags.sh — the Docker Image workflow's checks before any build
# (cli#420): the version's shape, whether npm has published that version of
# @tpsdev-ai/agent, and the image tags to push.
#
# Input (env):
#   INPUT_VERSION   the workflow_dispatch `version` input, as given
#   GITHUB_OUTPUT   the step's output file
# Output, appended to $GITHUB_OUTPUT only after every check passes:
#   tps_version     the version
#   tags            the image tags to push, one per line
# Exit 1, with a ::error:: line, when the version does not have the required
# shape, the version lookup does not confirm publication, or the latest lookup
# fails or does not return a single version-shaped value.
#
# `npm` is taken from PATH. test/docker-image-tags.test.ts runs this script
# with a stub npm first on PATH.
set -euo pipefail

PKG="@tpsdev-ai/agent"
IMAGE="ghcr.io/tpsdev-ai/tps-office"
V="${INPUT_VERSION-}"

# 1. The required version shape: MAJOR.MINOR.PATCH with an optional
#    -prerelease. [[ =~ ]] tests the whole string, not line by line, and `^`
#    and `$` are its start and end, so an input with a newline in it is
#    refused. %q prints the input on one line.
if ! [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  printf '::error::invalid version %q: expected MAJOR.MINOR.PATCH with an optional -prerelease\n' "$V"
  exit 1
fi

errf="$(mktemp)"
trap 'rm -f "$errf"' EXIT

# Diagnostic from npm's stderr, exit status, or stdout for "could not verify".
# Arguments: npm's exit status and what it printed on stdout.
lookup_error() {
  local line
  if [ "$1" -eq 0 ]; then
    printf 'npm exited 0 and printed %q' "$2"
    return
  fi
  line="$(grep -m1 -E '^npm (error|ERR!) ' "$errf" || true)"
  [ -n "$line" ] || line="$(grep -m1 -v '^[[:space:]]*$' "$errf" || true)"
  [ -n "$line" ] || line="npm exited $1 with no error output"
  printf '%s' "$line"
}

# 2. npm must have published the version. A newly staged agent version is not
#    public until 2FA approval publishes it; run 36250170717 (v0.7.0) built the
#    image before that, and its `npm install` failed with ETARGET ("No matching
#    version found for @tpsdev-ai/agent@0.7.0.").
#    An E404 code and matching "No match found for version <version>" message,
#    with no conflicting code, reports that npm could not find the version and
#    recommends approval only if this version is staged. Every other
#    unverifiable lookup is reported as "could not verify". Both exit 1.
set +e
published="$(npm view "${PKG}@${V}" version 2>"$errf")"
rc=$?
set -e
if [ "$rc" -ne 0 ] || [ "$published" != "$V" ]; then
  cat "$errf" >&2
  if [ "$rc" -ne 0 ] && {
    { grep -qxF "npm error code E404" "$errf" &&
      grep -qxF "npm error 404 No match found for version ${V}" "$errf"; } ||
      { grep -qxF "npm ERR! code E404" "$errf" &&
        grep -qxF "npm ERR! 404 No match found for version ${V}" "$errf"; }
  } && awk '
    /^npm (error|ERR!) code / &&
      $0 != "npm error code E404" && $0 != "npm ERR! code E404" { exit 1 }
  ' "$errf"; then
    echo "::error::npm could not find version ${V} of ${PKG} (E404): if this version is staged, approve its staged release and re-run this workflow with version=${V}; otherwise publish this version or choose a public version"
  else
    echo "::error::could not verify ${PKG}@${V} on npm: $(lookup_error "$rc" "$published"); re-run the workflow"
  fi
  exit 1
fi
echo "${PKG}@${V} is public on npm"

# 3. The tags: the version tag, and :latest when the version equals npm's
#    dist-tags.latest for the package. The comparison is made when the tags
#    are computed. If the lookup fails or does not return a single
#    version-shaped value, exit 1: no tags are output.
set +e
latest="$(npm view "$PKG" dist-tags.latest 2>"$errf")"
rc=$?
set -e
if [ "$rc" -ne 0 ] || ! [[ "$latest" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  cat "$errf" >&2
  echo "::error::could not verify npm's latest for ${PKG}: $(lookup_error "$rc" "$latest"); re-run the workflow"
  exit 1
fi
tags="${IMAGE}:${V}"
if [ "$latest" = "$V" ]; then
  tags="${tags}
${IMAGE}:latest"
  echo "npm's latest for ${PKG} is ${V}: :${V} and :latest selected for push"
else
  printf "npm's latest for %s is %q, not %s: :%s selected for push\n" "$PKG" "$latest" "$V" "$V"
fi

{
  echo "tps_version=${V}"
  echo "tags<<TAGS"
  printf '%s\n' "$tags"
  echo "TAGS"
} >>"$GITHUB_OUTPUT"
