#!/usr/bin/env bash
# test-check-bun-pin.sh — executable fails-first fixtures for check-bun-pin.sh
# (cli#578).
#
# The gate's evidence base must be re-run, not asserted in prose: this harness
# builds each fixture in a temp tree and asserts the gate's exit code, so a
# weakened gate fails its own fixtures. It also asserts
# .github/workflows/test.yml still invokes the gate (and the fixtures), so
# dropping the invocation is caught here.
#
# Every fixture below MUST FAIL the gate (exit non-zero); the positive controls
# (the real repo, and a synthetic correct tree) MUST pass.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
gate="$here/check-bun-pin.sh"
helper="$here/docker-bun-version.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

npass=0
nfail=0

mk() { mkdir -p "$work/$1/scripts" "$work/$1/.github/workflows"; echo "$work/$1"; }

good_pkg() { printf '{\n  "name": "x",\n  "packageManager": "bun@1.3.10"\n}\n' >"$1/package.json"; }
good_helper() { cp "$helper" "$1/scripts/docker-bun-version.sh"; }
good_docker() {
  cat >"$1/Dockerfile.test" <<'EOF'
ARG BUN_VERSION
FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app
EOF
}
good_compose() {
  cat >"$1/docker-compose.yml" <<'EOF'
services:
  a:
    build:
      context: .
      dockerfile: Dockerfile.test
      args:
        BUN_VERSION: "${BUN_VERSION:?set the repository pin}"
  b:
    build:
      context: .
      dockerfile: Dockerfile.test
      args:
        BUN_VERSION: "${BUN_VERSION:?set the repository pin}"
EOF
}
good_workflow() {
  cat >"$1/.github/workflows/test.yml" <<'EOF'
jobs:
  docker:
    steps:
      - name: Pin the container Bun
        run: |
          v="$(./scripts/docker-bun-version.sh)"
          echo "BUN_VERSION=$v" >> "$GITHUB_ENV"
EOF
}
good_all() { good_pkg "$1"; good_helper "$1"; good_docker "$1"; good_compose "$1"; good_workflow "$1"; }

run_case() { # <name> <expect:pass|fail> <fixture-dir>
  local name="$1" expect="$2" dir="$3" rc=0
  SCRIPTS_ROOT="$dir" bash "$gate" >/dev/null 2>&1 || rc=$?
  if { [ "$expect" = fail ] && [ "$rc" -ne 0 ]; } || { [ "$expect" = pass ] && [ "$rc" -eq 0 ]; }; then
    printf 'PASS  %-28s gate exited %s (expected %s)\n' "$name" "$rc" "$expect"
    npass=$((npass + 1))
  else
    printf 'FAIL  %-28s gate exited %s (expected %s)\n' "$name" "$rc" "$expect"
    nfail=$((nfail + 1))
  fi
}

# ── Positive control: the real repository must pass ──────────────────────────
rc=0
bash "$gate" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  printf 'PASS  %-28s gate exited 0 (expected pass)\n' "real-tree (control)"; npass=$((npass + 1))
else
  printf 'FAIL  %-28s gate exited %s (expected pass)\n' "real-tree (control)" "$rc"; nfail=$((nfail + 1))
fi

# ── Positive control: a synthetic correct tree must pass ─────────────────────
d="$(mk synthetic-good)"; good_all "$d"
run_case "synthetic-good" pass "$d"

# ── 1. Dockerfile reverts to the floating tag ────────────────────────────────
d="$(mk docker-literal-tag)"; good_all "$d"
printf 'FROM oven/bun:1-slim\nWORKDIR /app\n' >"$d/Dockerfile.test"
run_case "docker-literal-tag" fail "$d"

# ── 2. ARG BUN_VERSION gains a default (a silent version of its own) ─────────
d="$(mk docker-arg-default)"; good_all "$d"
printf 'ARG BUN_VERSION=1.3.10\nFROM oven/bun:${BUN_VERSION}-slim\n' >"$d/Dockerfile.test"
run_case "docker-arg-default" fail "$d"

# ── 3. The ARG is dropped; the FROM still references it ──────────────────────
d="$(mk docker-arg-missing)"; good_all "$d"
printf 'FROM oven/bun:${BUN_VERSION}-slim\nWORKDIR /app\n' >"$d/Dockerfile.test"
run_case "docker-arg-missing" fail "$d"

# ── 4. A compose build stops forwarding BUN_VERSION ──────────────────────────
d="$(mk compose-arg-missing)"; good_all "$d"
cat >"$d/docker-compose.yml" <<'EOF'
services:
  a:
    build:
      context: .
      dockerfile: Dockerfile.test
      args:
        BUN_VERSION: "${BUN_VERSION:?set the repository pin}"
  b:
    build:
      context: .
      dockerfile: Dockerfile.test
EOF
run_case "compose-arg-missing" fail "$d"

# ── 5. A compose forward is optional — an unset value would not refuse ───────
d="$(mk compose-optional-arg)"; good_all "$d"
cat >"$d/docker-compose.yml" <<'EOF'
services:
  a:
    build:
      context: .
      dockerfile: Dockerfile.test
      args:
        BUN_VERSION: "${BUN_VERSION}"
  b:
    build:
      context: .
      dockerfile: Dockerfile.test
      args:
        BUN_VERSION: "${BUN_VERSION}"
EOF
run_case "compose-optional-arg" fail "$d"

# ── 6. The workflow stops deriving the version from package.json ─────────────
d="$(mk workflow-no-derive)"; good_all "$d"
cat >"$d/.github/workflows/test.yml" <<'EOF'
jobs:
  docker:
    steps:
      - name: Run tests in Docker
        run: docker compose run --rm test
EOF
run_case "workflow-no-derive" fail "$d"

# ── 7. The workflow hardcodes BUN_VERSION (disagrees with the pin) ───────────
d="$(mk workflow-hardcoded)"; good_all "$d"
cat >"$d/.github/workflows/test.yml" <<'EOF'
jobs:
  docker:
    env:
      BUN_VERSION: "1.4.2"
    steps:
      - name: Run tests in Docker
        run: docker compose run --rm test
EOF
run_case "workflow-hardcoded" fail "$d"

# ── 8. package.json's packageManager is malformed ────────────────────────────
d="$(mk pin-malformed)"; good_all "$d"
printf '{\n  "packageManager": "bun@1.3"\n}\n' >"$d/package.json"
run_case "pin-malformed" fail "$d"

# ── 9. The helper disagrees with package.json ────────────────────────────────
d="$(mk helper-disagrees)"; good_all "$d"
printf '#!/usr/bin/env bash\necho 9.9.9\n' >"$d/scripts/docker-bun-version.sh"
run_case "helper-disagrees" fail "$d"

# ── Regression guard: the CI workflow must still invoke the gate + fixtures ──
if grep -qF './scripts/check-bun-pin.sh' "$repo_root/.github/workflows/test.yml"; then
  printf 'PASS  %-28s test.yml invokes check-bun-pin.sh\n' "workflow-invokes-gate"; npass=$((npass + 1))
else
  printf 'FAIL  %-28s test.yml no longer invokes check-bun-pin.sh\n' "workflow-invokes-gate"; nfail=$((nfail + 1))
fi
if grep -qF './scripts/test-check-bun-pin.sh' "$repo_root/.github/workflows/test.yml"; then
  printf 'PASS  %-28s test.yml invokes the fixtures\n' "workflow-invokes-fixtures"; npass=$((npass + 1))
else
  printf 'FAIL  %-28s test.yml no longer invokes the fixtures\n' "workflow-invokes-fixtures"; nfail=$((nfail + 1))
fi

printf '\ntest-check-bun-pin: %d passed, %d failed\n' "$npass" "$nfail"
[ "$nfail" -eq 0 ]
