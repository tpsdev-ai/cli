#!/usr/bin/env bash
set -euo pipefail

revision=HEAD
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  if [[ ! "${GITHUB_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo 'npm-ci-revision: GITHUB_SHA must be 40 hex characters under GitHub Actions; revision refused' >&2
    exit 1
  fi
  revision=$GITHUB_SHA
fi
printf '%s\n' "$revision"
