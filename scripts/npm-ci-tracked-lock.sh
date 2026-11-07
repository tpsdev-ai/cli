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
committed=$(mktemp -d)
trap 'rm -f -- "$committed/package-lock.json" "$committed/package.json"; rmdir -- "$committed"' EXIT
for path in "$lock" "$fixture/package.json"; do
  if ! git show "HEAD:$path" > "$committed/${path##*/}"; then
    echo "npm-ci-tracked-lock: cannot read committed file: $path" >&2
    exit 1
  fi
done
mkdir -p -- "$prefix"
cp "$committed/package.json" "$committed/package-lock.json" "$prefix/"
sfw npm ci --prefix "$prefix" "$@"
if ! cmp -- "$committed/package-lock.json" "$prefix/package-lock.json"; then
  exit 1
fi
