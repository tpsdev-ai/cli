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
revision=HEAD
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  if [[ ! "${GITHUB_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo 'npm-ci-tracked-lock: GITHUB_SHA must be 40 hex characters under GitHub Actions; install refused' >&2
    exit 1
  fi
  revision=$GITHUB_SHA
fi
echo "npm-ci-tracked-lock: reading fixture files from $revision"
if [ -e "$prefix" ] || [ -L "$prefix" ]; then
  if [ ! -d "$prefix" ] || [ ! -r "$prefix" ] || [ ! -x "$prefix" ]; then
    echo "npm-ci-tracked-lock: cannot inspect prefix: $prefix" >&2
    exit 1
  fi
  shopt -s dotglob nullglob
  prefix_entries=("$prefix"/*)
  if [ "${#prefix_entries[@]}" -ne 0 ]; then
    echo "npm-ci-tracked-lock: non-empty prefix refused: $prefix" >&2
    exit 1
  fi
fi
mkdir -p -- "$prefix"
committed=$(mktemp -d)
trap 'rm -f -- "$committed/package-lock.json" "$committed/package.json"; rmdir -- "$committed"' EXIT
for path in "$lock" "$fixture/package.json"; do
  if ! git show "$revision:$path" > "$committed/${path##*/}"; then
    echo "npm-ci-tracked-lock: cannot read committed file: $path" >&2
    exit 1
  fi
done
cp "$committed/package.json" "$committed/package-lock.json" "$prefix/"
sfw npm ci --prefix "$prefix" "$@"
if ! cmp -- "$committed/package-lock.json" "$prefix/package-lock.json"; then
  exit 1
fi
