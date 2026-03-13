#!/usr/bin/env bash
# setup-branch-service.sh — install and start the branch supervisor
# Idempotent: safe to run multiple times
# Works on exe.dev containers (no systemd --user required)

set -euo pipefail

TPS_ROOT="${TPS_ROOT:-$HOME/.tps}"
SUPERVISOR_PID_FILE="$TPS_ROOT/branch-supervisor.pid"
SUPERVISOR_LOG="$TPS_ROOT/branch-supervisor.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPERVISOR_SCRIPT="$SCRIPT_DIR/branch-supervisor.sh"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] setup-branch-service: $*"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# Verify supervisor script exists
[ -f "$SUPERVISOR_SCRIPT" ] || die "branch-supervisor.sh not found at $SUPERVISOR_SCRIPT"

# Make it executable
chmod +x "$SUPERVISOR_SCRIPT"
log "Supervisor script: $SUPERVISOR_SCRIPT"

# Create TPS root if needed
mkdir -p "$TPS_ROOT"

# Check if supervisor already running
if [ -f "$SUPERVISOR_PID_FILE" ]; then
  existing_pid=$(cat "$SUPERVISOR_PID_FILE" 2>/dev/null || true)
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    log "Supervisor already running (pid $existing_pid) — nothing to do"
    exit 0
  else
    log "Stale supervisor PID file found — cleaning up"
    rm -f "$SUPERVISOR_PID_FILE"
  fi
fi

# Start supervisor in a new session (setsid) so SIGKILL to the branch child
# does not propagate up to the supervisor process group.
log "Starting branch supervisor..."
setsid nohup "$SUPERVISOR_SCRIPT" >> "$SUPERVISOR_LOG" 2>&1 &
SUPERVISOR_PID=$!

# Give it a moment to write its PID file
sleep 1

# Verify it started
if kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
  log "Branch supervisor started (pid $SUPERVISOR_PID)"
  log "Log: $SUPERVISOR_LOG"
  log "PID file: $SUPERVISOR_PID_FILE"
else
  die "Supervisor failed to start — check $SUPERVISOR_LOG"
fi
