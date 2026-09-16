#!/usr/bin/env bash
# test-tps-office-supervisor.sh — fails-first checks for docker/tps-office-supervisor.sh
# (cli#341 S2, extended by cli#352 r).
#
# Part A (static, always runs): every nono invocation carries `--profile
# tps-office`; every agent launch goes through nono; the old UID-only fallback is
# gone (no code path starts an agent without nono); the identity grant derives
# from the roster state root + roster id; the launch-id pre-flight is wired; the
# sandbox child env comes from one list.
#
# Part B (behavioural, needs root + bash + jq — run it inside the image):
# black-box against the script with a fake nono that logs its argv.
#   1. both `nono run` invocations carry `--profile tps-office`, the identity key
#      is granted by name, and the agent launch happens;
#   2. with nono ABSENT the supervisor exits non-zero, names nono, and starts no
#      agent;
#   3. a refusal mid-run stops the agents launched earlier (no orphan);
#   4. a traversal-shaped roster id is refused before anything runs;
#   5. a config whose agentId disagrees with the roster id is refused, naming
#      both, before anything runs.
#
# Part C (behavioural, needs a REAL nono — the S4-pinned build — root, jq):
#   1. POSITIVE: under the real nono the Landlock probe passes, the office agent
#      launches under `tps-office`, `nono ps` shows the session bound to the
#      supervisor's child, and inside that agent `git ls-remote` over https exits
#      0 (what cli#351's /dev/null + /etc/gitconfig + GIT_CONFIG_GLOBAL fixed on
#      the CLI path) and the child env carries sandboxChildEnv()'s exports;
#   2. FAILS-FIRST: with tps-base's `/dev/null` allow reverted in a private
#      profile copy the probe fails and the supervisor refuses EVERYTHING.
#
#   docker run --rm -v "$PWD":/repo -w /repo --entrypoint bash <image> \
#     scripts/test-tps-office-supervisor.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
sup="$repo_root/docker/tps-office-supervisor.sh"
agent_bin="$repo_root/packages/agent/dist/bin.js"
profiles_src="$repo_root/packages/cli/nono-profiles"

npass=0
nfail=0
ok()  { printf 'PASS  %s\n' "$1"; npass=$((npass + 1)); }
bad() { printf 'FAIL  %s\n' "$1" >&2; nfail=$((nfail + 1)); }

# ── Part A — static shape ────────────────────────────────────────────────────
profiles="$(grep -c -- '--profile tps-office' "$sup" || true)"
if [ "$profiles" -ge 2 ]; then ok "$profiles launch points carry --profile tps-office"; else bad "expected >=2 '--profile tps-office', found $profiles"; fi

if grep -q 'exec nono ${launch_args\[\*\]}' "$sup"; then ok "the agent launch goes through nono"; else bad "the agent launch does not go through \${launch_args[@]}"; fi

if grep -qE 'exec tps-agent start' "$sup"; then bad "UID-only fallback ('exec tps-agent start' without nono) still present"; else ok "no bare 'exec tps-agent start' (UID-only fallback deleted)"; fi
if grep -qi 'falling back to UID isolation only' "$sup"; then bad "old UID-fallback message still present"; else ok "old UID-fallback message gone"; fi
if grep -q 'refusing to launch the agent without isolation' "$sup"; then ok "fail-closed refusal message present"; else bad "no fail-closed refusal message"; fi

# cli#352 r: the launch id (and the identity grant) come from the roster entry.
if grep -q 'tps-agent check --id "\$id" --config "\$config_path"' "$sup"; then ok "launch-id pre-flight (tps-agent check --id) is wired"; else bad "no launch-id pre-flight"; fi
if grep -q 'STATE_ROOT/identity/\$id.key' "$sup" && grep -q 'launch_args+=(--read-file "\$k")' "$sup"; then ok "identity key is granted by name from the roster state root + roster id"; else bad "identity grant not derived from the roster entry"; fi
if grep -q 'export "${SBOX_ENV\[@\]}"' "$sup"; then ok "the child env is exported from one list (SBOX_ENV)"; else bad "SBOX_ENV is not exported into the launch"; fi

# The harness cannot be silently orphaned by a workflow edit (S4-gate shape).
if grep -qF 'scripts/test-tps-office-supervisor.sh' "$repo_root/.github/workflows/test.yml"; then
  ok "test.yml invokes the supervisor harness"
else
  bad "test.yml does not invoke scripts/test-tps-office-supervisor.sh"
fi

# ── Part B — behavioural, fake nono ──────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  printf 'SKIP  behavioural runs (needs root; run inside the image — see header)\n'
elif ! command -v jq >/dev/null 2>&1; then
  printf 'SKIP  behavioural runs (needs jq; run inside the image — see header)\n'
elif [ ! -d /workspace ] || [ ! -w /workspace ]; then
  printf 'SKIP  behavioural runs (needs a writable /workspace; run inside the image)\n'
else
  tmp="$(mktemp -d)"
  chmod 755 "$tmp"
  trap 'rm -rf "$tmp"' EXIT

  # Stand-in for the installed `tps-agent`. `check` delegates to the REAL rule
  # (the built runtime in this repo), so the supervisor's pre-flight is
  # exercised against the code under test; `start` is a workload stub.
  write_agent_shim() { # <dir>
    local d="$1"
    cat >"$d/tps-agent" <<SH
#!/usr/bin/env bash
case "\${1:-}" in
  check) exec bun "$agent_bin" check "\${@:2}" ;;
  start)
    printf 'AGENT-UP pid=%s %s\n' "\$\$" "\$(env | grep -E '^(TPS_NONO_ACTIVE|GIT_CONFIG_GLOBAL)=' | sort | tr '\n' ' ')" >>"\${AGENT_MARKER:?}"
    git ls-remote https://github.com/tpsdev-ai/cli HEAD >"\${AGENT_GIT_LOG:?}" 2>&1
    printf 'AGENT-GIT-RC %s\n' "\$?" >>"\${AGENT_MARKER:?}"
    printf 'AGENT-DONE\n' >>"\${AGENT_MARKER:?}"
    sleep "\${AGENT_SLEEP:-6}"
    printf 'AGENT-EXITED\n' >>"\${AGENT_MARKER:?}"
    ;;
  *) echo "shim tps-agent: unsupported \$1" >&2; exit 2 ;;
esac
SH
    chmod +x "$d/tps-agent"
  }

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
    write_agent_shim "$d"
    chmod +x "$d"/*
  }
  mkshims "$tmp/bin-nono" yes
  mkshims "$tmp/bin-nonono" no

  # Fake nono for the orphan case: agent 2's probe refuses (the wrapped command
  # names probe2); a real agent launch becomes a long sleep so "running" is
  # observable.
  mkorphan() {
    local d="$1"
    mkshims "$d" no
    cat >"$d/nono" <<'SH'
#!/usr/bin/env bash
printf 'NONO-ARGV nono %s\n' "$*" >> "${NONO_ARGV_LOG:?}"
args=("$@"); cmd=(); seen=0
for a in "${args[@]}"; do if [ "$seen" = 1 ]; then cmd+=("$a"); fi; if [ "$a" = "--" ]; then seen=1; fi; done
joined="${cmd[*]}"
case "$joined" in
  *probe2*) exit 1 ;;
  *tps-agent*start*)
    echo started >> "${ORPHAN_MARKER:?}"
    trap 'echo stopped >> "${ORPHAN_MARKER:?}"; exit 0' TERM INT
    i=0; while [ "$i" -lt 15 ]; do sleep 1; i=$((i + 1)); done
    exit 0 ;;
  *) exit 0 ;;
esac
SH
    chmod +x "$d/nono"
  }
  mkorphan "$tmp/bin-orphan"

  # A roster + config + identity key the supervisor can act on (cli#352 r).
  seed() { # <config-agent-id> [<roster-id>]
    local cfg_id="${1:-probe}" roster_id="${2:-probe}"
    mkdir -p /workspace/.tps/identity /run/secrets "/workspace/$roster_id"
    printf '[{"id":"%s","configPath":"/workspace/%s/agent.yaml"}]\n' "$roster_id" "$roster_id" >/workspace/.tps/team.json
    printf 'agentId: %s\nname: %s\nworkspace: /workspace/%s\nmailDir: /workspace/%s/mail\nllm:\n  provider: ollama\n  model: x\n' \
      "$cfg_id" "$cfg_id" "$roster_id" "$roster_id" >"/workspace/$roster_id/agent.yaml"
    printf 'KEY' >"/workspace/.tps/identity/$roster_id.key"
    printf 'PUB' >"/workspace/.tps/identity/$roster_id.pub"
    printf 'x' >/run/secrets/.ready
    rm -f /workspace/.tps/pids.json
  }
  # PATH without /usr/local/bin (where a REAL nono may live), plus a symlink farm
  # so the tools the shims need (bun, jq, git …) stay reachable.
  basetools="$tmp/basetools"; mkdir -p "$basetools"
  for t in bun node bash sh jq git env dirname basename sleep stat awk sed; do
    p="$(command -v "$t" 2>/dev/null || true)"; [ -n "$p" ] && ln -sf "$p" "$basetools/$t"
  done
  cleanpath="$basetools:$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/usr/local/bin$' | paste -sd: -)"

  # (1) nono present (fake, logs argv) — roster id == config id → match launches
  seed
  export NONO_ARGV_LOG="$tmp/argv1.log"; : >"$NONO_ARGV_LOG"
  PATH="$tmp/bin-nono:$cleanpath" timeout 20 bash "$sup" >"$tmp/out1.log" 2>&1; rc1=$?
  out1="$(cat "$tmp/out1.log")"
  if [ "$rc1" -eq 0 ]; then ok "run with nono present exits 0"; else bad "run with nono present exited $rc1: $out1"; fi
  runs1="$(grep -c 'nono run' "$NONO_ARGV_LOG" || true)"
  if [ "$runs1" -ge 2 ]; then ok "fake nono saw $runs1 invocations"; else bad "fake nono saw only $runs1 invocations"; fi
  bad1=0
  while IFS= read -r l; do
    [ -z "$l" ] && continue
    case "$l" in *"--profile tps-office"*) ;; *) bad1=$((bad1 + 1)) ;; esac
  done < <(grep 'nono run' "$NONO_ARGV_LOG" || true)
  if [ "$bad1" -eq 0 ]; then ok "both invocations carried --profile tps-office at runtime"; else bad "$bad1 runtime invocation(s) lacked --profile tps-office"; fi
  if grep -q 'tps-agent start --id probe --config /workspace/probe/agent.yaml' "$NONO_ARGV_LOG"; then ok "the agent launch went through nono with the roster id"; else bad "no 'tps-agent start --id probe' launch seen under nono"; fi
  if grep -q -- '--read-file /workspace/.tps/identity/probe.key' "$NONO_ARGV_LOG"; then ok "the roster identity key was granted by name"; else bad "the identity key grant is missing from the launch argv"; fi

  # (2) nono absent -> fail closed
  seed
  export NONO_ARGV_LOG="$tmp/argv2.log"; : >"$NONO_ARGV_LOG"
  PATH="$tmp/bin-nonono:$cleanpath" timeout 20 bash "$sup" >"$tmp/out2.log" 2>&1; rc2=$?
  out2="$(cat "$tmp/out2.log")"
  if [ "$rc2" -ne 0 ]; then ok "run with nono absent exits non-zero ($rc2)"; else bad "run with nono absent exited 0 (should fail closed)"; fi
  case "$out2" in *nono*) ok "refusal names nono" ;; *) bad "refusal does not name nono" ;; esac
  if [ ! -s "$NONO_ARGV_LOG" ]; then ok "no nono invocation (no agent started)"; else bad "an agent was launched despite nono being absent"; fi
  if command -v pgrep >/dev/null 2>&1 && pgrep -f 'tps-agent start' >/dev/null 2>&1; then bad "a 'tps-agent start' process is running after the nono-absent run"; else ok "no 'tps-agent start' process running after the nono-absent run"; fi

  # (3) orphan-on-refusal: agent 1 launches, agent 2 refuses → agent 1 must be stopped.
  mkdir -p /workspace/.tps /run/secrets
  printf '[{"id":"probe","configPath":"/workspace/probe/agent.yaml"},{"id":"probe2","configPath":"/workspace/probe2/agent.yaml"}]\n' >/workspace/.tps/team.json
  mkdir -p /workspace/probe2
  printf 'agentId: probe2\n' >/workspace/probe2/agent.yaml
  printf 'x' >/run/secrets/.ready
  rm -f /workspace/.tps/pids.json
  export NONO_ARGV_LOG="$tmp/argv3.log"; : >"$NONO_ARGV_LOG"
  export ORPHAN_MARKER="$tmp/orphan.log"; : >"$ORPHAN_MARKER"
  PATH="$tmp/bin-orphan:$cleanpath" timeout 20 bash "$sup" >"$tmp/out3.log" 2>&1; rc3=$?
  out3="$(cat "$tmp/out3.log")"
  if [ "$rc3" -ne 0 ]; then ok "refusal with an earlier agent running exits non-zero ($rc3)"; else bad "refusal run exited 0 (should fail closed)"; fi
  case "$out3" in *nono*) ok "refusal names nono" ;; *) bad "refusal does not name nono" ;; esac
  if grep -q 'tps-agent start --id probe --config /workspace/probe/agent.yaml' "$NONO_ARGV_LOG"; then ok "first agent had launched before the refusal"; else bad "first agent never launched (case invalid)"; fi
  if grep -q '^started' "$ORPHAN_MARKER"; then ok "first agent started"; else bad "first agent never started"; fi
  if grep -q '^stopped' "$ORPHAN_MARKER"; then ok "first agent STOPPED on refusal (no orphan)"; else bad "ORPHAN: the first agent was not stopped on refusal"; fi

  # (4) traversal-shaped roster id → refused before anything runs (cli#352 r)
  mkdir -p /workspace/.tps /run/secrets
  printf '[{"id":"../evil","configPath":"/workspace/evil/agent.yaml"}]\n' >/workspace/.tps/team.json
  printf 'x' >/run/secrets/.ready
  rm -f /workspace/.tps/pids.json
  export NONO_ARGV_LOG="$tmp/argv4.log"; : >"$NONO_ARGV_LOG"
  PATH="$tmp/bin-nono:$cleanpath" timeout 20 bash "$sup" >"$tmp/out4.log" 2>&1; rc4=$?
  out4="$(cat "$tmp/out4.log")"
  if [ "$rc4" -ne 0 ]; then ok "traversal roster id is refused (exit $rc4)"; else bad "traversal roster id was accepted"; fi
  case "$out4" in *'../evil'*) ok "the refusal names the offending id" ;; *) bad "the refusal does not name '../evil'" ;; esac
  if [ ! -s "$NONO_ARGV_LOG" ]; then ok "traversal refusal happens before any launch"; else bad "something was launched despite a traversal id"; fi

  # (5) config agentId disagrees with the roster id → refused, naming both
  seed other
  export NONO_ARGV_LOG="$tmp/argv5.log"; : >"$NONO_ARGV_LOG"
  PATH="$tmp/bin-nono:$cleanpath" timeout 20 bash "$sup" >"$tmp/out5.log" 2>&1; rc5=$?
  out5="$(cat "$tmp/out5.log")"
  if [ "$rc5" -ne 0 ]; then ok "mismatching config is refused (exit $rc5)"; else bad "mismatching config was accepted"; fi
  case "$out5" in *other*) case "$out5" in *probe*) ok "the refusal names both ids (config 'other' vs roster 'probe')";; *) bad "refusal names only one id: $out5";; esac ;; *) bad "refusal does not name the config id: $out5" ;; esac
  if [ ! -s "$NONO_ARGV_LOG" ]; then ok "mismatch refusal happens before any launch"; else bad "something was launched despite a mismatching config"; fi

  # ── Part C — behavioural, REAL nono ────────────────────────────────────────
  real_nono="${NONO_BIN:-$(command -v nono 2>/dev/null || true)}"
  if [ -z "$real_nono" ] || [ ! -x "$real_nono" ]; then
    printf 'SKIP  real-nono cases (no nono on PATH; set NONO_BIN — the CI Docker lane mounts the pinned build)\n'
  elif [ ! -d "$profiles_src" ]; then
    bad "no bundled profiles at $profiles_src — real-nono cases cannot run"
  else
    real="$tmp/real"; mkdir -p "$real/bin"
    write_agent_shim "$real/bin"

    # The supervisor launches agents under the `tps` group (the office image has
    # it; the test image does not).
    getent group tps >/dev/null 2>&1 || groupadd tps

    # A private profile set: Part C.2 tampers with a copy of it.
    xdg="$tmp/xdg"; mkdir -p "$xdg/nono/profiles"
    cp "$profiles_src"/*.json "$xdg/nono/profiles/"
    bad_xdg="$tmp/xdg-reverted"; mkdir -p "$bad_xdg/nono/profiles"
    cp "$profiles_src"/*.json "$bad_xdg/nono/profiles/"
    jq '(.filesystem.allow_file) -= ["/dev/null"]' "$bad_xdg/nono/profiles/tps-base.json" >"$bad_xdg/tps-base.json" &&
      mv "$bad_xdg/tps-base.json" "$bad_xdg/nono/profiles/tps-base.json"

    # The sandboxed nono runs as the agent user: give it a HOME it can write
    # (its session registry lives there). It must NOT live under /tmp or
    # /workspace — tps-office grants those, and nono refuses to start when its
    # protected state root overlaps a granted path.
    home="/home/harness-home"; mkdir -p "$home/.local/state"
    chmod -R 777 "$home"
    export HOME="$home"
    export AGENT_MARKER="$real/marker" AGENT_GIT_LOG="$real/git.log" AGENT_SLEEP="${AGENT_SLEEP:-6}"
    chmod -R 777 "$tmp"

    # C.1 — positive: probe passes, agent launches, the session binds, git works.
    seed
    rm -f "$AGENT_MARKER" "$AGENT_GIT_LOG"
    XDG_CONFIG_HOME="$xdg" PATH="$real/bin:$PATH" timeout 60 bash "$sup" >"$real/out1.log" 2>&1 &
    sup_pid=$!
    up=0
    for _ in $(seq 1 60); do
      if grep -q 'AGENT-UP' "$AGENT_MARKER" 2>/dev/null; then up=1; break; fi
      kill -0 "$sup_pid" 2>/dev/null || break
      sleep 0.5
    done
    if [ "$up" -eq 1 ]; then ok "real nono: the office agent launched under tps-office"; else bad "real nono: no agent ever launched — $(tail -n 30 "$real/out1.log" | tr '\n' ' ')"; fi
    # The stub writes AGENT-UP before its git call and AGENT-GIT-RC after it.
    git_done=0
    for _ in $(seq 1 60); do
      if grep -q 'AGENT-GIT-RC' "$AGENT_MARKER" 2>/dev/null; then git_done=1; break; fi
      kill -0 "$sup_pid" 2>/dev/null || break
      sleep 0.5
    done
    if grep -q 'TPS_NONO_ACTIVE=1' "$AGENT_MARKER" 2>/dev/null && grep -q 'GIT_CONFIG_GLOBAL=/dev/null' "$AGENT_MARKER" 2>/dev/null; then
      ok "the launched agent's env carries sandboxChildEnv()'s exports ($(grep -m1 'AGENT-UP' "$AGENT_MARKER" | tr -s ' '))"
    else
      bad "the launched agent's env is missing the CLI-path exports: $(grep -m1 'AGENT-UP' "$AGENT_MARKER" 2>/dev/null)"
    fi
    if [ "$git_done" -eq 1 ] && grep -q 'AGENT-GIT-RC 0' "$AGENT_MARKER" 2>/dev/null; then
      ok "git ls-remote https://github.com/tpsdev-ai/cli exits 0 inside the launched agent ($(tr -d '\n' <"$AGENT_GIT_LOG" | head -c 60))"
    else
      bad "git ls-remote did not exit 0 inside the launched agent (done=$git_done): $(tr '\n' ' ' <"$AGENT_GIT_LOG" 2>/dev/null | head -c 300)"
    fi
    # nono ps must show the session bound to the supervisor's child.  The
    # sandboxed nono runs as the per-agent user, and nono refuses to read a
    # session registry owned by another uid — so ask as that same user.
    ps_as_agent() { su -m -s /bin/bash "agent-probe" -c "exec '$real_nono' ps --json"; }
    for _ in $(seq 1 20); do
      [ -s /workspace/.tps/pids.json ] && break
      kill -0 "$sup_pid" 2>/dev/null || break
      sleep 0.5
    done
    sess=""
    for _ in $(seq 1 20); do
      sess="$(ps_as_agent 2>"$real/ps.err" | jq -c '[.[] | select(.profile == "tps-office" and .status == "running")]' 2>/dev/null || true)"
      [ -n "$sess" ] && [ "$sess" != "[]" ] && break
      kill -0 "$sup_pid" 2>/dev/null || break
      sleep 0.5
    done
    n_sess="$(printf '%s' "$sess" | jq 'length' 2>/dev/null || echo 0)"
    if [ "${n_sess:-0}" -ge 1 ]; then ok "nono ps shows the running tps-office session ($(printf '%s' "$sess" | jq -r '.[0].name + " pid=" + (.[0].child_pid|tostring)' 2>/dev/null))"; else bad "nono ps shows no running tps-office session (raw: '$sess' err: $(tr '\n' ' ' <"$real/ps.err" 2>/dev/null | head -c 200))"; fi
    sup_child="$(jq -r 'to_entries[0].value' /workspace/.tps/pids.json 2>/dev/null || true)"
    ppid_of() { sed -E 's/^[0-9]+ \(.*\) [A-Z] ([0-9]+).*/\1/' "/proc/$1/stat" 2>/dev/null; }
    is_descendant_of() { # <pid> <ancestor>
      local p="$1" a="$2" i=0
      while [ -n "$p" ] && [ "$p" -gt 1 ] && [ "$i" -lt 25 ]; do
        [ "$p" = "$a" ] && return 0
        p="$(ppid_of "$p")"; i=$((i + 1))
      done
      return 1
    }
    if [ -n "$sup_child" ] && [ "${n_sess:-0}" -ge 1 ]; then
      sess_child="$(printf '%s' "$sess" | jq -r '.[0].child_pid // empty' 2>/dev/null)"
      sess_sup="$(printf '%s' "$sess" | jq -r '.[0].supervisor_pid // empty' 2>/dev/null)"
      if is_descendant_of "$sess_child" "$sup_child" && is_descendant_of "$sess_sup" "$sup_child"; then
        ok "the session is bound to the supervisor's child (sup $sup_child → nono $sess_sup → agent $sess_child)"
      else
        bad "nono ps session is NOT under the supervisor's child $sup_child (nono $sess_sup, agent $sess_child)"
      fi
    else
      bad "no pids.json entry to bind the session to (sup_child='$sup_child')"
    fi
    wait "$sup_pid"; rc1r=$?
    if [ "$rc1r" -eq 0 ]; then ok "real nono: the supervisor exits 0 with the agent green"; else bad "real nono: supervisor exited $rc1r — $(tail -n 30 "$real/out1.log" | tr '\n' ' ')"; fi
    grep -q 'AGENT-EXITED' "$AGENT_MARKER" 2>/dev/null || true

    # C.2 — fails-first: revert tps-base's /dev/null allow in a private copy.
    seed
    rm -f "$AGENT_MARKER"
    XDG_CONFIG_HOME="$bad_xdg" PATH="$real/bin:$PATH" timeout 60 bash "$sup" >"$real/out2.log" 2>&1; rc2r=$?
    if [ "$rc2r" -ne 0 ]; then ok "fails-first: /dev/null allow reverted → supervisor refuses (exit $rc2r)"; else bad "fails-first: supervisor exited 0 with /dev/null not granted"; fi
    if grep -q 'refusing to launch the agent without isolation' "$real/out2.log"; then ok "the refusal names the nono/Landlock cause"; else bad "refusal message missing: $(tail -n 5 "$real/out2.log" | tr '\n' ' ')"; fi
    if [ ! -e "$AGENT_MARKER" ]; then ok "nothing launched when the probe failed (fail closed, all-or-nothing)"; else bad "an agent launched (or touched the marker) despite the probe failing: $(cat "$AGENT_MARKER" | tr '\n' ' ')"; fi
    if pgrep -f 'tps-agent start' >/dev/null 2>&1; then bad "an agent process survived the refusal"; else ok "no agent process left after the refusal"; fi
  fi
fi

printf '\ntest-tps-office-supervisor: %d passed, %d failed\n' "$npass" "$nfail"
[ "$nfail" -eq 0 ]
