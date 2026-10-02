#!/usr/bin/env bash
# per-job-isolation-checks.sh — each job of a `needs` closure gets a fresh,
# isolated tree and process space (tpsdev-ai/cli#435).
#
# Runs on a Docker-capable x86_64 host with the reviewer image and node. It
# builds one workflow with two jobs linked by `needs`:
#   build  — changes a tracked file, changes .git state (a new ref and the
#            index), and leaves a detached background process (setsid) writing a
#            heartbeat into a shared evidence directory;
#   review — needs: build. It records what it sees of build's changes: git
#            status, the tracked file, the new ref, the index, and whether the
#            heartbeat is still growing (the process is still alive).
# The host driver (run-review-jobs.mjs) runs one sandbox container per job, from
# a fresh clone of a read-only bare source. review must see a pristine tree and
# a dead heartbeat. The driver's workflow parser (js-yaml) is taken from the
# image, not the checkout, so this check needs no node_modules in the repository.
#
# Usage: per-job-isolation-checks.sh <image-tag> <image-id>
set -uo pipefail

IMG="${1:?usage: per-job-isolation-checks.sh <image-tag> <image-id>}"
ID="${2:?usage: per-job-isolation-checks.sh <image-tag> <image-id>}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

FAILURES=0
CHECKS=0
pass() { CHECKS=$((CHECKS + 1)); echo "PASS  $1"; }
fail() { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); echo "FAIL  $1"; }

SCRATCH="$(mktemp -d)"
cleanup() {
  for c in $(docker ps -aq --filter "label=tps.reviewer.job" 2>/dev/null); do docker rm -f "$c" >/dev/null 2>&1; done
  chmod -R u+w "$SCRATCH" 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "FAIL  image $IMG is not present"
  exit 1
fi
NODE_V="$(docker run --rm "$IMG" node -v | sed 's/^v//')"
NODE_RANGE="${NODE_V%%.*}.x"
BUN_V="$(docker run --rm "$IMG" bun --version)"
echo "== per-job isolation checks: $IMG (id $ID; node $NODE_V, bun $BUN_V) =="

CHECKOUT_REF="actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683"
SETUP_BUN_REF="oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76"

# ── fixture: a read-only bare source with a two-job `needs` workflow ─────────

src="$SCRATCH/src"
mkdir -p "$src/.github/workflows"
printf '{"name":"per-job-fixture","private":true,"packageManager":"bun@%s","engines":{"node":"%s"}}\n' "$BUN_V" "$NODE_RANGE" >"$src/package.json"
printf 'original\n' >"$src/tracked.txt"
cat >"$src/.github/workflows/review.yml" <<'YAML'
name: per-job fixture
on:
  pull_request:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: @CHECKOUT@
        with:
          persist-credentials: false
      - uses: @SETUP_BUN@
        with:
          bun-version: "@BUN_V@"
      - name: change the tree, .git and leave a detached process
        run: |
          echo changed > tracked.txt
          git update-ref refs/heads/job1-marker HEAD
          echo staged > staged.txt
          git add staged.txt
          setsid sh -c 'i=0; while [ $i -lt 100000 ]; do echo tick >> /evidence/job1-alive; i=$((i+1)); sleep 0.2; done' >/dev/null 2>&1 &
          sleep 1
          echo "build-done; heartbeat=$(wc -c < /evidence/job1-alive 2>/dev/null || echo 0) bytes"
  review:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: @CHECKOUT@
        with:
          persist-credentials: false
      - uses: @SETUP_BUN@
        with:
          bun-version: "@BUN_V@"
      - name: observe what build left behind
        run: |
          {
            echo "status=$(git status --porcelain=v1 | tr '\n' '|')"
            echo "tracked=$(cat tracked.txt 2>/dev/null)"
            echo "job1ref=$(git rev-parse --verify --quiet refs/heads/job1-marker >/dev/null 2>&1 && echo present || echo absent)"
            echo "staged=$(git diff --cached --name-only | tr '\n' '|')"
            echo "alive_before=$(wc -c < /evidence/job1-alive 2>/dev/null || echo 0)"
            sleep 1
            echo "alive_after=$(wc -c < /evidence/job1-alive 2>/dev/null || echo 0)"
          } > /evidence/job2.txt
YAML
sed -i -e "s/@BUN_V@/${BUN_V}/" -e "s#@CHECKOUT@#${CHECKOUT_REF}#" -e "s#@SETUP_BUN@#${SETUP_BUN_REF}#" "$src/.github/workflows/review.yml"
git -C "$src" init -q -b main
git -C "$src" add -A
git -C "$src" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture

git clone -q --bare "$src" "$SCRATCH/source.git"
chmod -R a-w "$SCRATCH/source.git"
mkdir -p "$SCRATCH/evidence"
chmod 0777 "$SCRATCH/evidence"

# ── run: one sandbox container per job ───────────────────────────────────────

# The driver imports js-yaml, the workflow parser. A checkout need not have its
# dependencies installed (the reviewer-image CI job installs none), so run the
# driver from a copy of the reviewer modules with the image's pinned js-yaml
# alongside it; the check then needs no dependencies from the checkout.
HOSTMOD="$SCRATCH/host"
mkdir -p "$HOSTMOD/scripts/reviewer" "$HOSTMOD/node_modules"
cp "$REPO"/scripts/reviewer/*.mjs "$HOSTMOD/scripts/reviewer/"
docker run --rm "$IMG" tar -cf - -C /opt/reviewer/lib node_modules/js-yaml | tar -xf - -C "$HOSTMOD"

node "$HOSTMOD/scripts/reviewer/run-review-jobs.mjs" \
  --image "$IMG" \
  --source "$SCRATCH/source.git" \
  --scratch "$SCRATCH/jobs" \
  --workflow .github/workflows/review.yml \
  --job review \
  --base main \
  --bind "$SCRATCH/evidence:/evidence" >"$SCRATCH/run.out" 2>"$SCRATCH/run.err"
RUN_RC=$?

if [ "$RUN_RC" -eq 0 ] && grep -q '"status":"review-build-ok"' "$SCRATCH/run.out"; then
  pass "the driver runs the needs closure one container per job to review-build-ok"
else
  fail "driver run: rc=${RUN_RC}"
  echo "---- driver stdout ----"
  sed 's/^/  /' "$SCRATCH/run.out" 2>/dev/null
  echo "---- driver stderr ----"
  sed 's/^/  /' "$SCRATCH/run.err" 2>/dev/null
  echo "---- end driver output ----"
fi

obs="$SCRATCH/evidence/job2.txt"
if [ -f "$obs" ]; then
  if grep -q '^status=$' "$obs"; then
    pass "job 2 sees no modified, untracked or ignored path (git status is clean)"
  else
    fail "job 2 tree: $(grep '^status=' "$obs")"
  fi
  if grep -qx 'tracked=original' "$obs"; then
    pass "job 2 sees the original tracked file, not job 1's change"
  else
    fail "job 2 tracked file: $(grep '^tracked=' "$obs")"
  fi
  if grep -qx 'job1ref=absent' "$obs"; then
    pass "job 2's .git has none of job 1's refs"
  else
    fail "job 2 ref: $(grep '^job1ref=' "$obs")"
  fi
  if grep -q '^staged=$' "$obs"; then
    pass "job 2's index has nothing staged"
  else
    fail "job 2 index: $(grep '^staged=' "$obs")"
  fi
  before="$(sed -n 's/^alive_before=//p' "$obs")"
  after="$(sed -n 's/^alive_after=//p' "$obs")"
  if [ -n "$before" ] && [ "$before" != "0" ] && [ "$before" = "$after" ]; then
    pass "job 1's detached (setsid) process wrote until job 1 ended, then stopped: not alive in job 2 (heartbeat ${before} bytes, unchanged)"
  else
    fail "job 1's detached process: before=${before:-?} after=${after:-?} (0 means the probe never wrote; a change means it survived into job 2)"
  fi
else
  fail "job 2 wrote no observations ($obs missing)"
fi

if [ -z "$(docker ps -aq --filter 'label=tps.reviewer.job' 2>/dev/null)" ]; then
  pass "no sandbox container is left behind"
else
  fail "leftover sandbox containers: $(docker ps -a --filter 'label=tps.reviewer.job' --format '{{.Names}}' | tr '\n' ' ')"
fi

if [ ! -e "$SCRATCH/jobs/build" ] && [ ! -e "$SCRATCH/jobs/review" ]; then
  pass "every job's directory is discarded"
else
  fail "a job directory survived: $(ls -d "$SCRATCH/jobs"/* 2>/dev/null | tr '\n' ' ')"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo "== $CHECKS checks, $FAILURES failures =="
[ "$CHECKS" -gt 0 ] && [ "$FAILURES" -eq 0 ]
