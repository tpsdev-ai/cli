#!/usr/bin/env bash
# branch-supervisor.sh — restart loop for tps branch daemon
# Writes supervisor PID to ~/.tps/branch-supervisor.pid
# Logs to ~/.tps/branch-supervisor.log
# Respects SIGTERM for clean shutdown

set -euo pipefail

TPS_ROOT="${TPS_ROOT:-$HOME/.tps}"
SUPERVISOR_PID_FILE="$TPS_ROOT/branch-supervisor.pid"
SUPERVISOR_LOG="$TPS_ROOT/branch-supervisor.log"
BRANCH_PID_FILE="$TPS_ROOT/branch.pid"
BACKOFF=5

# Resolve tps CLI — prefer dist binary, fall back to bun dev
if [ -f "$HOME/src/tpsdev-ai/cli/packages/cli/dist/bin/tps.js" ]; then
  TPS_BIN="$HOME/.bun/bin/bun"
  TPS_SCRIPT="$HOME/src/tpsdev-ai/cli/packages/cli/dist/bin/tps.js"
elif command -v tps &>/dev/null; then
  TPS_BIN="tps"
  TPS_SCRIPT=""
else
  echo "ERROR: tps not found" >&2
  exit 1
fi

run_branch() {
  if [ -n "$TPS_SCRIPT" ]; then
    TPS_BRANCH_DAEMON=1 "$TPS_BIN" "$TPS_SCRIPT" branch start
  else
    TPS_BRANCH_DAEMON=1 "$TPS_BIN" branch start
  fi
}

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$SUPERVISOR_LOG"
}

cleanup() {
  log "Supervisor received SIGTERM — shutting down"
  # Stop branch daemon if running
  if [ -f "$BRANCH_PID_FILE" ]; then
    local pid
    pid=$(cat "$BRANCH_PID_FILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "Stopping branch daemon (pid $pid)"
      kill -TERM "$pid" 2>/dev/null || true
      # Wait up to 5s for clean exit
      for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
    fi
  fi
  rm -f "$SUPERVISOR_PID_FILE"
  log "Supervisor exited cleanly"
  exit 0
}

trap cleanup SIGTERM SIGINT

mkdir -p "$TPS_ROOT"

# Write supervisor PID
echo $$ > "$SUPERVISOR_PID_FILE"
log "Branch supervisor started (pid $$)"

while true; do
  log "Starting branch daemon (TPS_BRANCH_DAEMON=1)..."

  # Run branch in foreground (TPS_BRANCH_DAEMON=1 skips the fork)
  run_branch &
  BRANCH_PID=$!

  # Wait for it to exit (or supervisor to be signaled)
  # Use set +e so SIGKILL exit doesn't abort the script
  set +e
  wait $BRANCH_PID 2>/dev/null
  EXIT_CODE=$?
  set -e

  # Exit code 0 means intentional stop (e.g. tps branch stop sent SIGTERM)
  if [ $EXIT_CODE -eq 0 ]; then
    log "Branch daemon exited cleanly (code 0) — not restarting"
    break
  fi

  log "Branch daemon exited (code $EXIT_CODE) — restarting in ${BACKOFF}s"
  sleep "$BACKOFF" &
  wait $! 2>/dev/null || true
done

rm -f "$SUPERVISOR_PID_FILE"
log "Supervisor exiting"
