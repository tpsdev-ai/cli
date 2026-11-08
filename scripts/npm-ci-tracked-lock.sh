#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 4 ] || [ "$1" != --via ]; then
  echo 'usage: npm-ci-tracked-lock.sh --via <npm|sfw> [--in-place] <tracked-dir> [<prefix>] [npm ci args...]' >&2
  exit 1
fi
case "$2" in
  npm) installer=(npm) ;;
  sfw) installer=(sfw npm) ;;
  *) echo "npm-ci-tracked-lock: unsupported installer: $2" >&2; exit 1 ;;
esac
shift 2
in_place=false
if [ "$1" = --in-place ]; then
  in_place=true
  shift
fi
fixture=$1
shift
lock="$fixture/package-lock.json"
if [ "$in_place" = true ]; then
  prefix=$fixture
else
  prefix=$1
  shift
fi
if ! command -v "${installer[0]}" >/dev/null; then
  echo "npm-ci-tracked-lock: ${installer[0]} is required; install refused" >&2
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
revision=$(bash "${BASH_SOURCE[0]%/*}/lib/npm-ci-revision.sh")
echo "npm-ci-tracked-lock: reading fixture files from $revision"
if [ "$in_place" = false ] && { [ -e "$prefix" ] || [ -L "$prefix" ]; }; then
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
if [ -e "$prefix/npm-shrinkwrap.json" ] || [ -L "$prefix/npm-shrinkwrap.json" ]; then
  echo "npm-ci-tracked-lock: npm-shrinkwrap.json refused: $prefix/npm-shrinkwrap.json" >&2
  exit 1
fi
if [ "$in_place" = false ]; then
  mkdir -p -- "$prefix"
fi
committed=$(mktemp -d)
trap 'rm -f -- "$committed/package-lock.json" "$committed/package.json"; rmdir -- "$committed"' EXIT
for path in "$lock" "$fixture/package.json"; do
  if ! git show "$revision:$path" > "$committed/${path##*/}"; then
    echo "npm-ci-tracked-lock: cannot read committed file: $path" >&2
    exit 1
  fi
done
if [ "$in_place" = true ]; then
  for file in package-lock.json package.json; do
    if ! cmp -- "$committed/$file" "$fixture/$file"; then
      echo "npm-ci-tracked-lock: working file differs from $revision: $fixture/$file" >&2
      exit 1
    fi
  done
  (cd -- "$fixture" && "${installer[@]}" ci "$@")
else
  cp "$committed/package.json" "$committed/package-lock.json" "$prefix/"
  "${installer[@]}" ci --prefix "$prefix" "$@"
fi
if ! cmp -- "$committed/package-lock.json" "$prefix/package-lock.json"; then
  exit 1
fi
