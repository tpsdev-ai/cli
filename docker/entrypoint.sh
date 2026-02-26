#!/usr/bin/env bash
set -euo pipefail

if [ -f /workspace/bootstrap.sh ]; then
  cd /workspace
  exec /workspace/bootstrap.sh
elif [ -f /workspace/workspace/bootstrap.sh ]; then
  cd /workspace/workspace
  exec /workspace/workspace/bootstrap.sh
elif [ -f /workspace/.openclaw/openclaw.json ]; then
  mkdir -p "$HOME/.openclaw"
  ln -sfn /workspace/.openclaw "$HOME/.openclaw"
  exec openclaw gateway run --port 18800 --bind loopback > /workspace/gateway.log 2>&1
elif [ -f /workspace/../.openclaw/openclaw.json ]; then
  mkdir -p "$HOME/.openclaw"
  ln -sfn /workspace/../.openclaw "$HOME/.openclaw"
  exec openclaw gateway run --port 18800 --bind loopback > /workspace/gateway.log 2>&1
else
  echo "No openclaw config found"
  exit 1
fi
