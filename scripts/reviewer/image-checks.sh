#!/usr/bin/env bash
# image-checks.sh — the image-level acceptance checks for the reviewer sandbox
# image (cli#425 acceptance A2, A3, A9). Runs on a Docker-capable x86_64 runner.
#
#   scripts/reviewer/image-checks.sh <image-tag> <image-id> [table.json] [sections]
#
# `sections` is any of "A2 A3 A9" (default: all three). Every check prints PASS
# or FAIL and the script exits non-zero if any check fails. A probe that
# produces no output is a FAILURE, never a quiet pass.
#
# The build-path fixtures run the container the way OpenClaw 2026.8.1 does —
# `docker create --init --read-only --tmpfs /tmp --tmpfs /var/tmp --tmpfs /run
# --network none --cap-drop ALL --security-opt no-new-privileges --workdir
# /workspace -v <worktree>:/workspace --env-file <env> <image> sleep infinity`,
# then `docker exec` of /opt/reviewer/bin/reviewer-launch — so the launcher is
# proven under the real run model, not a friendlier one.
set -uo pipefail

IMG="${1:?usage: image-checks.sh <image-tag> <image-id> [table.json] [sections]}"
ID="${2:?usage: image-checks.sh <image-tag> <image-id> [table.json] [sections]}"
TABLE="${3:-docker/reviewer/runtime-matrix.json}"
SECTIONS="${4:-A2 A3 A9}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

FAILURES=0
CHECKS=0
pass() { CHECKS=$((CHECKS + 1)); echo "PASS  $1"; }
fail() { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); echo "FAIL  $1"; }
want() { case " $SECTIONS " in *" $1 "*) return 0 ;; esac; return 1; }
run() { docker run --rm "$@" 2>/dev/null; }

SCRATCH="$(mktemp -d)"
CONTAINERS=()
cleanup() {
  for c in "${CONTAINERS[@]+"${CONTAINERS[@]}"}"; do docker rm -f "$c" >/dev/null 2>&1; done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

read_table() {
  node -e '
    const fs = require("fs");
    const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const i = (t.images || []).find((x) => x.id === process.argv[2]);
    if (!i) { process.stderr.write("no such image id: " + process.argv[2] + "\n"); process.exit(2); }
    const major = (v) => v.split(".")[0];
    const other = (t.images || []).find((x) => x.id !== i.id && x.bun === i.bun && major(x.node) !== major(i.node));
    process.stdout.write([i.node, i.bun, i.gh, other ? other.node : "-"].join(" "));
  ' "$TABLE" "$ID"
}
read -r NODE_V BUN_V GH_V OTHER_NODE_V <<<"$(read_table)"
if [ -z "${NODE_V:-}" ] || [ -z "${BUN_V:-}" ]; then echo "FAIL  cannot read image $ID from $TABLE"; exit 1; fi

echo "== reviewer image checks: $IMG (id $ID; sections: $SECTIONS) =="

envdump="$(run "$IMG" env)"
if [ -z "$envdump" ]; then fail "environment inspection produced no output"; fi

# ── the OpenClaw run model ───────────────────────────────────────────────────

# A reviewed-commit workspace: package.json pins bun and the given node range;
# the named job records the effective environment, then writes the marker.
make_fixture() { # <name> <engines.node range>
  local dir="$SCRATCH/$1"
  mkdir -p "$dir/.github/workflows"
  printf '{"name":"reviewer-fixture","private":true,"packageManager":"bun@%s","engines":{"node":"%s"}}\n' "$BUN_V" "$2" >"$dir/package.json"
  cat >"$dir/.github/workflows/review.yml" <<'YAML'
name: reviewer fixture
on: push
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "@BUN_V@"
      - name: record the effective environment
        run: |
          {
            echo "HOME=$HOME"
            echo "TMPDIR=$TMPDIR"
            echo "XDG_CACHE_HOME=$XDG_CACHE_HOME"
            echo "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"
            echo "npm_config_cache=$npm_config_cache"
            echo "BUN_INSTALL_CACHE_DIR=$BUN_INSTALL_CACHE_DIR"
            echo "CI=$CI"
            echo "home_fs=$(stat -f -c %T "$HOME")"
            echo "tmp_fs=$(stat -f -c %T "$TMPDIR")"
            echo "cache_fs=$(stat -f -c %T "$BUN_INSTALL_CACHE_DIR")"
            echo "node=$(node --version)"
            echo "bun=$(bun --version)"
            touch "$HOME/.probe" "$TMPDIR/probe" "$BUN_INSTALL_CACHE_DIR/probe" && echo "writable=yes"
            echo "tmp_mount=$(grep -E '^[^ ]+ /tmp ' /proc/mounts || true)"
            echo "leaked=$(env | cut -d= -f1 | grep -E '^(FOO_SECRET|NPM_TOKEN|NODE_AUTH_TOKEN|GIT_CONFIG_|GH_TOKEN|GITHUB_TOKEN|REVIEWER_)' | tr '\n' ' ' || true)"
          } > review-env.txt
      - name: marker
        run: echo ran > review-marker
YAML
  sed -i "s/@BUN_V@/${BUN_V}/" "$dir/.github/workflows/review.yml"
  # The container user (uid 1000) must be able to write the marker into the bind.
  chmod 0777 "$dir"
  chmod -R a+rX "$dir"
}

# Create the sandbox exactly as OpenClaw does, exec the launcher with a polluted
# parent environment, and keep its stdout/stderr, filesystem diff and mounts.
openclaw_launch() { # <name>
  local name="$1" dir="$SCRATCH/$1" cid
  printf 'REVIEWER_CI_WORKFLOW=.github/workflows/review.yml\nREVIEWER_CI_JOB=review\n' >"$SCRATCH/$name.env"
  LAUNCH_RC=125
  cid="$(docker create --init --read-only --tmpfs /tmp --tmpfs /var/tmp --tmpfs /run \
    --network none --cap-drop ALL --security-opt no-new-privileges \
    --workdir /workspace -v "$dir:/workspace" --env-file "$SCRATCH/$name.env" \
    "$IMG" sleep infinity 2>"$SCRATCH/$name.create.err")" || return 0
  CONTAINERS+=("$cid")
  docker start "$cid" >/dev/null 2>&1 || return 0
  docker exec \
    -e FOO_SECRET=canary-foo-secret -e NPM_TOKEN=canary-npm-token -e NODE_AUTH_TOKEN=canary-node-auth \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=credential.helper -e GIT_CONFIG_VALUE_0=store \
    "$cid" /opt/reviewer/bin/reviewer-launch >"$SCRATCH/$name.out" 2>"$SCRATCH/$name.err"
  LAUNCH_RC=$?
  docker diff "$cid" >"$SCRATCH/$name.diff" 2>&1
  docker inspect --format '{{json .Mounts}}' "$cid" >"$SCRATCH/$name.mounts" 2>&1
}

# ── A2: runtime + image integrity ────────────────────────────────────────────
if want A2; then
  got_node="$(run "$IMG" node -v)"
  [ "$got_node" = "v${NODE_V}" ] && pass "A2 node version is ${NODE_V}" || fail "A2 node version: got '${got_node}', want v${NODE_V}"

  got_bun="$(run "$IMG" bun --version)"
  [ "$got_bun" = "${BUN_V}" ] && pass "A2 bun version is ${BUN_V}" || fail "A2 bun version: got '${got_bun}', want ${BUN_V}"

  got_gh="$(run "$IMG" gh --version | head -n1)"
  echo "$got_gh" | grep -q "gh version ${GH_V}" && pass "A2 gh version is ${GH_V}" || fail "A2 gh version: got '${got_gh}', want gh version ${GH_V}"

  platform="$(docker inspect --format '{{.Os}}/{{.Architecture}}' "$IMG" 2>/dev/null)"
  [ "$platform" = "linux/amd64" ] && pass "A2 image platform is linux/amd64" || fail "A2 image platform: got '${platform}', want linux/amd64"

  entrypoint="$(docker inspect --format '{{json .Config.Entrypoint}}' "$IMG" 2>/dev/null)"
  cmd="$(docker inspect --format '{{json .Config.Cmd}}' "$IMG" 2>/dev/null)"
  if [ "$entrypoint" = "null" ] && [ "$cmd" = '["sleep","infinity"]' ]; then
    pass "A2 no entrypoint; CMD is sleep infinity (the OpenClaw run model)"
  else
    fail "A2 entrypoint/cmd: entrypoint=${entrypoint} cmd=${cmd}"
  fi

  img_table_sha="$(run "$IMG" sha256sum /opt/reviewer/runtime-matrix.json | cut -d' ' -f1)"
  host_table_sha="$(sha256sum "$TABLE" | cut -d' ' -f1)"
  [ -n "$img_table_sha" ] && [ "$img_table_sha" = "$host_table_sha" ] && pass "A2 image carries the trusted runtime table" || fail "A2 image table differs from the host table (img='${img_table_sha}', host='${host_table_sha}')"

  for f in reviewer-launch.mjs resolve-runtime.mjs ci-job.mjs; do
    a="$(run "$IMG" sha256sum "/opt/reviewer/lib/$f" | cut -d' ' -f1)"
    b="$(sha256sum "$REPO/scripts/reviewer/$f" | cut -d' ' -f1)"
    [ -n "$a" ] && [ "$a" = "$b" ] && pass "A2 image carries this commit's $f" || fail "A2 image $f differs (img='$a', repo='$b')"
  done

  baked="$(run "$IMG" cat /opt/reviewer/image-id)"
  [ "$baked" = "$ID" ] && pass "A2 baked image identity is $ID" || fail "A2 baked image identity: got '${baked}', want ${ID}"

  local_id="$(docker inspect --format '{{.Id}}' "$IMG" 2>/dev/null)"
  echo "$local_id" | grep -Eq '^sha256:[0-9a-f]{64}$' && pass "A2 local image id recorded: ${local_id}" || fail "A2 local image id not readable"

  self="$(run "$IMG" /opt/reviewer/bin/reviewer-launch --self-check)"
  if echo "$self" | grep -q '"status":"self-check-ok"' && echo "$self" | grep -q "\"image_id\":\"${ID}\""; then
    pass "A2 launcher self-check verifies the actual runtimes against the baked entry"
  else
    fail "A2 launcher self-check: '${self}'"
  fi

  # The image's own resolver: named refusals.
  resolver() { # <input-json> -> prints "kind|message", rc 3 on refusal
    docker run --rm -e RES_INPUT="$1" "$IMG" node --input-type=module -e '
      const { resolveRuntime } = await import("/opt/reviewer/lib/resolve-runtime.mjs");
      const fs = await import("node:fs");
      const table = JSON.parse(fs.readFileSync("/opt/reviewer/runtime-matrix.json", "utf8"));
      const r = resolveRuntime({ table, ...JSON.parse(process.env.RES_INPUT) });
      if (!r.ok) { process.stdout.write(r.refusal.kind + "|" + r.refusal.message); process.exit(3); }
      process.stdout.write("ok|" + r.image.id);
    ' 2>&1
  }
  missing="missing image: node >=25 with bun ${BUN_V}"
  out="$(resolver "{\"manifest\":{\"packageManager\":\"bun@${BUN_V}\",\"engines\":{\"node\":\">=25\"}}}")"; rc=$?
  if [ $rc -eq 3 ] && echo "$out" | grep -q '^out-of-matrix|' && echo "$out" | grep -qF "$missing"; then pass "A2 out-of-matrix refusal names the missing image ($missing)"; else fail "A2 out-of-matrix refusal (rc=$rc, out=$out)"; fi

  out="$(resolver '{"manifest":{"engines":{"node":">=22"}}}')"; rc=$?
  if [ $rc -eq 3 ] && echo "$out" | grep -q '^ambiguous|'; then pass "A2 a range matching two trusted versions refuses as ambiguous"; else fail "A2 ambiguous requirement (rc=$rc, out=$out)"; fi

  out="$(resolver "{\"manifest\":{\"packageManager\":\"bun@${BUN_V}\"}}")"; rc=$?
  if [ $rc -eq 3 ] && echo "$out" | grep -q '^ambiguous|' && echo "$out" | grep -qF "matches more than one image"; then pass "A2 a bun-only repository refuses as image-level ambiguous"; else fail "A2 image-level ambiguity (rc=$rc, out=$out)"; fi

  out="$(resolver "{\"manifest\":{},\"runtimeFiles\":{\".bun-version\":\"latest\",\".nvmrc\":\"${NODE_V}\"}}")"; rc=$?
  if [ $rc -eq 3 ] && echo "$out" | grep -q '^ambiguous|'; then pass "A2 a floating 'latest' pin refuses"; else fail "A2 'latest' pin (rc=$rc, out=$out)"; fi

  if [ "$OTHER_NODE_V" != "-" ]; then
    out="$(resolver "{\"manifest\":{\"engines\":{\"node\":\"${NODE_V}\"}},\"runtimeFiles\":{\".nvmrc\":\"${OTHER_NODE_V}\"}}")"; rc=$?
    if [ $rc -eq 3 ] && echo "$out" | grep -q '^conflicting|'; then pass "A2 conflicting requirements refuse"; else fail "A2 conflicting requirements (rc=$rc, out=$out)"; fi
  else
    fail "A2 the matrix has no second node image with bun ${BUN_V}: the conflicting and wrong-image fixtures cannot be built"
  fi

  # The build path, as OpenClaw runs it: an out-of-matrix pin must stop the
  # launcher before any step runs (no marker); a pin that resolves to ANOTHER
  # matrix image must too; an in-matrix pin for THIS image runs the job.
  make_fixture oom ">=25"
  openclaw_launch oom
  if [ "$LAUNCH_RC" -ne 0 ] && [ "$LAUNCH_RC" -ne 125 ] && grep -q "refused: out-of-matrix" "$SCRATCH/oom.err" && grep -qF "$missing" "$SCRATCH/oom.err" && [ ! -e "$SCRATCH/oom/review-marker" ]; then
    pass "A2 build path: an out-of-matrix pin exits ${LAUNCH_RC}, names '${missing}', runs nothing"
  else
    fail "A2 build path out-of-matrix: rc=${LAUNCH_RC} marker=$([ -e "$SCRATCH/oom/review-marker" ] && echo present || echo absent) err=$(cat "$SCRATCH/oom.err" "$SCRATCH/oom.create.err" 2>/dev/null | tail -n 3)"
  fi

  if [ "$OTHER_NODE_V" != "-" ]; then
    make_fixture wrong "${OTHER_NODE_V%%.*}.x"
    openclaw_launch wrong
    if [ "$LAUNCH_RC" -ne 0 ] && [ "$LAUNCH_RC" -ne 125 ] && grep -q "refused: wrong-image" "$SCRATCH/wrong.err" && [ ! -e "$SCRATCH/wrong/review-marker" ]; then
      pass "A2 build path: a pin resolving to another matrix image exits ${LAUNCH_RC} (wrong-image), runs nothing"
    else
      fail "A2 build path wrong-image: rc=${LAUNCH_RC} err=$(cat "$SCRATCH/wrong.err" "$SCRATCH/wrong.create.err" 2>/dev/null | tail -n 3)"
    fi
  fi
fi

# The in-matrix run feeds both A2 (it builds) and A3 (what it saw).
if want A2 || want A3; then
  make_fixture ok "${NODE_V%%.*}.x"
  openclaw_launch ok
  OK_RC=$LAUNCH_RC
fi

if want A2; then
  if [ "$OK_RC" -eq 0 ] && grep -q '"status":"review-build-ok"' "$SCRATCH/ok.out" && [ -e "$SCRATCH/ok/review-marker" ] \
    && grep -q '"uses":"actions/checkout@v4"' "$SCRATCH/ok.out" && grep -q '"uses":"oven-sh/setup-bun@v2"' "$SCRATCH/ok.out"; then
    pass "A2 build path: an in-matrix pin runs the named job to review-build-ok and writes the marker; skipped actions are named"
  else
    fail "A2 build path in-matrix: rc=${OK_RC} out=$(cat "$SCRATCH/ok.out" 2>/dev/null) err=$(cat "$SCRATCH/ok.err" "$SCRATCH/ok.create.err" 2>/dev/null | tail -n 5)"
  fi
  seen="$SCRATCH/ok/review-env.txt"
  grep -qx "node=v${NODE_V}" "$seen" 2>/dev/null && grep -qx "bun=${BUN_V}" "$seen" 2>/dev/null \
    && pass "A2 the job's steps ran node ${NODE_V} and bun ${BUN_V}" || fail "A2 runtimes seen by the job: $(grep -E '^(node|bun)=' "$seen" 2>/dev/null | tr '\n' ' ')"
fi

# ── A3: hermetic defaults ────────────────────────────────────────────────────
if want A3; then
  hermetic="$(run "$IMG" node --input-type=module -e 'const m = await import("/opt/reviewer/lib/reviewer-launch.mjs"); for (const [k, v] of Object.entries(m.HERMETIC)) console.log(k + "=" + v);')"
  if [ -z "$hermetic" ]; then
    fail "A3 the launcher's hermetic layout could not be read from the image"
  else
    while IFS= read -r line; do
      printf '%s\n' "$envdump" | grep -qxF "$line" && pass "A3 image default ${line}" || fail "A3 image default: '${line}' is not in the image environment"
    done <<<"$hermetic"
  fi

  if printf '%s\n' "$envdump" | grep -E '=(/home/runner|/Users/|/root/|/home/reviewer)' >/dev/null; then
    fail "A3 a host or read-only home path appears in the default environment"
  else
    pass "A3 no host path in the default environment"
  fi

  cid="$(docker create "$IMG" 2>/dev/null)"
  mounts="$(docker inspect --format '{{json .Mounts}}' "$cid" 2>/dev/null)"
  binds="$(docker inspect --format '{{json .HostConfig.Binds}}' "$cid" 2>/dev/null)"
  docker rm "$cid" >/dev/null 2>&1
  [ "$mounts" = "[]" ] && [ "$binds" = "null" ] && pass "A3 the image declares no mounts" || fail "A3 default mounts: $mounts binds: $binds"

  seen="$SCRATCH/ok/review-env.txt"
  if [ "$OK_RC" -ne 0 ] || [ ! -s "$seen" ]; then
    fail "A3 the in-matrix build did not run, so the effective environment was not observed (rc=${OK_RC})"
  else
    for kv in HOME=/tmp/review/home TMPDIR=/tmp/review/tmp XDG_CACHE_HOME=/tmp/review/cache XDG_CONFIG_HOME=/tmp/review/config \
      npm_config_cache=/tmp/review/cache/npm BUN_INSTALL_CACHE_DIR=/tmp/review/cache/bun CI=true \
      home_fs=tmpfs tmp_fs=tmpfs cache_fs=tmpfs writable=yes; do
      grep -qxF "$kv" "$seen" && pass "A3 inside the build: ${kv}" || fail "A3 inside the build: want ${kv}, saw '$(grep -E "^${kv%%=*}=" "$seen")'"
    done
    # Evidence, not a check: the /tmp mount options the OpenClaw defaults give a
    # step (a noexec /tmp breaks suites that execute files from TMPDIR).
    echo "INFO  /tmp inside the OpenClaw-style sandbox: $(sed -n 's/^tmp_mount=//p' "$seen")"
    grep -qxE 'leaked= *' "$seen" && pass "A3 no parent variable reached a step (FOO_SECRET, NPM_TOKEN, NODE_AUTH_TOKEN, GIT_CONFIG_*, REVIEWER_*)" || fail "A3 parent variables reached a step: $(grep '^leaked=' "$seen")"
  fi

  # Only the worktree is bound; nothing else persisted in the container.
  if node -e '
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(m.length === 1 && m[0].Type === "bind" && m[0].Destination === "/workspace" ? 0 : 1);
    ' "$SCRATCH/ok.mounts" 2>/dev/null; then
    pass "A3 the worktree at /workspace is the only bind"
  else
    fail "A3 mounts of the OpenClaw-style container: $(cat "$SCRATCH/ok.mounts" 2>/dev/null)"
  fi
  if [ -f "$SCRATCH/ok.diff" ]; then
    persisted="$(grep -vE ' /(workspace|tmp|var/tmp|run|dev|proc|sys)(/|$)| /etc/(hosts|hostname|resolv\.conf)$' "$SCRATCH/ok.diff")"
    [ -z "$persisted" ] && pass "A3 nothing persisted outside the worktree bind and the tmpfs mounts" || fail "A3 container filesystem changes: ${persisted}"
  else
    fail "A3 the container diff was not captured"
  fi
fi

# ── A9: tokenless gh ─────────────────────────────────────────────────────────
if want A9; then
  if docker run --rm "$IMG" gh auth status >/dev/null 2>&1; then
    fail "A9 gh is authenticated in the image"
  else
    pass "A9 gh auth status reports no authentication"
  fi
  if docker run --rm "$IMG" gh auth token >/dev/null 2>&1; then
    fail "A9 gh produced a token"
  else
    pass "A9 gh produces no token"
  fi

  for var in GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN; do
    if printf '%s\n' "$envdump" | grep -q "^${var}="; then fail "A9 ${var} present in the image environment"; else pass "A9 ${var} absent from the image environment"; fi
  done

  if docker run --rm "$IMG" sh -c 'test -e "${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}" || test -e "$HOME/.config/gh" || test -e /home/reviewer/.config/gh' >/dev/null 2>&1; then
    fail "A9 a gh config directory exists in the image"
  else
    pass "A9 no gh config directory in the image"
  fi

  gitcreds="$(docker run --rm "$IMG" sh -c 'git config --list --show-origin 2>/dev/null | grep -iE "credential|extraheader|authorization|://[^/@[:space:]]+@"' 2>/dev/null)"
  if [ -n "$gitcreds" ]; then fail "A9 git credential config: $gitcreds"; else pass "A9 git has no credential helper, auth header or token URL configured"; fi
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo "== $CHECKS checks, $FAILURES failures =="
[ "$CHECKS" -gt 0 ] && [ "$FAILURES" -eq 0 ]
