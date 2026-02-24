#!/bin/bash
set -e
npm install -g openclaw
npm install -g @tpsdev-ai/cli || echo "TPS not on npm yet, skipping"
openclaw --version
echo "Branch office agent ready"
