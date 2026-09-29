#!/usr/bin/env bash
# a9-red-proofs.sh — prove the A9 checks FIRE (cli#425 acceptance A9).
#
#   scripts/reviewer/a9-red-proofs.sh <image-tag> <image-id> [table.json]
#
# The reviewer image passing A9 is only evidence if the same checks fail on an
# image that does carry a credential. For each way one could ride into the image
# — a gh config under $XDG_CONFIG_HOME/gh, a git auth header, a git credential
# helper, a token-bearing insteadOf URL, a token in the image environment — this
# builds a throwaway image FROM the reviewer image with that credential planted
# (fake values), runs image-checks.sh's A9 section on it, and requires it to exit
# non-zero with the expected FAIL line. Any proof that does not go red fails
# this script, so the lane keeps proving A9 fires on every run.
set -uo pipefail

IMG="${1:?usage: a9-red-proofs.sh <image-tag> <image-id> [table.json]}"
ID="${2:?usage: a9-red-proofs.sh <image-tag> <image-id> [table.json]}"
TABLE="${3:-docker/reviewer/runtime-matrix.json}"
HERE="$(cd "$(dirname "$0")" && pwd)"

SCRATCH="$(mktemp -d)"
TAGS=()
cleanup() {
  for t in "${TAGS[@]+"${TAGS[@]}"}"; do docker rmi -f "$t" >/dev/null 2>&1; done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

PROOFS=0
FAILURES=0
proof() { # <name> <expected FAIL message> <Dockerfile instruction>
  local name="$1" expect="$2" instruction="$3" tag="reviewer-a9-red:$1" out rc
  PROOFS=$((PROOFS + 1))
  TAGS+=("$tag")
  if ! printf 'FROM %s\nUSER root\n%s\nUSER reviewer\n' "$IMG" "$instruction" | docker build -q -t "$tag" - >/dev/null 2>"$SCRATCH/$name.err"; then
    echo "FAIL  red proof ${name}: the derived image did not build: $(tail -n 3 "$SCRATCH/$name.err")"
    FAILURES=$((FAILURES + 1))
    return
  fi
  out="$(bash "$HERE/image-checks.sh" "$tag" "$ID" "$TABLE" A9 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -qF "FAIL  ${expect}"; then
    echo "PASS  red proof ${name}: A9 exits ${rc} with \"${expect}\""
  else
    echo "FAIL  red proof ${name}: image-checks A9 exited ${rc}; expected a FAIL line \"${expect}\""
    printf '%s\n' "$out" | sed 's/^/      /'
    FAILURES=$((FAILURES + 1))
  fi
}

proof gh-config "A9 a gh config directory exists in the image" \
  'RUN mkdir -p "$XDG_CONFIG_HOME/gh" && printf "github.com:\n    oauth_token: gho_A9REDPROOFFAKE\n    user: a9-red-proof\n" > "$XDG_CONFIG_HOME/gh/hosts.yml" && chown -R reviewer /tmp/review'
proof git-extraheader "A9 git credential config" \
  'RUN git config --system http.https://github.com/.extraheader "AUTHORIZATION: basic YTlyZWRwcm9vZjpmYWtl"'
proof git-credential-helper "A9 git credential config" \
  'RUN git config --system credential.helper store'
proof git-insteadof-token "A9 git credential config" \
  'RUN u=x-access-token t=ghs_A9REDPROOFFAKE; git config --system url."https://$u:$t@github.com/".insteadOf "https://github.com/"'
proof env-gh-token "A9 GH_TOKEN present in the image environment" \
  'ENV GH_TOKEN=ghp_A9REDPROOFFAKE'

echo "== ${PROOFS} red proofs, ${FAILURES} failures =="
[ "$PROOFS" -eq 5 ] && [ "$FAILURES" -eq 0 ]
