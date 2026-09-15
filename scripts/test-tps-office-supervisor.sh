#!/usr/bin/env bash
# test-tps-office-supervisor.sh — fails-first checks for docker/tps-office-supervisor.sh
# (cli#341 S2).
#
# Part A (static, always runs): every nono invocation carries `--profile
# tps-office`; every agent launch goes through nono; the old UID-only fallback is
# gone (no code path starts an agent without nono).
#
# Part B (behavioural, needs root + bash + jq — run it inside the image):
# black-box against the script with a fake nono that logs its argv.
#   1. both `nono run` invocations carry `--profile tps-office`, and the agent
#      launch happens;
#   2. with nono ABSENT the supervisor exits non-zero, names nono, and starts no
#      agent.
#
#   docker run --rm -v "$PWD":/repo -w /repo --entrypoint bash <image> \
#     scripts/test-tps-office-supervisor.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
sup="$repo_root/docker/tps-office-supervisor.sh"

npass=0
nfail=0
ok()  { printf 'PASS  %s\n' "$1"; npass=$((npass + 1)); }
bad() { printf 'FAIL  %s\n' "$1" >&2; nfail=$((nfail + 1)); }

# ── Part A — static shape ────────────────────────────────────────────────────
nono_lines="$(grep -c 'nono run' "$sup" || true)"
if [ "$nono_lines" -ge 2 ]; then ok "found $nono_lines 'nono run' invocations"; else bad "expected >=2 'nono run' invocations, found $nono_lines"; fi

missing=0
while IFS= read -r l; do
  [ -z "$l" ] && continue
  case "$l" in *"--profile tps-office"*) ;; *) missing=$((missing + 1)) ;; esac
done < <(grep 'nono run' "$sup" || true)
if [ "$missing" -eq 0 ]; then ok "every 'nono run' carries --profile tps-office"; else bad "$missing 'nono run' invocation(s) lack --profile tps-office"; fi

launches="$(grep -n 'tps-agent start' "$sup" || true)"
if [ -z "$launches" ]; then
  bad "no 'tps-agent start' invocation found at all"
else
  bare=0
  while IFS= read -r l; do
    [ -z "$l" ] && continue
    case "$l" in *"nono run"*) ;; *) bare=$((bare + 1)) ;; esac
  done <<<"$launches"
  if [ "$bare" -eq 0 ]; then ok "every 'tps-agent start' launch goes through nono"; else bad "$bare 'tps-agent start' launch(es) do NOT go through nono"; fi
fi

if grep -qE 'exec tps-agent start' "$sup"; then bad "UID-only fallback ('exec tps-agent start' without nono) still present"; else ok "no bare 'exec tps-agent start' (UID-only fallback deleted)"; fi
if grep -qi 'falling back to UID isolation only' "$sup"; then bad "old UID-fallback message still present"; else ok "old UID-fallback message gone"; fi
if grep -q 'refusing to launch the agent without isolation' "$sup"; then ok "fail-closed refusal message present"; else bad "no fail-closed refusal message"; fi

# ── Part B — behavioural ─────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  printf 'SKIP  behavioural run (needs root; run inside the image — see header)\n'
elif ! command -v jq >/dev/null 2>&1; then
  printf 'SKIP  behavioural run (needs jq; run inside the image — see header)\n'
elif [ ! -d /workspace ] || [ ! -w /workspace ]; then
  printf 'SKIP  behavioural run (needs a writable /workspace; run inside the image)\n'
else
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  mkshims() { # <dir> <with-nono:yes|no>
    local d="$1" with_nono="$2"
    mkdir -p "$d"
    if [ "$with_nono" = yes ]; then
      cat >"$d/nono" <<'SH'
#!/usr/bin/env bash
printf 'NONO-ARGV nono %s\n' "$*" >> "${NONO_ARGV_LOG:?}"
exit 0
SH
    fi
    cat >"$d/su" <<'SH'
#!/usr/bin/env bash
args=("$@"); cmd=""
for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[$i]}" = "-c" ] && cmd="${args[$((i + 1))]}"; done
exec /bin/bash -c "$cmd"
SH
    printf '#!/usr/bin/env bash\nexit 1\n' >"$d/id"       # users never exist -> useradd branch
    printf '#!/usr/bin/env bash\nexit 0\n' >"$d/useradd"
    printf '#!/usr/bin/env bash\nexit 0\n' >"$d/chown"
    printf '#!/usr/bin/env bash\nexit 0\n' >"$d/chmod"
    chmod +x "$d"/*
  }
  mkshims "$tmp/bin-nono" yes
  mkshims "$tmp/bin-nonono" no

  seed() {
    mkdir -p /workspace/.tps /run/secrets
    printf '[{"id":"probe","configPath":"/workspace/probe/agent.yaml"}]\n' >/workspace/.tps/team.json
    printf 'x' >/run/secrets/.ready
    rm -f /workspace/.tps/pids.json
  }
  # PATH without /usr/local/bin so the image's real nono is not on PATH.
  cleanpath="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/usr/local/bin$' | paste -sd: -)"

  # (1) nono present (fake, logs argv)
  seed
  export NONO_ARGV_LOG="$tmp/argv1.log"; : >"$NONO_ARGV_LOG"
  out1="$(PATH="$tmp/bin-nono:$cleanpath" bash "$sup" 2>&1)"; rc1=$?
  if [ "$rc1" -eq 0 ]; then ok "run with nono present exits 0"; else bad "run with nono present exited $rc1"; fi
  runs1="$(grep -c 'nono run' "$NONO_ARGV_LOG" || true)"
  if [ "$runs1" -ge 2 ]; then ok "fake nono saw $runs1 invocations"; else bad "fake nono saw only $runs1 invocations"; fi
  bad1=0
  while IFS= read -r l; do
    [ -z "$l" ] && continue
    case "$l" in *"--profile tps-office"*) ;; *) bad1=$((bad1 + 1)) ;; esac
  done < <(grep 'nono run' "$NONO_ARGV_LOG" || true)
  if [ "$bad1" -eq 0 ]; then ok "both invocations carried --profile tps-office at runtime"; else bad "$bad1 runtime invocation(s) lacked --profile tps-office"; fi
  if grep -q 'tps-agent start' "$NONO_ARGV_LOG"; then ok "the agent launch went through nono"; else bad "no 'tps-agent start' launch seen under nono"; fi

  # (2) nono absent -> fail closed
  seed
  export NONO_ARGV_LOG="$tmp/argv2.log"; : >"$NONO_ARGV_LOG"
  out2="$(PATH="$tmp/bin-nonono:$cleanpath" bash "$sup" 2>&1)"; rc2=$?
  if [ "$rc2" -ne 0 ]; then ok "run with nono absent exits non-zero ($rc2)"; else bad "run with nono absent exited 0 (should fail closed)"; fi
  case "$out2" in *nono*) ok "refusal names nono" ;; *) bad "refusal does not name nono" ;; esac
  if [ ! -s "$NONO_ARGV_LOG" ]; then ok "no nono invocation (no agent started)"; else bad "an agent was launched despite nono being absent"; fi
  if pgrep -f 'tps-agent start' >/dev/null 2>&1; then bad "a 'tps-agent start' process is running after the nono-absent run"; else ok "no 'tps-agent start' process running after the nono-absent run"; fi
fi

printf '\ntest-tps-office-supervisor: %d passed, %d failed\n' "$npass" "$nfail"
[ "$nfail" -eq 0 ]
