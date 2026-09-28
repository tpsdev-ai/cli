#!/usr/bin/env bash
# image-checks.sh — the image-level acceptance checks for the reviewer sandbox
# image (cli#425 acceptance A2, A3, A9). Runs on a Docker-capable CI runner.
#
#   scripts/reviewer/image-checks.sh <image-tag> <image-id> [table.json]
#
# Every check prints PASS or FAIL and the script exits non-zero if any check
# fails OR is skipped. Probes override the image ENTRYPOINT (the launcher) so a
# raw command is run as-is; a probe that produces no output is a FAILURE, never
# a quiet pass.
set -uo pipefail

IMG="${1:?usage: image-checks.sh <image-tag> <image-id> [table.json]}"
ID="${2:?usage: image-checks.sh <image-tag> <image-id> [table.json]}"
TABLE="${3:-docker/reviewer/runtime-matrix.json}"

FAILURES=0
CHECKS=0
pass() { CHECKS=$((CHECKS + 1)); echo "PASS  $1"; }
fail() { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); echo "FAIL  $1"; }
run() { docker run --rm "$@" 2>/dev/null; }

read_table() {
  node -e '
    const fs = require("fs"), path = require("path");
    const t = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), process.argv[1]), "utf8"));
    const i = (t.images || []).find((x) => x.id === process.argv[2]);
    if (!i) { process.stderr.write("no such image id: " + process.argv[2]); process.exit(2); }
    process.stdout.write([t.artifacts.node[i.node].sha256, t.artifacts.bun[i.bun].sha256, t.artifacts.gh[i.gh].sha256, i.node, i.bun, i.gh].join(" "));
  ' "$TABLE" "$ID"
}

read -r NODE_SHA BUN_SHA GH_SHA NODE_V BUN_V GH_V <<<"$(read_table)"

echo "== reviewer image checks: $IMG (id $ID) =="

# ── A2: runtime + image integrity ────────────────────────────────────────────
got_node="$(run --entrypoint node "$IMG" -v)"
[ "$got_node" = "v${NODE_V}" ] && pass "A2 node version is ${NODE_V}" || fail "A2 node version: got '${got_node}', want v${NODE_V}"

got_bun="$(run --entrypoint bun "$IMG" --version)"
[ "$got_bun" = "${BUN_V}" ] && pass "A2 bun version is ${BUN_V}" || fail "A2 bun version: got '${got_bun}', want ${BUN_V}"

got_gh="$(run --entrypoint gh "$IMG" --version | head -n1)"
echo "$got_gh" | grep -q "gh version ${GH_V}" && pass "A2 gh version is ${GH_V}" || fail "A2 gh version: got '${got_gh}', want gh version ${GH_V}"

img_table_sha="$(run --entrypoint sha256sum "$IMG" /opt/reviewer/runtime-matrix.json | cut -d' ' -f1)"
host_table_sha="$(sha256sum "$TABLE" | cut -d' ' -f1)"
[ -n "$img_table_sha" ] && [ "$img_table_sha" = "$host_table_sha" ] && pass "A2 image carries the trusted runtime table" || fail "A2 image table differs from the host table (img='${img_table_sha}', host='${host_table_sha}')"

IMG_DIGEST="$(docker inspect --format '{{.Id}}' "$IMG" 2>/dev/null)"
[ -n "$IMG_DIGEST" ] && pass "A2 image digest recorded: ${IMG_DIGEST}" || fail "A2 image digest not recorded"

if run -e REVIEWER_IMAGE_ID="$ID" --entrypoint node "$IMG" /opt/reviewer/reviewer-launch.mjs --self-check --image "$ID" >/dev/null; then
  pass "A2 launcher self-check accepts the real image"
else
  fail "A2 launcher self-check rejected the real image"
fi

if run --entrypoint node "$IMG" /opt/reviewer/reviewer-launch.mjs --self-check --image "$ID" --require-node 99.0.0 >/dev/null; then
  fail "A2 an unsatisfiable runtime requirement was accepted"
else
  pass "A2 an unsatisfiable runtime requirement stops the build"
fi

# Resolver refusals: out-of-matrix names the missing image; ambiguous/conflicting refuse.
RESOLVER="$(pwd)/scripts/reviewer/resolve-runtime.mjs"
resolver_refuses() { # <input-json>
  RES_INPUT="$1" RES_RESOLVER="$RESOLVER" RES_TABLE="$TABLE" node --input-type=module -e '
    const { resolveRuntime, ciConstraintsFromLanes } = await import(process.env.RES_RESOLVER);
    const fs = await import("node:fs");
    const table = JSON.parse(fs.readFileSync(process.env.RES_TABLE, "utf8"));
    const input = JSON.parse(process.env.RES_INPUT);
    if (input.ciLanesText) input.ciConstraints = ciConstraintsFromLanes([{ file: "ci.yml", text: input.ciLanesText }]);
    const r = resolveRuntime({ table, ...input });
    if (!r.ok) { process.stdout.write(r.refusal.kind + "|" + r.refusal.message); process.exit(3); }
    process.exit(0);
  '
}

case_out="$(resolver_refuses '{"manifest":{"engines":{"node":">=25"}}}')"; rc=$?
if [ $rc -ne 0 ] && echo "$case_out" | grep -q "^out-of-matrix|" && echo "$case_out" | grep -qi "available images"; then pass "A2 out-of-matrix refusal names the missing image"; else fail "A2 out-of-matrix refusal (rc=$rc, out=$case_out)"; fi

case_out="$(resolver_refuses '{"manifest":{"engines":{"node":">=22"}}}')"; rc=$?
if [ $rc -ne 0 ] && echo "$case_out" | grep -q "^ambiguous|"; then pass "A2 ambiguous requirement refuses"; else fail "A2 ambiguous requirement (rc=$rc, out=$case_out)"; fi

case_out="$(resolver_refuses '{"manifest":{"engines":{"node":"22.22.1"}},"runtimeFiles":{".nvmrc":"24.21.0"}}')"; rc=$?
if [ $rc -ne 0 ] && echo "$case_out" | grep -q "^conflicting|"; then pass "A2 conflicting requirements refuse"; else fail "A2 conflicting requirements (rc=$rc, out=$case_out)"; fi

# ── A3: hermetic defaults ────────────────────────────────────────────────────
envdump="$(run --entrypoint env "$IMG")"
if [ -z "$envdump" ]; then fail "A3 environment inspection produced no output"; fi
envval() { printf '%s\n' "$envdump" | sed -n "s/^$1=//p" | head -n1; }
check_env() { # key expected
  local v; v="$(envval "$1")"
  [ "$v" = "$2" ] && pass "A3 $1=$2" || fail "A3 $1: got '$v', want '$2'"
}
check_env HOME /home/reviewer
check_env USERPROFILE /home/reviewer
check_env TMPDIR /tmp/review
check_env npm_config_cache /tmp/review/npm-cache
check_env BUN_INSTALL_CACHE_DIR /tmp/review/bun-cache
check_env XDG_CACHE_HOME /tmp/review/.cache

if printf '%s\n' "$envdump" | grep -E '=(/home/runner|/Users/|/root/)' >/dev/null; then
  fail "A3 a host path appears in the default environment"
else
  pass "A3 no host path in the default environment"
fi

cid="$(docker create "$IMG" 2>/dev/null)"
mounts="$(docker inspect --format '{{json .Mounts}}' "$cid" 2>/dev/null)"
binds="$(docker inspect --format '{{json .HostConfig.Binds}}' "$cid" 2>/dev/null)"
docker rm "$cid" >/dev/null 2>&1
[ "$mounts" = "[]" ] && [ "$binds" = "null" ] && pass "A3 default container has no bind mounts" || fail "A3 default mounts: $mounts binds: $binds"

# ── A9: tokenless gh ─────────────────────────────────────────────────────────
if docker run --rm --entrypoint gh "$IMG" auth status >/dev/null 2>&1; then
  fail "A9 gh is authenticated in the image"
else
  pass "A9 gh auth status reports no authentication"
fi
if docker run --rm --entrypoint gh "$IMG" auth token >/dev/null 2>&1; then
  fail "A9 gh produced a token"
else
  pass "A9 gh produces no token"
fi

for var in GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN; do
  if printf '%s\n' "$envdump" | grep -q "^${var}="; then fail "A9 ${var} present in the image environment"; else pass "A9 ${var} absent from the image environment"; fi
done

if docker run --rm --entrypoint sh "$IMG" -c 'test -e "$HOME/.config/gh"' >/dev/null 2>&1; then
  fail "A9 a gh config directory exists in the image"
else
  pass "A9 no gh config directory in the image"
fi

gitcreds="$(docker run --rm --entrypoint sh "$IMG" -c 'git config --list --show-origin 2>/dev/null | grep -i credential' 2>/dev/null)"
if [ -n "$gitcreds" ]; then fail "A9 git credential config: $gitcreds"; else pass "A9 git has no credential helper configured"; fi

# ── summary ──────────────────────────────────────────────────────────────────
echo "== $CHECKS checks, $FAILURES failures =="
[ "$FAILURES" -eq 0 ]
