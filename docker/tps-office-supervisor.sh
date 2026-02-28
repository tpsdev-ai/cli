#!/usr/bin/env bash
set -euo pipefail

TEAM_FILE="/workspace/.tps/team.json"
PIDS_FILE="/workspace/.tps/pids.json"
MONITOR_SCRIPT="/workspace/.tps/supervisor-monitor.sh"

if [[ ! -f "$TEAM_FILE" ]]; then
  echo "Missing team file: $TEAM_FILE" >&2
  exit 1
fi

mkdir -p /workspace/.tps

# S33B-E: Wait for secrets to be injected into tmpfs.
# Host writes secrets to /run/secrets/ then touches /run/secrets/.ready
SECRETS_DIR="/run/secrets"
SECRETS_TIMEOUT=30
elapsed=0
while [[ ! -f "$SECRETS_DIR/.ready" ]] && [[ $elapsed -lt $SECRETS_TIMEOUT ]]; do
  sleep 0.5
  elapsed=$((elapsed + 1))
done

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

chmod 644 "$PIDS_FILE"

cat > "$MONITOR_SCRIPT" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

PIDS_FILE="${1:?missing pids file}"

shutdown() {
  pids=$(jq -r 'to_entries[].value' "$PIDS_FILE")
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  for pid in $pids; do
    wait "$pid" 2>/dev/null || true
  done
}

trap shutdown SIGTERM SIGINT

wait -n || true
shutdown
EOS

chown tps-supervisor:tps "$MONITOR_SCRIPT"
chmod 700 "$MONITOR_SCRIPT"

# Drop privileges for steady-state supervision.
exec su -s /bin/bash tps-supervisor -c "$MONITOR_SCRIPT '$PIDS_FILE'"
