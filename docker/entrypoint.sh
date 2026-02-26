#!/usr/bin/env bash
set -euo pipefail

if [ -f /workspace/bootstrap.sh ]; then
  cd /workspace
  /workspace/bootstrap.sh
elif [ -f /workspace/workspace/bootstrap.sh ]; then
  cd /workspace/workspace
  /workspace/workspace/bootstrap.sh
elif [ -f /workspace/.openclaw/openclaw.json ]; then
  openclaw gateway run --config /workspace/.openclaw/openclaw.json --port 18800 --bind lan
elif [ -f /workspace/../.openclaw/openclaw.json ]; then
  openclaw gateway run --config /workspace/../.openclaw/openclaw.json --port 18800 --bind lan
else
  echo "No openclaw config found"
  exit 1
fi
