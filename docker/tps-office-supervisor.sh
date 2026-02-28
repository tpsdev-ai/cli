#!/usr/bin/env bash
set -euo pipefail

TEAM_FILE="/workspace/.tps/team.json"
PIDS_FILE="/workspace/.tps/pids.json"

if [[ ! -f "$TEAM_FILE" ]]; then
  echo "Missing team file: $TEAM_FILE" >&2
  exit 1
fi

mkdir -p /workspace/.tps

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

  su -s /bin/bash "$user" -c "exec nono run --allow '$workdir' --allow '$tmpdir' -- bash -lc 'cat \"$probe_file\" >/dev/null'" >/dev/null 2>&1
  local rc=$?
  su -s /bin/bash "$user" -c "rm -f '$probe_file'" >/dev/null 2>&1 || true
  set -e

  [[ $rc -eq 0 ]]
}

uid=1001
for ((i=0; i<count; i++)); do
  id=$(echo "$agents_json" | jq -r ".[$i].id")
  config_path=$(echo "$agents_json" | jq -r ".[$i].configPath")

  if [[ -z "$id" || "$id" == "null" ]]; then
    echo "Agent missing id at index $i" >&2
    exit 1
  fi

  if [[ ! "$id" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "Invalid agent id at index $i: $id" >&2
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

  if ! id "$user" >/dev/null 2>&1; then
    useradd -u "$uid" -g tps -m -s /bin/bash "$user"
  fi

  mkdir -p "$workdir" "$tmpdir"
  chown -R "$user":tps "$workdir"
  chmod 700 "$workdir"

  chown -R "$user":tps "$tmpdir"
  chmod 700 "$tmpdir"

  if supports_landlock_for_agent "$user" "$workdir" "$tmpdir"; then
    su -m -s /bin/bash "$user" -c "exec nono run --allow '$workdir' --allow '$tmpdir' --allow /var/run/tps-proxy.sock -- tps-agent start --config '$config_path'" &
  else
    echo "⚠ Landlock incompatible with mount type for agent '$id' — falling back to UID isolation only" >&2
    su -m -s /bin/bash "$user" -c "exec tps-agent start --config '$config_path'" &
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
