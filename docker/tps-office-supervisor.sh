#!/usr/bin/env bash
set -euo pipefail

TEAM_FILE="/workspace/.tps/team.json"
PIDS_FILE="/workspace/.tps/pids.json"

if [[ ! -f "$TEAM_FILE" ]]; then
  echo "Missing team file: $TEAM_FILE" >&2
  exit 1
fi

mkdir -p /workspace/.tps

declare -a AGENT_IDS=()
declare -a AGENT_PIDS=()

shutdown() {
  for pid in "${AGENT_PIDS[@]:-}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  for pid in "${AGENT_PIDS[@]:-}"; do
    if [[ -n "${pid:-}" ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
}

trap shutdown SIGTERM SIGINT

# Accept either:
# 1) [ { id, workspace, configPath }, ... ]
# 2) { agents: [ { id, workspace, configPath }, ... ] }
agents_json=$(jq -c 'if type=="array" then . else .agents end' "$TEAM_FILE")
count=$(echo "$agents_json" | jq 'length')

if [[ "$count" -eq 0 ]]; then
  echo "No agents in $TEAM_FILE" >&2
  exit 1
fi

uid=1001
for ((i=0; i<count; i++)); do
  id=$(echo "$agents_json" | jq -r ".[$i].id")
  workspace=$(echo "$agents_json" | jq -r ".[$i].workspace")
  config_path=$(echo "$agents_json" | jq -r ".[$i].configPath")

  if [[ -z "$id" || "$id" == "null" ]]; then
    echo "Agent missing id at index $i" >&2
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

  nono run --allow "$workdir" --allow "$tmpdir" -- \
    su -s /bin/bash "$user" -c "tps-agent start --config $config_path" &

  pid=$!
  AGENT_IDS+=("$id")
  AGENT_PIDS+=("$pid")

  uid=$((uid + 1))
done

{
  echo "{";
  for ((i=0; i<${#AGENT_IDS[@]}; i++)); do
    id="${AGENT_IDS[$i]}"
    pid="${AGENT_PIDS[$i]}"
    comma=","
    if [[ $i -eq $((${#AGENT_IDS[@]} - 1)) ]]; then
      comma=""
    fi
    echo "  \"$id\": $pid$comma"
  done
  echo "}"
} > "$PIDS_FILE"

wait -n || true
shutdown
