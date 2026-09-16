#!/usr/bin/env bash
set -euo pipefail

TEAM_FILE="/workspace/.tps/team.json"
PIDS_FILE="/workspace/.tps/pids.json"

# cli#352 r — supervisor-path parity with cli#351 (S1b).
#
# 1. STATE_ROOT is the roster's OWN state root — the directory that holds the
#    team.json this supervisor was handed. The identity grant and the key path
#    derive from THAT plus the roster entry's `id`, never from a field inside the
#    agent's writable config (the agent can rewrite its own agent.yaml, so a
#    config-derived grant would let one agent name another agent's key).
# 2. SBOX_ENV is the same child environment cli#351 r5c's sandboxChildEnv()
#    exports on the CLI path. `docker/tps-office-supervisor.sh` and
#    `packages/cli/src/utils/nono.ts` are two launch points for the same
#    workload; test/security-properties.test.ts asserts these pairs EQUAL
#    sandboxChildEnv() so the two cannot drift.
# 3. The profile is passed to nono as the RESOLVED ABSOLUTE PATH, never a bare
#    name (cli#352 r3) — same two candidates, same order, as the CLI path's
#    resolveProfilePath() in packages/cli/src/utils/nono.ts. nono resolves a
#    bare name against its OWN search dir (~/.config/nono/profiles), which the
#    office image never populates (installNonoProfiles() runs only from `tps
#    identity init`, which the container never runs), so a bare name made the
#    Landlock probe fail for the WRONG reason (profile not found) and
#    fail-closed then refused every office agent. A profile that resolves
#    nowhere is a named refusal before anything is launched.
STATE_ROOT="${TPS_STATE_ROOT:-"$(dirname "$TEAM_FILE")"}"
readonly SBOX_ENV=("TPS_NONO_ACTIVE=1" "GIT_CONFIG_GLOBAL=/dev/null")

# System read files the launch must add by name (Linux cannot grant /etc
# wholesale — Landlock deny-within-allow; cli#351 r5b). Same list as the CLI's
# systemReadFiles(); test/security-properties.test.ts asserts the equality.
SBOX_SYSTEM_READ_FILES=("/etc/hosts" "/etc/resolv.conf" "/etc/nsswitch.conf" "/etc/gitconfig")

if [[ ! -f "$TEAM_FILE" ]]; then
  echo "Missing team file: $TEAM_FILE" >&2
  exit 1
fi

mkdir -p /workspace/.tps

# cli#352 r3 — resolve the TPS profile to an absolute path BEFORE any launch.
# Candidates, in the CLI path's order: the operator's nono config dir, then the
# directory the image ships the profiles in. TPS_NONO_PROFILES_DIR only moves
# the bundled candidate (the harness points it at a fixture copy or at a
# nonexistent directory); the shipped default is the image's COPY destination.
PROFILE_NAME="tps-office"
BUNDLED_PROFILES_DIR="${TPS_NONO_PROFILES_DIR:-/usr/local/share/tps/nono-profiles}"

resolve_profile_path() { # <name> -> absolute path on stdout; empty when unresolved
  local name="$1" candidate
  for candidate in "${HOME:-/root}/.config/nono/profiles/$name.json" "$BUNDLED_PROFILES_DIR/$name.json"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NONO_PROFILE="$(resolve_profile_path "$PROFILE_NAME" || true)"
if [[ -z "$NONO_PROFILE" ]]; then
  # Named refusal: name the paths that were searched. A bare name is never
  # passed to nono — that is the failure this resolution deletes.
  echo "❌ profile file not found at $BUNDLED_PROFILES_DIR/$PROFILE_NAME.json (not in ${HOME:-/root}/.config/nono/profiles/ either) — refusing to launch: nono is never given a bare profile name" >&2
  exit 1
fi

# S33B-I: Proxy socket integrity check (if mounted).
# If path exists, it must be a UNIX domain socket (not regular file/symlink).
PROXY_SOCK="/var/run/tps-proxy.sock"
if [[ -e "$PROXY_SOCK" ]] && [[ ! -S "$PROXY_SOCK" ]]; then
  echo "Invalid proxy socket at $PROXY_SOCK (not a UNIX socket)" >&2
  exit 1
fi

# S33B-E: Wait for secrets to be injected into tmpfs.
# Host writes secrets to /run/secrets/ then touches /run/secrets/.ready
SECRETS_DIR="/run/secrets"
SECRETS_TIMEOUT=30
elapsed=0
while [[ ! -f "$SECRETS_DIR/.ready" ]] && [[ $elapsed -lt $((SECRETS_TIMEOUT * 2)) ]]; do
  sleep 0.5
  elapsed=$((elapsed + 1))
done

if [[ ! -f "$SECRETS_DIR/.ready" ]]; then
  echo "Timed out waiting for $SECRETS_DIR/.ready" >&2
  exit 1
fi

# Load secrets into environment, then unlink all files.
# After this, secrets exist only in this process's memory.
if [[ -d "$SECRETS_DIR" ]]; then
  for secret_file in "$SECRETS_DIR"/*; do
    [[ -f "$secret_file" ]] || continue
    fname=$(basename "$secret_file")
    [[ "$fname" == ".ready" ]] && continue
    export "$fname"="$(cat "$secret_file")"
    rm -f "$secret_file"
  done
  rm -f "$SECRETS_DIR/.ready"
fi

declare -a AGENT_IDS=()
declare -a AGENT_PIDS=()

cleanup_pids_file() {
  rm -f "$PIDS_FILE"
}

kill_stale_pids() {
  [[ -f "$PIDS_FILE" ]] || return 0

  if ! jq -e type "$PIDS_FILE" >/dev/null 2>&1; then
    echo "Invalid stale pids file at $PIDS_FILE; removing" >&2
    rm -f "$PIDS_FILE"
    return 0
  fi

  mapfile -t stale_pids < <(jq -r 'to_entries[].value' "$PIDS_FILE" 2>/dev/null || true)
  if [[ ${#stale_pids[@]} -eq 0 ]]; then
    rm -f "$PIDS_FILE"
    return 0
  fi

  echo "Found stale pids file; cleaning up old child processes" >&2
  for pid in "${stale_pids[@]}"; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  sleep 1

  for pid in "${stale_pids[@]}"; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done

  rm -f "$PIDS_FILE"
}

write_pids_file() {
  {
    echo "{";
    for ((i=0; i<${#AGENT_IDS[@]}; i++)); do
      id="${AGENT_IDS[$i]}"
      pid="${AGENT_PIDS[$i]}"
      comma=",";
      if [[ $i -eq $((${#AGENT_IDS[@]} - 1)) ]]; then
        comma=""
      fi
      echo "  \"$id\": $pid$comma"
    done
    echo "}"
  } > "$PIDS_FILE"

  chmod 644 "$PIDS_FILE"
}

shutdown_children() {
  local signal="${1:-TERM}"

  if [[ ${#AGENT_PIDS[@]} -gt 0 ]]; then
    for pid in "${AGENT_PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        kill -"$signal" "$pid" 2>/dev/null || true
      fi
    done

    for pid in "${AGENT_PIDS[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  cleanup_pids_file
}

on_signal() {
  local signal="$1"
  trap - SIGTERM SIGINT
  shutdown_children "$signal"
  exit 0
}

trap 'on_signal TERM' SIGTERM
trap 'on_signal INT' SIGINT
trap cleanup_pids_file EXIT

kill_stale_pids

# Accept either:
# 1) [ { id, workspace, configPath }, ... ]
# 2) { agents: [ { id, workspace, configPath }, ... ] }
agents_json=$(jq -c 'if type=="array" then . else .agents end' "$TEAM_FILE")
count=$(echo "$agents_json" | jq 'length')

if [[ "$count" -eq 0 ]]; then
  echo "No agents in $TEAM_FILE" >&2
  exit 1
fi

if ! id tps-supervisor >/dev/null 2>&1; then
  useradd -r -g tps -M -s /usr/sbin/nologin tps-supervisor
fi

supports_landlock_for_agent() {
  local user="$1"
  local workdir="$2"
  local tmpdir="$3"

  local probe_file="$workdir/.landlock-probe"
  set +e
  su -s /bin/bash "$user" -c "echo probe > '$probe_file'" >/dev/null 2>&1
  if [[ $? -ne 0 ]]; then
    set -e
    return 1
  fi

  su -s /bin/bash "$user" -c "exec nono run --profile \"$NONO_PROFILE\" --allow '$workdir' --allow '$tmpdir' -- bash -lc 'cat \"$probe_file\" >/dev/null'" >/dev/null 2>&1
  local rc=$?
  su -s /bin/bash "$user" -c "rm -f '$probe_file'" >/dev/null 2>&1 || true
  set -e

  [[ $rc -eq 0 ]]
}

uid=1001

# cli#352 r (b) — the launched agent inherits the SAME exports the CLI path's
# sandboxChildEnv() sets, from one list (asserted equal by
# test/security-properties.test.ts). `su -m` preserves the environment into the
# nono child, so exporting here reaches the sandboxed agent.
export "${SBOX_ENV[@]}"

for ((i=0; i<count; i++)); do
  id=$(echo "$agents_json" | jq -r ".[$i].id")
  config_path=$(echo "$agents_json" | jq -r ".[$i].configPath")

  if [[ -z "$id" || "$id" == "null" ]]; then
    echo "Agent missing id at index $i" >&2
    exit 1
  fi

  if [[ ! "$id" =~ ^[a-zA-Z0-9._-]{1,64}$ || "$id" == *..* ]]; then
    echo "Invalid agent id at index $i: $id — must match ^[a-zA-Z0-9._-]{1,64}$ and contain no traversal" >&2
    exit 1
  fi

  if [[ -z "$config_path" || "$config_path" == "null" ]]; then
    echo "Agent missing configPath at index $i" >&2
    exit 1
  fi

  if [[ ! "$config_path" =~ ^[a-zA-Z0-9_./-]+$ ]]; then
    echo "Invalid configPath for agent '$id': $config_path" >&2
    exit 1
  fi

  user="agent-$id"
  workdir="/workspace/$id"
  tmpdir="/tmp/agent-$id"

  # cli#352 r (a) — the launch id is the ROSTER entry's (validated above). The
  # agent's config can be rewritten by the agent itself, so it may only VETO:
  # `tps-agent check` applies the same rule the launch does (charset, traversal,
  # and config.agentId must agree — refusing names both) and refuses BEFORE
  # anything is launched, so a refusal cannot leave a partial team running.
  # Fail closed when tps-agent is missing too (the launch would 127 anyway).
  if ! check_out="$(tps-agent check --id "$id" --config "$config_path" 2>&1)"; then
    echo "❌ agent '$id': refusing to launch — ${check_out:-tps-agent check failed}" >&2
    shutdown_children TERM
    exit 1
  fi

  if ! id "$user" >/dev/null 2>&1; then
    useradd -u "$uid" -g tps -m -s /bin/bash "$user"
  fi

  mkdir -p "$workdir" "$tmpdir"
  chown -R "$user":tps "$workdir"
  chmod 700 "$workdir"

  chown -R "$user":tps "$tmpdir"
  chmod 700 "$tmpdir"

  # The sandbox grant list. Only the roster id feeds the identity path: the key
  # it derives is the ONE thing the launched runtime must read outside its
  # workspace, and deriving it from `config.agentId` would let an agent that can
  # write its own agent.yaml name someone else's key (cli#351 r5, one launch
  # point later). Missing files are skipped (nono refuses to load a profile
  # whose grant list names a path that does not exist).
  launch_args=(run --profile "$NONO_PROFILE" --name "tps-agent-$id"
    --allow "$workdir" --allow "$tmpdir" --allow /var/run/tps-proxy.sock)
  for f in "${SBOX_SYSTEM_READ_FILES[@]}"; do
    [[ -e "$f" ]] && launch_args+=(--read-file "$f")
  done
  for k in "$STATE_ROOT/identity/$id.key" "$STATE_ROOT/identity/$id.pub"; do
    if [[ -f "$k" ]]; then
      launch_args+=(--read-file "$k")
    else
      # cli#352 r3 (4a) — the office never writes this file: office.ts writes
      # only team.json under the mount root, and the key-creating paths (`tps
      # agent create`, `tps branch`, `tps identity init`) write into the
      # operator's own $HOME/.tps/identity on the HOST — not into this bind
      # mount. The runtime resolves $HOME/.tps/identity/<agentId>.key, so name
      # the path this grant expects AND where it lives on the host.
      echo "ℹ️  agent '$id': no identity file at $k — the office does not create it;" \
        "place the agent's Ed25519 key there (host side: <branch-office>/<team id>/<state root>/.tps/identity/$id.key," \
        "the same mount that holds team.json) or the agent cannot sign as '$id'" >&2
    fi
  done

  if supports_landlock_for_agent "$user" "$workdir" "$tmpdir"; then
    su -m -s /bin/bash "$user" -c "exec nono ${launch_args[*]} -- tps-agent start --id '$id' --config '$config_path'" &
  else
    # FAIL CLOSED (cli#341 S2). The previous UID-only fallback launched the agent
    # with NO nono isolation; that path is deleted. If nono cannot engage (it is
    # missing, or Landlock cannot enforce the tps-office profile) the supervisor
    # refuses rather than running an agent unsandboxed.
    #
    # All-or-nothing (cli#352 r): the refusal fires mid-loop, so agents launched
    # in earlier iterations are already backgrounded. Stop them before exiting so
    # a refusal leaves NO agent running — a team is either whole or absent,
    # never partial. (The EXIT trap only removes pids.json.)
    echo "❌ agent '$id': nono could not engage (nono missing, or Landlock cannot enforce the profile at $NONO_PROFILE) — refusing to launch the agent without isolation" >&2
    shutdown_children TERM
    exit 1
  fi

  pid=$!
  AGENT_IDS+=("$id")
  AGENT_PIDS+=("$pid")

  uid=$((uid + 1))
done

write_pids_file

wait -n || true
shutdown_children TERM
exit 0
