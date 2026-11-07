#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo 'usage: npm-ci-tracked-lock.sh <fixture-dir> <prefix> [npm ci args...]' >&2
  exit 1
fi
fixture=$1
prefix=$2
shift 2
lock="$fixture/package-lock.json"
if ! git ls-files --error-unmatch -- "$lock" >/dev/null; then
  echo "npm-ci-tracked-lock: cannot verify tracked lock: $lock" >&2
  exit 1
fi
if ! command -v sfw >/dev/null; then
  echo 'npm-ci-tracked-lock: sfw is required; install refused' >&2
  exit 1
fi
for arg in "$@"; do
  case "$arg" in
    --prefix*|-C*|--global*|-g|--location*)
      echo "npm-ci-tracked-lock: directory override refused: $arg" >&2
      exit 1
      ;;
    --ignore-scripts|--no-audit|--no-fund) ;;
    *)
      echo "npm-ci-tracked-lock: unsupported npm ci argument: $arg" >&2
      exit 1
      ;;
  esac
done
mkdir -p -- "$prefix"
cp "$fixture/package.json" "$lock" "$prefix/"
sfw npm ci --prefix "$prefix" "$@"
if ! cmp -- "$lock" "$prefix/package-lock.json"; then
  exit 1
fi
