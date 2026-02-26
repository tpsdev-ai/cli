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

  nono run \
    --allow "$workdir" \
    --allow "$tmpdir" \
    --allow /var/run/tps-proxy.sock \
    --allow /run/secrets \
    -- su -s /bin/bash "$user" -c "tps-agent start --config '$config_path'" &

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

cat > "$MONITOR_SCRIPT" <<'EOF'
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
EOF

chown tps-supervisor:tps "$MONITOR_SCRIPT"
chmod 700 "$MONITOR_SCRIPT"

# Drop privileges for steady-state supervision.
exec su -s /bin/bash tps-supervisor -c "$MONITOR_SCRIPT '$PIDS_FILE'"
