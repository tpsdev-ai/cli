#!/usr/bin/env bash
# Usage: assert-bun-version.sh <pinned> <actual> <service>
# Exits non-zero, naming the service, when <actual> differs from <pinned>.
set -euo pipefail
[ "$#" = 3 ] || { echo "usage: assert-bun-version.sh <pinned> <actual> <service>" >&2; exit 2; }
pinned="$1"
actual="$(printf '%s' "$2" | tr -d '[:space:]')"
service="$3"
if [ -z "$pinned" ] || [ "$actual" != "$pinned" ]; then
  printf 'assert-bun-version: service %s runs Bun %s, root packageManager pins %s\n' "$service" "${actual:-<none>}" "${pinned:-<none>}" >&2
  exit 1
fi
printf 'assert-bun-version: %s runs Bun %s\n' "$service" "$actual"
