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
#      both, before THIS agent is launched; a later iteration runs the same
#      check after earlier agents have launched, and the supervisor stops them
#      before exiting;
#   6. cli#352 r6: the allocation base uid is ALREADY TAKEN (a decoy account) →
#      the supervisor steps over it and still seats every agent. This fails
#      against the pre-r6 code, which seats from a hardcoded uid=1001 and never
#      probes.
#   7. cli#357: a fallible step (useradd) fails while seating the SECOND agent,
#      after the first has launched. `set -e` ends the script; the EXIT trap
#      stops the first agent and no PID file remains.
#   8. cli#357 r4: the launch hook sends the supervisor TERM right
#      after a child's background launch and before its PID is tracked, so the
#      window is exercised on every run; the child is stopped and the PID file
#      removed.
#   9. cli#357 r4: a child that ignores TERM is KILLed after the ~10 s TERM grace
#      (counted sleeps) and the supervisor exits; the EXIT trap sends no second TERM.
#
# Part C (behavioural, needs a REAL nono — the S4-pinned build — root, jq):
#   1. POSITIVE with XDG_CONFIG_HOME pointed at an EMPTY dir (cli#352 r3): the
#      supervisor resolves the profile from the BUNDLED dir the image ships,
#      passes the ABSOLUTE PATH to nono, the Landlock probe passes, the office
#      agent launches under `tps-office` with a HOME it owns (nono's state root
#      cannot live in the supervisor's HOME — /root in the image — nor inside a
#      granted path), `nono ps` shows the session bound to the supervisor's
#      child, and inside that agent `git ls-remote` over https exits 0 (what
#      cli#351's /dev/null + /etc/gitconfig + GIT_CONFIG_GLOBAL fixed on the CLI
#      path) and the child env carries sandboxChildEnv()'s exports;
#   2. FAILS-FIRST: with tps-base's `/dev/null` allow reverted in a private
#      bundled copy — same empty XDG — the probe fails and the supervisor
#      refuses EVERYTHING (this used to be masked by supplying the profiles
#      through XDG_CONFIG_HOME, which is why the image shipped profile-less);
#   3. FAILS-FIRST: no profile reachable at all (empty XDG + a bundled dir that
#      does not exist) → the NAMED refusal fires before anything is launched;
#   4. FAILS-FIRST: the resolver reverted to the BARE name (the pre-r3 shape) →
#      the same setup that launches in C.1 refuses, because nono can only report
#      "Profile not found" (the wrong reason) for a bare name against an empty
#      config dir. A Dockerfile that forgets the COPY turns these red.
#   5. cli#357 r4: the session the supervisor launched is queried after launch; a
#      handled signal while it runs ends that session and its child, and removes
#      the PID file.
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

session_gone_in() { # <ps-output-file> <ps-status> <id> <name>
  local output="$1" status="$2" id="$3" name="$4"
  [ "$status" -eq 0 ] || return 1
  [ -n "$id" ] || [ -n "$name" ] || return 1
  jq -e -s 'length == 1 and (.[0] | type == "array")' "$output" >/dev/null 2>&1 || return 1
  jq -e --arg id "$id" --arg name "$name" \
    'all(.[]; .status != "running" or (($id == "" or .session_id != $id) and ($name == "" or .name != $name)))' \
    "$output" >/dev/null 2>&1
}

session_fixture="$(mktemp)"
check_session_gone_fixture() { # <label> <ps-output> <status> <expected:yes|no>
  local label="$1" output="$2" status="$3" expected="$4" actual=no ps_status
  ps_as_agent() { printf '%s\n' "$output"; return "$status"; }
  if ps_as_agent >"$session_fixture"; then ps_status=0; else ps_status=$?; fi
  if session_gone_in "$session_fixture" "$ps_status" fixture-id fixture-name; then actual=yes; fi
  if [ "$actual" = "$expected" ]; then ok "$label"; else bad "$label (expected $expected, got $actual)"; fi
}
check_session_gone_fixture "failed ps with an empty array does not confirm a stop" '[]' 7 no
check_session_gone_fixture "non-JSON ps output does not confirm a stop" 'bad-json' 0 no
check_session_gone_fixture "multiple ps JSON values do not confirm a stop" $'[{"status":"running","session_id":"fixture-id"}]\n[]' 0 no
check_session_gone_fixture "a matching running session does not confirm a stop" '[{"status":"running","session_id":"fixture-id"}]' 0 no
check_session_gone_fixture "successful empty ps array confirms a stop" '[]' 0 yes
rm -f "$session_fixture"

hook_fixture="$(mktemp -d)"
sed -n '1,/^esac$/p' "$sup" >"$hook_fixture/startup.sh"
printf 'printf launched >>"%s"\n' "$hook_fixture/launched" >>"$hook_fixture/startup.sh"
for hook_value in BOGUS KILL; do
  hook_output="$(TPS_SUPERVISOR_TEST_SIGNAL_AFTER_LAUNCH="$hook_value" bash "$hook_fixture/startup.sh" 2>&1)"; hook_status=$?
  if [ "$hook_status" -eq 1 ] && [[ "$hook_output" == *"$hook_value"* ]] && [ ! -e "$hook_fixture/launched" ]; then
    ok "unlisted launch hook $hook_value refuses before launch"
  else
    bad "unlisted launch hook $hook_value (status=$hook_status output=$hook_output)"
  fi
done
rm -rf "$hook_fixture"

shutdown_fixture="$(mktemp -d)"
sed -n '/^SHUTDOWN_GRACE_SECONDS=10$/,/^# cli#357 r4 —/p' "$sup" | sed '$d' >"$shutdown_fixture/functions.sh"
sed -n '/^on_signal() {/,/^}/p' "$sup" >>"$shutdown_fixture/functions.sh"
cat >"$shutdown_fixture/child.sh" <<'CHILD'
#!/usr/bin/env bash
trap 'echo TERM >>"${SHUTDOWN_FIXTURE:?}/terms"' TERM
echo ready >"${SHUTDOWN_FIXTURE:?}/ready"
while :; do sleep 0.1; done
CHILD
cat >"$shutdown_fixture/run.sh" <<'RUN'
#!/usr/bin/env bash
set -u
PIDS_FILE="$SHUTDOWN_FIXTURE/pids.json"
cleanup_pids_file() { rm -f "$PIDS_FILE"; }
AGENT_IDS=(fixture)
AGENT_PIDS=()
defer_signals=0
pending_signal=""
source "$SHUTDOWN_FIXTURE/functions.sh"
sleep() { if [ "$1" = 0.1 ]; then echo tick >>"$SHUTDOWN_FIXTURE/ticks"; fi; command sleep "$@"; }
SHUTDOWN_GRACE_SECONDS=1
trap 'on_signal TERM' SIGTERM
trap 'on_signal HUP' SIGHUP
trap 'shutdown_children TERM' EXIT
bash "$SHUTDOWN_FIXTURE/child.sh" &
AGENT_PIDS=($!)
printf '%s\n' "$!" >"$SHUTDOWN_FIXTURE/child-pid"
wait "${AGENT_PIDS[0]}"
RUN
SHUTDOWN_FIXTURE="$shutdown_fixture" bash "$shutdown_fixture/run.sh" >"$shutdown_fixture/out" 2>&1 &
shutdown_supervisor=$!
shutdown_ready=0
for _ in $(seq 1 100); do
  if [ -e "$shutdown_fixture/ready" ] && [ -s "$shutdown_fixture/child-pid" ]; then shutdown_ready=1; break; fi
  kill -0 "$shutdown_supervisor" 2>/dev/null || break
  sleep 0.05
done
if [ "$shutdown_ready" -eq 1 ]; then
  kill -TERM "$shutdown_supervisor" 2>/dev/null || true
  first_term=0
  for _ in $(seq 1 100); do
    if [ -s "$shutdown_fixture/terms" ]; then first_term=1; break; fi
    kill -0 "$shutdown_supervisor" 2>/dev/null || break
    sleep 0.05
  done
  if [ "$first_term" -eq 1 ]; then kill -TERM "$shutdown_supervisor" 2>/dev/null || true; fi
  shutdown_finished=0
  for _ in $(seq 1 100); do
    if ! kill -0 "$shutdown_supervisor" 2>/dev/null; then shutdown_finished=1; break; fi
    sleep 0.05
  done
  if [ "$shutdown_finished" -eq 0 ]; then kill -KILL "$shutdown_supervisor" 2>/dev/null || true; fi
  wait "$shutdown_supervisor" 2>/dev/null; shutdown_status=$?
  term_count="$(grep -c '^TERM$' "$shutdown_fixture/terms" 2>/dev/null || true)"
  tick_count="$(grep -c '^tick$' "$shutdown_fixture/ticks" 2>/dev/null || true)"
  child_pid="$(cat "$shutdown_fixture/child-pid")"
  if [ "$first_term" -eq 1 ] && [ "$shutdown_finished" -eq 1 ] && [ "$shutdown_status" -eq 0 ] && [ "$term_count" -eq 1 ] && [ "$tick_count" -eq 10 ] && ! kill -0 "$child_pid" 2>/dev/null; then
    ok "second handled signal during grace sends one TERM and still escalates to KILL"
  else
    bad "shutdown re-entry (first=$first_term finished=$shutdown_finished status=$shutdown_status terms=$term_count ticks=$tick_count child=$child_pid)"
  fi
else
  kill -KILL "$shutdown_supervisor" 2>/dev/null || true
  wait "$shutdown_supervisor" 2>/dev/null || true
  bad "shutdown re-entry fixture child did not start"
fi
rm -rf "$shutdown_fixture"

# ── Part A — static shape ────────────────────────────────────────────────────
profiles="$(grep -cE -- '--profile \\?"?\$NONO_PROFILE' "$sup" || true)"
if [ "$profiles" -ge 2 ]; then ok "$profiles launch points pass the RESOLVED profile path (probe + agent launch)"; else bad "expected >=2 '--profile \"\$NONO_PROFILE\"', found $profiles"; fi
# cli#352 r3 (Sherlock's blocker): the bare name is what nono could not resolve
# in the image. Nothing may pass it any more, at build time or at runtime.
bare="$(grep -c -- '--profile tps-office' "$sup" || true)"
if [ "$bare" -eq 0 ]; then ok "no launch point passes the bare name 'tps-office'"; else bad "$bare launch point(s) still pass the bare profile name"; fi
if grep -q 'resolve_profile_path()' "$sup" && grep -q 'TPS_NONO_PROFILES_DIR:-/usr/local/share/tps/nono-profiles' "$sup"; then ok "the supervisor resolves tps-office to an absolute path (bundled default /usr/local/share/tps/nono-profiles)"; else bad "the supervisor does not resolve the profile (or the bundled default moved)"; fi
if grep -qF 'profile file not found at' "$sup"; then ok "an unresolvable profile is a named refusal"; else bad "no named refusal for an unresolvable profile"; fi
if grep -q 'AGENT_HOME="/home/\$user"' "$sup" && grep -q "HOME='\$AGENT_HOME' exec nono" "$sup"; then ok "the launch runs the agent with a HOME the agent owns (not the supervisor's)"; else bad "the launch hands the agent the supervisor's HOME — nono cannot write its state root there"; fi
# The ship-red half (Harness green, ship red — cli#341 S1b/S4 class): the image
# must actually carry the profiles at the path the resolver defaults to, and a
# CI lane must launch the built image so a Dockerfile that forgets the COPY
# cannot stay green.
if grep -qF 'COPY packages/cli/nono-profiles/ /usr/local/share/tps/nono-profiles' "$repo_root/docker/Dockerfile"; then ok "docker/Dockerfile ships the profiles at the resolved default path"; else bad "docker/Dockerfile does not COPY the profiles to /usr/local/share/tps/nono-profiles"; fi
if grep -q 'usr/local/share/tps/nono-profiles/tps-office.json' "$repo_root/.github/workflows/docker.yml"; then ok "docker.yml asserts the bundled profile (and a launch) inside the built image"; else bad "docker.yml never runs the built image against the bundled profile"; fi

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

# cli#357: reject termination shapes the source control cannot verify. A
# multi-line quoted string or a heredoc is refused outright: a physical
# `shutdown_children TERM` line inside one never runs, so it cannot be a guard.
# The control covers explicit `exit`/`return` forms, a self-kill (`kill $$` or
# `kill -SIG $$`) and calls to supervisor functions that exit. A command that
# ends the script through errexit, and termination by a signal, are the EXIT
# trap's job: the Part B errexit case, the Part B launch-window case and the
# Part C stop case exercise those paths; they do not prove that every survivor
# is reaped.
assert_seating_shutdown() { # <source>
  awk '
    function word(line, name) {
      return line ~ ("(^|[^[:alnum:]_])" name "([^[:alnum:]_]|$)")
    }
    function unknown(line, continued, commands) {
      commands=line
      gsub(/\[\[.*\]\]/, "TEST", commands)
      return word(line, "eval") || word(line, "source") ||
        commands ~ /(^|[;&|({])[[:space:]]*((if|elif|then|else|!)[[:space:]]+)*(exec|builtin|command|\.)[[:space:]]/ ||
        line ~ /^[[:space:]]*((if|elif|then|else|!)[[:space:]]+)*["\047]?\$/ ||
        commands ~ /[;&|][[:space:]]*[^[:space:]=]*["\047]?\$/ ||
        line ~ /\$\([[:space:]]*["\047]?\$/ ||
        line ~ /^[[:space:]]*((if|elif|then|else|!)[[:space:]]+)*[^[:space:]=]+\$/ ||
        (line ~ /\\[[:space:]]*$/ && line !~ /^[[:space:]]*echo[[:space:]]/ && !continued) ||
        line ~ /<<|`/ || line ~ /\(\)[[:space:]]*\{/
    }
    function fail(line, reason) {
      print "line " line ": " reason ": " L[line]
      failed=1
    }
    function guarded(line, k, text) {
      for (k=line-1; k>s; k--) {
        text=L[k]
        if (text ~ /^[[:space:]]*shutdown_children[[:space:]]+TERM[[:space:]]*$/) return 1
        if (text ~ /^[[:space:]]*(fi|else|done|exit|return|[}])/) break
        if (text ~ /^[[:space:]]*(if|elif)[[:space:]]/ || text ~ /[;&|{}]/) break
      }
      return 0
    }
    {
      L[NR]=$0
      if (L[NR] ~ /^[[:space:]]*#/) L[NR]=""
      continuation[NR]=(L[NR-1] ~ /\\[[:space:]]*$/ &&
        (L[NR-1] ~ /^[[:space:]]*echo[[:space:]]/ || continuation[NR-1]))
      if ($0 == "for ((i=0; i<count; i++)); do") { s=NR; starts++ }
      if (s && NR>s && $0 == "done") { e=NR; ends++ }
      definition_shape=L[NR]
      gsub(/=[[:space:]]*\([[:space:]]*\)/, "=ARRAY", definition_shape)
      if ($0 ~ /^[[:space:]]*(function[[:space:]]+)?[[:alnum:]_]+[[:space:]]*\(\)[[:space:]]*\{/) {
        if (fn != "") fail(NR, "unanalysable function boundary")
        name=$0
        sub(/^[[:space:]]*function[[:space:]]+/, "", name)
        sub(/^[[:space:]]*/, "", name)
        sub(/[[:space:]]*\(.*/, "", name)
        fn=name
        definition=NR
        functions[fn]=1
      } else if (L[NR] ~ /^[[:space:]]*function[[:space:]]/ || definition_shape ~ /\([[:space:]]*\)/) {
        fail(NR, "unanalysable function definition")
      }
      if (fn != "") {
        text=L[NR]
        if (NR == definition) sub(/^[^{]*\{/, "", text)
        normalized=text
        gsub(/["\047\\]/, "", normalized)
        body[fn]=body[fn] "\n" normalized
        if (unknown(text, continuation[NR]) || unknown(normalized)) opaque[fn]=1
        if ($0 ~ /^}/ || (NR == definition && $0 ~ /\{.*}[[:space:]]*$/)) fn=""
      } else if ($0 ~ /^}/) fail(NR, "unanalysable function boundary")
    }
    END {
      if (!s || !e || starts != 1 || ends != 1) {
        print "could not bound the agent seating loop"
        exit 1
      }
      # Fail closed on a loop containing a multi-line quoted string or a
      # heredoc: the lines inside them are data, not commands, so a physical
      # `shutdown_children TERM` line inside one is not executed and cannot
      # serve as a guard.
      qstate=0    # 0 none, 1 single-quoted, 2 double-quoted
      heredoc=""
      for (j=s+1; j<e; j++) {
        t=L[j]
        if (heredoc != "") {
          if (t == heredoc) heredoc=""
          continue
        }
        if (qstate == 0 && t ~ /<</) {
          fail(j, "unanalysable heredoc")
          if (match(t, /<<-?[[:space:]]*["\047]?[[:alnum:]_]+/) > 0) {
            delim=substr(t, RSTART, RLENGTH)
            sub(/^<<-?[[:space:]]*["\047]?/, "", delim)
            gsub(/["\047]/, "", delim)
            heredoc=delim
          }
          continue
        }
        n=length(t); k=1
        while (k<=n) {
          ch=substr(t,k,1)
          if (qstate == 0) {
            if (ch == "\047") qstate=1
            else if (ch == "\"") qstate=2
            else if (ch == "#" && (k == 1 || substr(t,k-1,1) ~ /[[:space:];]/)) break
          } else if (qstate == 1) {
            if (ch == "\047") qstate=0
          } else {
            if (ch == "\\") k++
            else if (ch == "\"") qstate=0
          }
          k++
        }
        if (qstate != 0) fail(j, "unanalysable multi-line quoted string")
      }
      if (fn != "") fail(NR, "unanalysable function boundary")
      for (name in functions) {
        if (word(body[name], "exit")) exits[name]=1
        if (name in opaque) exits[name]=1
      }
      changed=1
      while (changed) {
        changed=0
        for (name in functions) for (callee in exits) {
          if (word(body[name], callee)) {
            if (!(name in exits)) { exits[name]=1; changed=1 }
            if ((callee in opaque) && !(name in opaque)) { opaque[name]=1; changed=1 }
          }
        }
      }
      status="([[:space:]]+([0-9]+|\\$[[:alpha:]_][[:alnum:]_]*|\"\\$[[:alpha:]_][[:alnum:]_]*\"))?"
      direct="exit" status
      for (j=s+1; j<e; j++) {
        text=L[j]
        if (text ~ /^[[:space:]]*$/) continue
        normalized=text
        gsub(/["\047\\]/, "", normalized)
        if (unknown(text, continuation[j]) || unknown(normalized) || word(normalized, "return")) {
          fail(j, "unanalysable termination shape")
          continue
        }
        killself=(word(normalized, "kill") && normalized ~ /(^|[^[:alnum:]_])\$\$([^[:alnum:]_]|$)/)
        terminates=(word(normalized, "exit") || killself)
        recognized=(text ~ ("^[[:space:]]*" direct "[[:space:]]*$") ||
          text ~ ("^[[:space:]]*[[:alnum:]_]+[[:space:]]*&&[[:space:]]*" direct "[[:space:]]*$") ||
          text ~ ("^[[:space:]]*\\{[[:space:]]*(:|echo[[:space:]]+[^;&|{}]+|shutdown_children TERM);[[:space:]]*" direct ";[[:space:]]*}[[:space:]]*$"))
        if (killself && normalized ~ /^[[:space:]]*kill([[:space:]]+-[[:alnum:]]+)?[[:space:]]+\$\$[[:space:]]*$/) recognized=1
        for (name in exits) if (word(normalized, name)) {
          terminates=1
          if (name in opaque) { recognized=0; break }
          if (text ~ ("^[[:space:]]*" name "([[:space:]]+[^;&|(){}]+)?[[:space:]]*$")) recognized=1
          else recognized=0
        }
        if (!terminates) continue
        if (!recognized) fail(j, "unanalysable termination shape")
        else if (!guarded(j) && text !~ ("^[[:space:]]*\\{[[:space:]]*shutdown_children TERM;[[:space:]]*" direct ";[[:space:]]*}[[:space:]]*$")) fail(j, "termination without shutdown_children TERM")
      }
      exit failed ? 1 : 0
    }
  ' "$1"
}

if analysis="$(assert_seating_shutdown "$sup")"; then
  ok "seating-loop explicit exit forms are guarded and analysable"
else
  bad "seating-loop source control: $analysis"
fi

# cli#357 r4: pin the literal trap statements and reject eval.
assert_exit_trap() { # <source>
  awk '
    function trim(s) {
      sub(/^[[:space:]]+/, "", s)
      sub(/[[:space:]]+$/, "", s)
      return s
    }
    function fail(msg) {
      print msg
      failed=1
      exit 1
    }
    { lines[NR]=$0 }
    END {
      if (failed) exit 1
      ntrap=0
      for (i=1; i<=NR; i++) {
        line=trim(lines[i])
        if (line ~ /^#/) continue
        if (line ~ /(^|[^[:alnum:]_])eval([^[:alnum:]_]|$)/) fail("eval in supervisor: " line)
        if (line !~ /(^|[^[:alnum:]_])trap([^[:alnum:]_]|$)/) continue
        if (line == "trap \047shutdown_children TERM\047 EXIT") {
          ntrap++
          if (ntrap > 1) fail("more than one pinned EXIT trap")
          continue
        }
        if (line == "trap \047on_signal TERM\047 SIGTERM" ||
            line == "trap \047on_signal INT\047 SIGINT" ||
            line == "trap \047on_signal HUP\047 SIGHUP") continue
        fail("unlisted trap statement: " line)
      }
      if (ntrap == 0) fail("found no EXIT trap")
      exit 0
    }
  ' "$1"
}

if analysis="$(assert_exit_trap "$sup")"; then
  ok "the literal signal traps and pinned EXIT trap pass the trap control"
else
  bad "EXIT-trap control: $analysis"
fi

seating_fixtures="$(mktemp -d)"
check_seating_fixture() { # <label> <expected:pass|unguarded|unanalysable> <loop body> [<helpers>]
  local label="$1" expected="$2" body="$3" helpers="${4:-}" result rc
  printf '%s\n%s\n%s\n%s\n' "$helpers" 'for ((i=0; i<count; i++)); do' "$body" 'done' >"$seating_fixtures/source.sh"
  result="$(assert_seating_shutdown "$seating_fixtures/source.sh")"
  rc=$?
  case "$expected:$rc:$result" in
    pass:0:) ok "$label" ;;
    unguarded:1:*line*"termination without shutdown_children TERM"*) ok "$label" ;;
    unanalysable:1:*line*"unanalysable "*) ok "$label" ;;
    *) bad "$label (expected $expected, got status $rc: $result)" ;;
  esac
}
for termination in 'exit 1' 'exit 2' "exit \"\$rc\"" exit; do
  check_seating_fixture "guarded $termination passes" pass "$(printf '  shutdown_children TERM\n  %s' "$termination")"
  check_seating_fixture "unguarded $termination fails" unguarded "  $termination"
done
for termination in 'cond && exit 1' '{ echo refusal; exit 1; }'; do
  check_seating_fixture "unguarded $termination fails" unguarded "  $termination"
  check_seating_fixture "guarded $termination passes" pass "$(printf '  shutdown_children TERM\n  %s' "$termination")"
done
check_seating_fixture "inline group shutdown passes" pass '  { shutdown_children TERM; exit 1; }'
for termination in 'kill $$' 'kill -TERM $$' 'kill -KILL "$$"'; do
  check_seating_fixture "guarded self-kill $termination passes" pass "$(printf '  shutdown_children TERM\n  %s' "$termination")"
  check_seating_fixture "unguarded self-kill $termination fails" unguarded "  $termination"
done
helper="$(printf 'refuse() {\n  exit 2\n}')"
check_seating_fixture "unguarded exiting helper fails" unguarded '  refuse' "$helper"
check_seating_fixture "guarded exiting helper passes" pass "$(printf '  shutdown_children TERM\n  refuse')" "$helper"
check_seating_fixture "transitive exiting helper fails" unguarded '  indirect' "$(printf '%s\nindirect() {\n  refuse\n}' "$helper")"
check_seating_fixture "unsupported helper declaration fails as unanalysable" unanalysable '  refuse' "$(printf '\047refuse\047() {\n  exit 2\n}')"
check_seating_fixture "eval fails as unanalysable" unanalysable '  eval "exit 1"'
check_seating_fixture "guarded eval fails as unanalysable" unanalysable "$(printf '  shutdown_children TERM\n  eval "exit 1"')"
check_seating_fixture "opaque helper fails as unanalysable" unanalysable "$(printf '  shutdown_children TERM\n  refuse')" "$(printf 'refuse() {\n  eval "exit 1"\n}')"
check_seating_fixture "joined-word exiting helper fails" unguarded '  refuse' "$(printf 'refuse() {\n  ex"it" 1\n}')"
check_seating_fixture "return fails as unanalysable" unanalysable '  return'
check_seating_fixture "compound return fails as unanalysable" unanalysable '  cond && return 1'
check_seating_fixture "conditional shutdown is not a guard" unguarded "$(printf '  cond && shutdown_children TERM\n  exit 1')"
check_seating_fixture "comment is not a guard" unguarded "$(printf '  # shutdown_children TERM\n  exit 1')"
check_seating_fixture "split-word exiting helper fails as unanalysable" unanalysable '  refuse' "$(printf 'refuse() {\n  ex\\\nit 1\n}')"
check_seating_fixture "dynamic command fails as unanalysable" unanalysable "  \"\$cmd\""
check_seating_fixture "conditional dynamic command fails as unanalysable" unanalysable "  [[ \"\$ok\" ]] && \"\$cmd\""
check_seating_fixture "multi-line quoted guard lookalike fails as unanalysable" unanalysable "$(printf '  msg="warning:\nshutdown_children TERM\n"\n  exit 1')"
check_seating_fixture "here-doc guard lookalike fails as unanalysable" unanalysable "$(printf '  cat <<EOF\nshutdown_children TERM\nEOF\n  exit 1')"

check_exit_trap_fixture() { # <label> <expected:pass|fail> <source>
  local label="$1" expected="$2" src="$3" result rc
  printf '%s\n' "$src" >"$seating_fixtures/trap.sh"
  result="$(assert_exit_trap "$seating_fixtures/trap.sh")"; rc=$?
  case "$expected:$rc" in
    pass:0) ok "$label" ;;
    fail:1) ok "$label" ;;
    *) bad "$label (expected $expected, got status $rc: $result)" ;;
  esac
}
check_exit_trap_fixture "EXIT trap with the pinned action passes" pass "$(printf '%s\n' \
  'cleanup_pids_file() {' '  rm -f "$PIDS_FILE"' '}' \
  'shutdown_children() {' '  kill -TERM "$1" 2>/dev/null || true' '  cleanup_pids_file' '}' \
  "trap 'shutdown_children TERM' EXIT")"
check_exit_trap_fixture "EXIT trap with an arbitrary-PID kill fails" fail "$(printf '%s\n' \
  'shutdown_children() { kill -TERM "$1" 2>/dev/null || true; }' \
  "trap 'kill -TERM 4242' EXIT")"
check_exit_trap_fixture "a second trap ... 0 after the real one fails" fail "$(printf '%s\n' \
  'shutdown_children() { kill -TERM "$1" 2>/dev/null || true; }' \
  "trap 'shutdown_children TERM' EXIT" \
  "trap 'cleanup_pids_file' 0")"
check_exit_trap_fixture "an eval trap override fails" fail "$(printf '%s\n' \
  "trap 'shutdown_children TERM' EXIT" \
  "eval \"trap 'cleanup_pids_file' 0\"")"
check_exit_trap_fixture "an eval with no trap word fails" fail "$(printf '%s\n' \
  "trap 'shutdown_children TERM' EXIT" \
  'eval "$cmd"')"
check_exit_trap_fixture "trap - EXIT fails" fail "trap - EXIT"
check_exit_trap_fixture "trap '' EXIT fails" fail "trap '' EXIT"
check_exit_trap_fixture "trap '' 0 fails" fail "trap '' 0"
check_exit_trap_fixture "EXIT trap that only removes the PID file fails" fail "$(printf '%s\n' \
  'cleanup_pids_file() {' '  rm -f "$PIDS_FILE"' '}' \
  "trap 'cleanup_pids_file' EXIT")"
check_exit_trap_fixture "EXIT trap that removes the PID file before stopping fails" fail "$(printf '%s\n' \
  'cleanup_pids_file() { rm -f "$PIDS_FILE"; }' \
  'shutdown_children() { kill -TERM "$1" 2>/dev/null || true; cleanup_pids_file; }' \
  "trap 'cleanup_pids_file; shutdown_children TERM' EXIT")"
check_exit_trap_fixture "EXIT trap with a conditional stop fails" fail "$(printf '%s\n' \
  'cleanup_pids_file() { rm -f "$PIDS_FILE"; }' \
  'shutdown_children() { kill -TERM "$1" 2>/dev/null || true; cleanup_pids_file; }' \
  "trap 'false && kill -TERM 4242; cleanup_pids_file' EXIT")"
check_exit_trap_fixture "EXIT trap that removes the literal PID path before stopping fails" fail "$(printf '%s\n' \
  'shutdown_children() { kill -TERM "$1" 2>/dev/null || true; }' \
  "trap 'rm -f /workspace/.tps/pids.json; kill -TERM 4242' EXIT")"
check_exit_trap_fixture "EXIT trap that stops then removes the PID file fails (not the pinned action)" fail "$(printf '%s\n' \
  'shutdown_children() { kill -TERM "$1" 2>/dev/null || true; }' \
  "trap 'shutdown_children TERM; rm -f \"\$PIDS_FILE\"' EXIT")"
rm -rf "$seating_fixtures"

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
    printf 'AGENT-UP pid=%s %s\n' "\$\$" "\$(env | grep -E '^(HOME|TPS_NONO_ACTIVE|GIT_CONFIG_GLOBAL)=' | sort | tr '\n' ' ')" >>"\${AGENT_MARKER:?}"
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

  # Fake nono + useradd for the errexit case: every probe passes and agent 1
  # runs until TERMed; seating the SECOND agent fails at useradd.
  mkuseraddfail() {
    local d="$1"
    mkshims "$d" no
    cat >"$d/nono" <<'SH'
#!/usr/bin/env bash
printf 'NONO-ARGV nono %s\n' "$*" >> "${NONO_ARGV_LOG:?}"
case "$*" in
  *tps-agent*start*)
    echo "started $$" >> "${USERADD_MARKER:?}"
    trap 'echo "stopped $$" >> "${USERADD_MARKER:?}"; exit 0' TERM INT
    i=0; while [ "$i" -lt 15 ]; do sleep 1; i=$((i + 1)); done
    exit 0 ;;
  *) exit 0 ;;
esac
SH
    cat >"$d/useradd" <<'SH'
#!/usr/bin/env bash
for a in "$@"; do last="$a"; done
case "$last" in
  agent-probe2) sleep 1; exit 1 ;;
esac
exit 0
SH
    chmod +x "$d"/*
  }
  mkuseraddfail "$tmp/bin-useradd-fail2"

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
  # cli#352 r3: the supervisor resolves the profile itself, so the behavioural
  # cases hand it the bundled dir the way the image does (the fake nono only
  # logs argv; resolution never reaches nono).
  export TPS_NONO_PROFILES_DIR="$profiles_src"

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
    case "$l" in *"--profile $profiles_src/tps-office.json"*) ;; *) bad1=$((bad1 + 1)) ;; esac
  done < <(grep 'nono run' "$NONO_ARGV_LOG" || true)
  if [ "$bad1" -eq 0 ]; then ok "both invocations carried the RESOLVED profile path at runtime"; else bad "$bad1 runtime invocation(s) lacked the resolved profile path"; fi
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
  if ! command -v pgrep >/dev/null 2>&1; then bad "pgrep missing; cannot assert no orphan"
  elif pgrep -f 'tps-agent start' >/dev/null 2>&1; then bad "a 'tps-agent start' process is running after the nono-absent run"
  else ok "no 'tps-agent start' process running after the nono-absent run"; fi

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

  # (3b) errexit orphan (cli#357): seating the SECOND agent fails at useradd —
  # a fallible step after the first agent launched. `set -e` ends the script;
  # the EXIT trap must stop agent 1 and leave no PID file.
  mkdir -p /workspace/.tps /run/secrets /workspace/probe2
  printf '[{"id":"probe","configPath":"/workspace/probe/agent.yaml"},{"id":"probe2","configPath":"/workspace/probe2/agent.yaml"}]\n' >/workspace/.tps/team.json
  printf 'agentId: probe\n' >/workspace/probe/agent.yaml
  printf 'agentId: probe2\n' >/workspace/probe2/agent.yaml
  printf 'x' >/run/secrets/.ready
  rm -f /workspace/.tps/pids.json
  export NONO_ARGV_LOG="$tmp/argv3b.log"; : >"$NONO_ARGV_LOG"
  export USERADD_MARKER="$tmp/useradd.log"; : >"$USERADD_MARKER"
  PATH="$tmp/bin-useradd-fail2:$cleanpath" timeout 20 bash "$sup" >"$tmp/out3b.log" 2>&1; rc3b=$?
  if [ "$rc3b" -ne 0 ]; then ok "errexit after an earlier launch exits non-zero ($rc3b)"; else bad "errexit run exited 0 (should fail)"; fi
  if grep -q 'tps-agent start --id probe --config /workspace/probe/agent.yaml' "$NONO_ARGV_LOG"; then ok "first agent had launched before the errexit"; else bad "first agent never launched (case invalid)"; fi
  launched_pid="$(sed -n 's/^started //p' "$USERADD_MARKER" | head -n1)"
  if grep -q '^stopped' "$USERADD_MARKER"; then ok "first agent STOPPED on errexit (no orphan)"; else bad "ORPHAN: the first agent was not stopped when useradd failed"; fi
  if [ -n "$launched_pid" ] && ! kill -0 "$launched_pid" 2>/dev/null; then ok "first agent process $launched_pid is gone afterwards"; else bad "first agent process '${launched_pid:-unknown}' is still running after the errexit"; fi
  if [ ! -e /workspace/.tps/pids.json ]; then ok "no PID file remains after the errexit"; else bad "the PID file remains after the errexit"; fi

  # (3c) cli#357 r4 — a ~10 s TERM grace (counted sleeps), then a KILL attempt.
  # The child ignores TERM; the supervisor attempts KILL after the grace and
  # exits. It sees exactly one TERM.
  mkshutdown() {
    local d="$1"
    mkshims "$d" no
    cat >"$d/nono" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *tps-agent*start*)
    echo "started $$" >>"${SHUTDOWN_MARKER:?}"
    trap 'echo term >>"${SHUTDOWN_MARKER:?}"' TERM
    i=0; while [ "$i" -lt 400 ]; do sleep 0.1; i=$((i + 1)); done
    exit 0 ;;
  *) exit 0 ;;
esac
SH
    chmod +x "$d"/*
  }
  mkshutdown "$tmp/bin-shutdown"
  seed
  export SHUTDOWN_MARKER="$tmp/shutdown.log"; : >"$SHUTDOWN_MARKER"
  PATH="$tmp/bin-shutdown:$cleanpath" bash "$sup" >"$tmp/out3c.log" 2>&1 &
  sup3c=$!
  up=0
  for _ in $(seq 1 100); do
    if grep -q '^started' "$SHUTDOWN_MARKER" 2>/dev/null; then up=1; break; fi
    kill -0 "$sup3c" 2>/dev/null || break
    sleep 0.1
  done
  if [ "$up" -eq 1 ]; then ok "TERM grace: the TERM-ignoring child started"; else bad "TERM grace: the child never started — $(tail -n 5 "$tmp/out3c.log" | tr '\n' ' ')"; fi
  kill -TERM "$sup3c" 2>/dev/null || true
  t0=$(date +%s)
  fin=0
  for _ in $(seq 1 250); do
    if ! kill -0 "$sup3c" 2>/dev/null; then fin=1; break; fi
    sleep 0.1
  done
  t1=$(date +%s)
  rc3c=99
  if [ "$fin" -eq 1 ]; then
    wait "$sup3c" 2>/dev/null; rc3c=$?
  else
    kill -KILL "$sup3c" 2>/dev/null || true
    bad "TERM grace: the supervisor did not exit within 25 s"
  fi
  elapsed=$((t1 - t0))
  if [ "$rc3c" -eq 0 ]; then ok "TERM grace then KILL: the supervisor exits 0 after the grace"; else bad "TERM grace then KILL: the supervisor exited $rc3c"; fi
  if [ "$elapsed" -ge 10 ] && [ "$elapsed" -le 20 ]; then ok "TERM grace then KILL: the KILL attempt followed the ~10 s grace ($elapsed s)"; else bad "TERM grace then KILL: the elapsed time was not the ~10 s grace ($elapsed s)"; fi
  shut_pid="$(sed -n 's/^started //p' "$SHUTDOWN_MARKER" | head -n1)"
  if [ -n "$shut_pid" ] && ! kill -0 "$shut_pid" 2>/dev/null; then ok "TERM grace then KILL: the TERM-ignoring child $shut_pid is gone"; else bad "TERM grace then KILL: the child '${shut_pid:-unknown}' survived"; fi
  terms="$(grep -c '^term$' "$SHUTDOWN_MARKER" || true)"
  if [ "$terms" -eq 1 ]; then ok "TERM grace then KILL: one TERM through signal and EXIT traps"; else bad "TERM grace then KILL: the child saw $terms TERM(s), expected 1"; fi
  if [ ! -e /workspace/.tps/pids.json ]; then ok "TERM grace then KILL: the PID file is removed"; else bad "TERM grace then KILL: the PID file remains"; fi

  # (3d) cli#357 r4 — the hook sends TERM to the supervisor between launch
  # and `pid=$!`. The child must be stopped and the PID file removed.
  mksignalseam() {
    local d="$1"
    mkshims "$d" no
    cat >"$d/nono" <<'SH'
#!/usr/bin/env bash
printf 'NONO-ARGV nono %s\n' "$*" >>"${SEAM_ARGV_LOG:?}"
case "$*" in
  *tps-agent*start*)
    echo "started $$" >>"${SEAM_MARKER:?}"
    trap 'echo "stopped $$" >>"${SEAM_MARKER:?}"; exit 0' TERM INT
    i=0; while [ "$i" -lt 150 ]; do sleep 0.1; i=$((i + 1)); done
    exit 0 ;;
  *) exit 0 ;;
esac
SH
    chmod +x "$d"/*
  }
  mksignalseam "$tmp/bin-signal-seam"
  seed
  export SEAM_ARGV_LOG="$tmp/seam-argv.log" SEAM_MARKER="$tmp/seam.log"
  : >"$SEAM_ARGV_LOG"; : >"$SEAM_MARKER"
  PATH="$tmp/bin-signal-seam:$cleanpath" TPS_SUPERVISOR_TEST_SIGNAL_AFTER_LAUNCH=TERM \
    timeout 30 bash "$sup" >"$tmp/out3d.log" 2>&1; rc3d=$?
  if grep -q 'tps-agent start --id probe' "$SEAM_ARGV_LOG"; then ok "launch-window deferral: the launch was issued inside the window"; else bad "launch-window deferral: the launch was never issued — $(tail -n 5 "$tmp/out3d.log" | tr '\n' ' ')"; fi
  if [ "$rc3d" -eq 0 ]; then ok "launch-window deferral: the supervisor exits 0"; else bad "launch-window deferral: the supervisor exited $rc3d"; fi
  if grep -q '^started' "$SEAM_MARKER"; then ok "launch-window deferral: the child started inside the window"; else bad "launch-window deferral: the child never started — $(tr '\n' ' ' <"$SEAM_MARKER")"; fi
  if grep -q '^stopped' "$SEAM_MARKER"; then ok "launch-window deferral: the child was stopped"; else bad "launch-window deferral: the child was not stopped"; fi
  seam_alive=0
  for _ in $(seq 1 30); do
    if pgrep -f "$tmp/bin-signal-seam/nono" >/dev/null 2>&1; then seam_alive=1; break; fi
    sleep 0.1
  done
  if [ "$seam_alive" -eq 0 ]; then ok "launch-window deferral: no launched child outlived the supervisor"; else bad "launch-window deferral: a launched child outlived the supervisor"; fi
  while IFS= read -r seam_pid; do [ -n "$seam_pid" ] && kill -KILL "$seam_pid" 2>/dev/null || true; done < <(pgrep -f "$tmp/bin-signal-seam/nono" || true)
  if [ ! -e /workspace/.tps/pids.json ]; then ok "launch-window deferral: the PID file is removed"; else bad "launch-window deferral: the PID file remains"; fi

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

  # (6) cli#352 r6 — never ASSUME a uid is free. Occupy the supervisor's
  # allocation base with a decoy account and assert it steps over it and seats
  # EVERY agent. Against the pre-r6 code (a hardcoded uid=1001 with no probe)
  # the agent is seated at the colliding id, so this fails.
  base="$(sed -n 's/^AGENT_UID_BASE=\([0-9][0-9]*\)$/\1/p' "$sup" | head -n1)"
  if [ -z "$base" ]; then
    bad "supervisor defines no AGENT_UID_BASE — uid allocation has no named base to probe"
  else
    useradd -u "$base" -M -g 0 -s /usr/sbin/nologin decoy-uidbase 2>/dev/null || true
    decoy_uid="$(id -u decoy-uidbase 2>/dev/null || echo '')"
    if [ "$decoy_uid" = "$base" ]; then ok "fixture: a decoy account occupies the base uid $base"; else bad "fixture: could not occupy $base (uid='$decoy_uid')"; fi
    mkdir -p /workspace/.tps/identity /run/secrets /workspace/seat1 /workspace/seat2
    printf '[{"id":"seat1","configPath":"/workspace/seat1/agent.yaml"},{"id":"seat2","configPath":"/workspace/seat2/agent.yaml"}]\n' >/workspace/.tps/team.json
    printf 'agentId: seat1\nname: seat1\nworkspace: /workspace/seat1\nllm:\n  provider: ollama\n  model: x\n' >/workspace/seat1/agent.yaml
    printf 'agentId: seat2\nname: seat2\nworkspace: /workspace/seat2\nllm:\n  provider: ollama\n  model: x\n' >/workspace/seat2/agent.yaml
    printf 'KEY' >/workspace/.tps/identity/seat1.key; printf 'PUB' >/workspace/.tps/identity/seat1.pub
    printf 'KEY' >/workspace/.tps/identity/seat2.key; printf 'PUB' >/workspace/.tps/identity/seat2.pub
    printf 'x' >/run/secrets/.ready
    rm -f /workspace/.tps/pids.json
    # A shim dir carrying ONLY the tps-agent stand-in and a fake nono: the
    # seating path must use the REAL account code, so the assigned uids are
    # observable (no id/useradd/chown shadowing).
    onlynono="$tmp/bin-real-seat"; mkdir -p "$onlynono"
    write_agent_shim "$onlynono"
    printf '#!/usr/bin/env bash\nprintf "NONO-ARGV nono %%s\\n" "$*" >> "${NONO_ARGV_LOG:?}"\nexit 0\n' >"$onlynono/nono"
    chmod +x "$onlynono"/*
    export NONO_ARGV_LOG="$tmp/argv6.log"; : >"$NONO_ARGV_LOG"
    PATH="$onlynono:$cleanpath" timeout 30 bash "$sup" >"$tmp/out6.log" 2>&1; rc6=$?
    if [ "$rc6" -eq 0 ]; then ok "uid stepping: a 2-agent team seats over a taken base uid (exit 0)"; else bad "uid stepping: supervisor exited $rc6: $(tail -n 5 "$tmp/out6.log" | tr '\n' ' ')"; fi
    u1="$(id -u agent-seat1 2>/dev/null || echo '')"; u2="$(id -u agent-seat2 2>/dev/null || echo '')"
    if [ -n "$u1" ] && [ -n "$u2" ] && [ "$u1" -gt "$base" ] && [ "$u2" -gt "$base" ] && [ "$u1" != "$u2" ]; then
      ok "uid stepping: every agent seated above the taken base (base $base taken; seat1=$u1 seat2=$u2)"
    else
      bad "uid stepping: agents not seated above a taken base uid (base=$base seat1='$u1' seat2='$u2')"
    fi
  fi

  # ── Part C — behavioural, REAL nono ────────────────────────────────────────
  # cli#357 r4 — the real-nono cases cannot skip where the lane requires them.
  # With TPS_TEST_REQUIRE_NONO=1 an absent binary or a version other than the
  # pin record's version is a FAIL, not a SKIP.
  real_nono="${NONO_BIN:-$(command -v nono 2>/dev/null || true)}"
  pinned_nono_version="$(sed -n 's/^version=//p' "$repo_root/.nono-version" 2>/dev/null | head -n1)"
  nonready=""
  if [ -z "$real_nono" ] || [ ! -x "$real_nono" ]; then
    nonready="no nono binary (set NONO_BIN — the CI Docker lane mounts the pinned build)"
  else
    have_nono_version="$("$real_nono" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
    if [ -z "$pinned_nono_version" ]; then
      nonready="no version= line in $repo_root/.nono-version"
    elif [ "$have_nono_version" != "$pinned_nono_version" ]; then
      nonready="nono at $real_nono reports '${have_nono_version:-nothing}', not the pinned $pinned_nono_version"
    fi
  fi
  if [ -n "$nonready" ]; then
    if [ "${TPS_TEST_REQUIRE_NONO:-}" = 1 ]; then
      bad "real-nono cases are REQUIRED (TPS_TEST_REQUIRE_NONO=1) but $nonready"
    else
      printf 'SKIP  real-nono cases (%s)\n' "$nonready"
    fi
  elif [ ! -d "$profiles_src" ]; then
    bad "no bundled profiles at $profiles_src — real-nono cases cannot run"
  else
    real="$tmp/real"; mkdir -p "$real/bin"
    write_agent_shim "$real/bin"

    # cli#352 r6: the supervisor provisions the `tps` group (and the agent uids)
    # itself, with a bounded probe — that is not the harness's business, and the
    # harness must pass whether or not a tps user/group already exists here.

    # cli#352 r3: the supervisor resolves the profile itself and hands nono an
    # absolute path, so XDG_CONFIG_HOME is EMPTY in every Part C case — the
    # profile can only come from the BUNDLED dir the image ships (here: the
    # repo's copy in this test image; docker.yml asserts the SHIPPED image's own
    # default path). Supplying the profiles through XDG_CONFIG_HOME is exactly
    # the masking Sherlock flagged, so that crutch is gone.
    empty_xdg="$tmp/xdg-empty"; mkdir -p "$empty_xdg"
    # A private bundled copy for C.2: tps-base's /dev/null allow reverted.
    bad_bundled="$tmp/bundled-reverted"; mkdir -p "$bad_bundled"
    cp "$profiles_src"/*.json "$bad_bundled/"
    jq '(.filesystem.allow_file) -= ["/dev/null"]' "$bad_bundled/tps-base.json" >"$bad_bundled/tps-base.reverted.json" &&
      mv "$bad_bundled/tps-base.reverted.json" "$bad_bundled/tps-base.json"
    # C.4: a copy of the supervisor with the resolver reverted to the bare name.
    bare_sup="$tmp/tps-office-supervisor-bare-name"
    sed -E 's|--profile \\?"\$NONO_PROFILE\\?"|--profile tps-office|g' "$sup" >"$bare_sup"

    # The sandboxed child must run with a HOME it can WRITE (nono's session
    # registry lives there) and that is NOT inside a granted path. The supervisor
    # sets that HOME itself (the account's own home) — the harness's own HOME is
    # only for the direct nono runs below, so a `su -m` that preserved it would
    # mask a regression there. Both are asserted through the shim's AGENT-UP line
    # and by asking nono ps as the agent user with the passwd HOME (no -m).
    home="/home/harness-home"; mkdir -p "$home/.local/state"
    chmod -R 777 "$home"
    export HOME="$home"
    export AGENT_MARKER="$real/marker" AGENT_GIT_LOG="$real/git.log" AGENT_SLEEP="${AGENT_SLEEP:-6}"
    chmod -R 777 "$tmp"

    # C.1 — positive: empty XDG_CONFIG_HOME, profile from the bundled dir →
    # probe passes, agent launches, the session binds, git works.
    seed
    rm -f "$AGENT_MARKER" "$AGENT_GIT_LOG"
    XDG_CONFIG_HOME="$empty_xdg" TPS_NONO_PROFILES_DIR="$profiles_src" PATH="$real/bin:$PATH" timeout 60 bash "$sup" >"$real/out1.log" 2>&1 &
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
    if grep -q 'HOME=/home/agent-probe' "$AGENT_MARKER" 2>/dev/null; then
      ok "the launched agent's HOME is the agent's own writable home, not the supervisor's"
    else
      bad "the launched agent's HOME is not /home/agent-probe: $(grep -m1 'AGENT-UP' "$AGENT_MARKER" 2>/dev/null)"
    fi
    if [ "$git_done" -eq 1 ] && grep -q 'AGENT-GIT-RC 0' "$AGENT_MARKER" 2>/dev/null; then
      ok "git ls-remote https://github.com/tpsdev-ai/cli exits 0 inside the launched agent ($(tr -d '\n' <"$AGENT_GIT_LOG" | head -c 60))"
    else
      bad "git ls-remote did not exit 0 inside the launched agent (done=$git_done): $(tr '\n' ' ' <"$AGENT_GIT_LOG" 2>/dev/null | head -c 300)"
    fi
    # nono ps must show the session bound to the supervisor's child.  The
    # sandboxed nono runs as the per-agent user, and nono refuses to read a
    # session registry owned by another uid — so ask as that same user, with the
    # passwd HOME the launch used (no -m: the registry lives under
    # /home/<agent user>/.local/state).  nono records the profile as the path it
    # was HANDED (cli#352 r3), so the filter accepts the bare name or the
    # resolved path under test.
    ps_as_agent() { su -s /bin/bash "agent-probe" -c "exec '$real_nono' ps --json"; }
    for _ in $(seq 1 20); do
      [ -s /workspace/.tps/pids.json ] && break
      kill -0 "$sup_pid" 2>/dev/null || break
      sleep 0.5
    done
    sess=""
    for _ in $(seq 1 20); do
      sess="$(ps_as_agent 2>"$real/ps.err" | jq -c '[.[] | select((.profile == "tps-office" or (.profile // "" | endswith("/tps-office.json"))) and .status == "running")]' 2>/dev/null || true)"
      [ -n "$sess" ] && [ "$sess" != "[]" ] && break
      kill -0 "$sup_pid" 2>/dev/null || break
      sleep 0.5
    done
    n_sess="$(printf '%s' "$sess" | jq 'length' 2>/dev/null || echo 0)"
    if [ "${n_sess:-0}" -ge 1 ]; then ok "nono ps shows the running tps-office session ($(printf '%s' "$sess" | jq -r '.[0].name + " pid=" + (.[0].child_pid|tostring) + " profile=" + (.[0].profile|tostring)' 2>/dev/null))"; else bad "nono ps shows no running tps-office session (raw: '$sess' err: $(tr '\n' ' ' <"$real/ps.err" 2>/dev/null | head -c 200))"; fi
    if [ "${n_sess:-0}" -ge 1 ] && [ "$(printf '%s' "$sess" | jq -r '.[0].profile')" = "$profiles_src/tps-office.json" ]; then ok "the session records the RESOLVED profile path the supervisor passed"; else bad "the session does not record $profiles_src/tps-office.json ($(printf '%s' "$sess" | jq -r '.[0].profile // "none"' 2>/dev/null))"; fi
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

    # C.2 — fails-first: revert tps-base's /dev/null allow in a private bundled copy.
    seed
    rm -f "$AGENT_MARKER"
    XDG_CONFIG_HOME="$empty_xdg" TPS_NONO_PROFILES_DIR="$bad_bundled" PATH="$real/bin:$PATH" timeout 60 bash "$sup" >"$real/out2.log" 2>&1; rc2r=$?
    if [ "$rc2r" -ne 0 ]; then ok "fails-first: /dev/null allow reverted → supervisor refuses (exit $rc2r)"; else bad "fails-first: supervisor exited 0 with /dev/null not granted"; fi
    if grep -q 'refusing to launch the agent without isolation' "$real/out2.log"; then ok "the refusal names the nono/Landlock cause"; else bad "refusal message missing: $(tail -n 5 "$real/out2.log" | tr '\n' ' ')"; fi
    if [ ! -e "$AGENT_MARKER" ]; then ok "nothing launched when the probe failed (fail closed, all-or-nothing)"; else bad "an agent launched (or touched the marker) despite the probe failing: $(cat "$AGENT_MARKER" | tr '\n' ' ')"; fi
    if ! command -v pgrep >/dev/null 2>&1; then bad "pgrep missing; cannot assert no orphan"
    elif pgrep -f 'tps-agent start' >/dev/null 2>&1; then bad "an agent process survived the refusal"
    else ok "no agent process left after the refusal"; fi

    # C.3 — fails-first: NO profile reachable (empty XDG_CONFIG_HOME and no
    # bundled dir) → the named refusal fires before anything is launched.
    seed
    rm -f "$AGENT_MARKER"
    XDG_CONFIG_HOME="$empty_xdg" TPS_NONO_PROFILES_DIR="$tmp/no-such-bundled-dir" \
      PATH="$real/bin:$PATH" timeout 60 bash "$sup" >"$real/out3.log" 2>&1; rc3r=$?
    if [ "$rc3r" -ne 0 ]; then ok "fails-first: no profile anywhere → supervisor refuses (exit $rc3r)"; else bad "supervisor exited 0 with no profile reachable"; fi
    if grep -q 'profile file not found at' "$real/out3.log"; then ok "the refusal names the missing profile path"; else bad "refusal does not name the profile path: $(tail -n 5 "$real/out3.log" | tr '\n' ' ')"; fi
    if grep -qF "$tmp/no-such-bundled-dir" "$real/out3.log"; then ok "the refusal names the searched bundled dir"; else bad "the refusal omits the searched path"; fi
    if [ ! -e "$AGENT_MARKER" ]; then ok "nothing launched with no profile reachable (fail closed)"; else bad "an agent launched with no profile reachable"; fi

    # C.4 — fails-first: the resolver reverted to the BARE name (the pre-r3
    # shape). nono then has no profile in its own (empty) config dir and can
    # only report "Profile not found" — and the probe fails, so the supervisor
    # refuses although the profile IS present in the bundled dir.
    seed
    bare_out="$(XDG_CONFIG_HOME="$empty_xdg" TPS_NONO_PROFILES_DIR="$profiles_src" PATH="$real/bin:$PATH" "$real_nono" run --profile tps-office -- true 2>&1 || true)"
    case "$bare_out" in *'Profile not found'*) ok "a bare name is unresolvable for nono (empty config dir): $(printf '%s' "$bare_out" | head -c 60)" ;; *) bad "a bare name still resolved — C.4 would prove nothing: $bare_out" ;; esac
    rm -f "$AGENT_MARKER"
    XDG_CONFIG_HOME="$empty_xdg" TPS_NONO_PROFILES_DIR="$profiles_src" \
      PATH="$real/bin:$PATH" timeout 60 bash "$bare_sup" >"$real/out4.log" 2>&1; rc4r=$?
    if [ "$rc4r" -ne 0 ]; then ok "fails-first: resolver reverted to the bare name → the C.1 setup now refuses (exit $rc4r)"; else bad "the bare-name supervisor still launched — the resolver control is untested"; fi
    if [ ! -e "$AGENT_MARKER" ]; then ok "nothing launched with the resolver reverted"; else bad "an agent launched with the bare-name resolver"; fi

    # C.5 — cli#357 r4: bind to the session the supervisor launched: the one
    # running session whose nono supervisor descends from the PID it recorded in
    # the PID file (that PID is the launch above nono, as C.1 checks, so it is
    # never nono's own supervisor_pid). Record that session's id/name, signal the
    # supervisor, then ask real `nono ps` whether that exact session is gone,
    # along with its child and the PID file. Zero or several matches fail.
    seed
    rm -f "$AGENT_MARKER" "$AGENT_GIT_LOG"
    export AGENT_SLEEP=30
    XDG_CONFIG_HOME="$empty_xdg" TPS_NONO_PROFILES_DIR="$profiles_src" PATH="$real/bin:$PATH" bash "$sup" >"$real/out5.log" 2>&1 &
    sup5=$!
    up5=0
    for _ in $(seq 1 60); do
      if grep -q 'AGENT-UP' "$AGENT_MARKER" 2>/dev/null; then up5=1; break; fi
      kill -0 "$sup5" 2>/dev/null || break
      sleep 0.5
    done
    launched5=""
    for _ in $(seq 1 40); do
      if [ -s /workspace/.tps/pids.json ]; then launched5="$(jq -r 'to_entries[0].value' /workspace/.tps/pids.json 2>/dev/null || true)"; fi
      [ -n "$launched5" ] && break
      kill -0 "$sup5" 2>/dev/null || break
      sleep 0.5
    done
    sess5=""
    for _ in $(seq 1 40); do
      sess5=""
      if [ -n "$launched5" ]; then
        if ps_as_agent >"$real/ps5.before.json" 2>/dev/null; then ps5_status=0; else ps5_status=$?; fi
        if [ "$ps5_status" -eq 0 ] && jq -e -s 'length == 1 and (.[0] | type == "array")' "$real/ps5.before.json" >/dev/null 2>&1; then
          sess5="$(jq -c '.[] | select(.status == "running")' "$real/ps5.before.json" | while IFS= read -r s; do
            sp="$(printf '%s' "$s" | jq -r '.supervisor_pid // empty' 2>/dev/null)"
            if [ -n "$sp" ] && is_descendant_of "$sp" "$launched5"; then printf '%s\n' "$s"; fi
          done | jq -cs '.')"
        fi
      fi
      [ -n "$sess5" ] && [ "$sess5" != "[]" ] && break
      kill -0 "$sup5" 2>/dev/null || break
      sleep 0.5
    done
    sess5_id="$(printf '%s' "$sess5" | jq -r '.[0].session_id // empty' 2>/dev/null || true)"
    sess5_name="$(printf '%s' "$sess5" | jq -r '.[0].name // empty' 2>/dev/null || true)"
    child5="$(printf '%s' "$sess5" | jq -r '.[0].child_pid // empty' 2>/dev/null || true)"
    sess5_sup="$(printf '%s' "$sess5" | jq -r '.[0].supervisor_pid // empty' 2>/dev/null || true)"
    n_sess5="$(printf '%s' "$sess5" | jq 'length' 2>/dev/null || echo 0)"
    if [ "$up5" -eq 1 ] && [ -n "$launched5" ] && [ "${n_sess5:-0}" -eq 1 ] && [ -n "$sess5_id" ] && [ -n "$child5" ]; then ok "real-nono stop: the session launched by $launched5 ($sess5_name $sess5_id) runs before the signal (agent $child5)"; else bad "real-nono stop: not exactly one running session under the recorded launch (up=$up5 launched='${launched5:-}' matches=${n_sess5:-0} sess='$sess5')"; fi
    kill -TERM "$sup5" 2>/dev/null || true
    rc5r=99; fin5=0
    for _ in $(seq 1 60); do
      if ! kill -0 "$sup5" 2>/dev/null; then fin5=1; break; fi
      sleep 0.5
    done
    if [ "$fin5" -eq 1 ]; then wait "$sup5" 2>/dev/null; rc5r=$?; else kill -KILL "$sup5" 2>/dev/null || true; bad "real-nono stop: the supervisor did not exit after the signal"; fi
    if [ "$rc5r" -eq 0 ]; then ok "real-nono stop: the supervisor exits 0 on the handled signal"; else bad "real-nono stop: the supervisor exited $rc5r"; fi
    gone5=0
    for _ in $(seq 1 20); do
      gone5=1
      for p in $child5 $sess5_sup; do [ -n "$p" ] && kill -0 "$p" 2>/dev/null && gone5=0; done
      [ "$gone5" -eq 1 ] && break
      sleep 0.5
    done
    if [ "$gone5" -eq 1 ]; then ok "real-nono stop: the session child and its nono supervisor are gone"; else bad "real-nono stop: the session child '$child5' or its nono supervisor '$sess5_sup' survived"; fi
    ps5_status=1
    if [ -n "$sess5_id" ] || [ -n "$sess5_name" ]; then
      for _ in $(seq 1 20); do
        if ps_as_agent >"$real/ps5.after.json" 2>/dev/null; then ps5_status=0; else ps5_status=$?; fi
        if session_gone_in "$real/ps5.after.json" "$ps5_status" "$sess5_id" "$sess5_name"; then break; fi
        sleep 0.5
      done
    fi
    if [ -n "$sess5_id" ] || [ -n "$sess5_name" ]; then
      if session_gone_in "$real/ps5.after.json" "$ps5_status" "$sess5_id" "$sess5_name"; then
        ok "real-nono stop: the recorded session ($sess5_name $sess5_id) is no longer running in nono ps"
      else
        bad "real-nono stop: nono ps did not confirm the recorded session ($sess5_name ${sess5_id:-none}) gone (status=$ps5_status raw='$(cat "$real/ps5.after.json" 2>/dev/null)')"
      fi
    else
      bad "real-nono stop: no recorded session id or name"
    fi
    if [ ! -e /workspace/.tps/pids.json ]; then ok "real-nono stop: the PID file is removed"; else bad "real-nono stop: the PID file remains"; fi
    export AGENT_SLEEP=6
  fi
fi

printf '\ntest-tps-office-supervisor: %d passed, %d failed\n' "$npass" "$nfail"
[ "$nfail" -eq 0 ]
