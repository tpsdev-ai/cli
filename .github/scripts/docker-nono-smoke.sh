#!/usr/bin/env bash
# docker-nono-smoke.sh — smoke the nono shipped in one loaded image.
#
# Usage: docker-nono-smoke.sh <platform> <image>
#
# The expected hash is read from docker/nono.sha256, which holds one line per
# platform: "<sha256> <platform>". A platform with no line fails. The binary is
# copied out of the image and hashed on the host, then executed in the image for
# that platform. Its `--version` must print
# exactly "nono <version>", with <version> read from .nono-version, and it must
# exit 0. A red smoke therefore means a missing hash line, a hash mismatch, a
# wrong version, or a failed run.
set -euo pipefail

platform="${1:?usage: docker-nono-smoke.sh <platform> <image>}"
image="${2:?usage: docker-nono-smoke.sh <platform> <image>}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hash_file="$root/docker/nono.sha256"
[ -f "$hash_file" ] || {
  echo "missing nono hash file: $hash_file" >&2
  exit 1
}
version_file="$root/.nono-version"
[ -f "$version_file" ] || {
  echo "missing nono version file: $version_file" >&2
  exit 1
}

expected=""
while read -r hash p _; do
  if [ "$p" = "$platform" ]; then
    expected="$hash"
    break
  fi
done <"$hash_file"
if [ -z "$expected" ]; then
  echo "no nono hash for platform $platform in $hash_file" >&2
  exit 1
fi

expected_version="$(sed -n 's/^version=//p' "$version_file" | head -n 1)"
if [ -z "$expected_version" ]; then
  echo "no version= line in $version_file" >&2
  exit 1
fi

tmp="$(mktemp -d)"
cid=""
cleanup() {
  rm -rf "$tmp"
  if [ -n "$cid" ]; then docker rm "$cid" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

cid="$(docker create --platform "$platform" "$image")"
docker cp "$cid:/usr/local/bin/nono" "$tmp/nono"
test -f "$tmp/nono"
test ! -L "$tmp/nono"
actual="$(sha256sum "$tmp/nono" | cut -d' ' -f1)"
if [ "$actual" != "$expected" ]; then
  echo "nono hash mismatch for $platform: expected $expected, actual $actual" >&2
  exit 1
fi

out="$(docker run --rm --platform "$platform" --entrypoint /usr/local/bin/nono "$image" --version)"
if [ "$out" != "nono $expected_version" ]; then
  echo "nono version mismatch for $platform: expected 'nono $expected_version', got '$out'" >&2
  exit 1
fi
printf '%s\n' "$out"
