#!/usr/bin/env bash
# docker-publish-index.sh — move the smoked per-platform OCI archives into the
# local registry, assemble their multi-platform index, and verify it (cli#353).
#
# Usage:
#   docker-publish-index.sh copy <archives-dir> <digests-file>
#   docker-publish-index.sh assemble <digests-file>
#   docker-publish-index.sh verify <digests-file> [raw-index-file]
#   docker-publish-index.sh push <dest-ref> [--rehearsal]
#
# Env:
#   PLATFORMS   comma-separated platform list (default linux/amd64,linux/arm64)
#   REGISTRY    local registry host:port (default localhost:5000)
#   REPOSITORY  image repository (default tps-office)
#
# copy: for each platform, find that platform's archive, read its raw digest,
# copy it with --all --preserve-digests to $REGISTRY/$REPOSITORY:<arch>, require
# the registry tag's raw digest to equal the archive's, and record the archive's
# PLATFORM image-manifest digest. A single-platform archive from a build with
# provenance is an index: the image manifest plus an attestation manifest
# (`unknown/unknown`, annotated vnd.docker.reference.type: attestation-manifest).
# The platform digest recorded is the index entry for the platform itself, not
# an attestation entry. The file gets "<platform> <arch> <index-digest>
# <image-manifest-digest>" per line.
#
# assemble: create $REGISTRY/$REPOSITORY:verify from the per-platform image
# manifests by digest.
#
# verify: the index's entries, excluding attestation entries, must be exactly
# PLATFORMS, each carrying the recorded image-manifest digest. Attestation
# entries are excluded because they describe build provenance, not a runnable
# platform image, so they are not part of the platform set this index promises.
# The checked entries are printed, and the raw index is written to
# [raw-index-file] when given.
# push: copy the local index and compare the destination's raw digest
# with the recorded local index digest. --rehearsal permits a local HTTP target.
#
# `skopeo` and `docker` come from PATH. test/docker-publish-index.test.ts runs
# this script with stubs of both.
set -euo pipefail

platforms="${PLATFORMS:-linux/amd64,linux/arm64}"
registry="${REGISTRY:-localhost:5000}"
repository="${REPOSITORY:-tps-office}"
command="${1:?usage: docker-publish-index.sh <copy|assemble|verify|push> ...}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Raw manifest bytes of a source, and their sha256. The bytes are captured to a
# file so the digest is computed over exactly what the command printed (the
# same handling here and for a registry tag, so the comparison is of like with
# like).
raw_digest() {
  local dest="$1" source="$2"
  skopeo inspect --raw "$source" >"$dest"
  printf 'sha256:%s' "$(sha256sum "$dest" | cut -d' ' -f1)"
}

# The image-manifest digest of <platform> in an index, skipping attestation
# entries: `unknown/unknown` is where buildx files them, and the annotation is
# the transportable marker. A source that is a plain image manifest (an archive
# built without provenance) is its own platform manifest.
platform_manifest_digest() {
  local raw="$1" platform="$2" index_digest="$3"
  if jq -e 'has("manifests")' "$raw" >/dev/null; then
    jq -r --arg p "$platform" '
      .manifests[]
      | select((.annotations["vnd.docker.reference.type"] // "") != "attestation-manifest")
      | select("\(.platform.os)/\(.platform.architecture)" == $p)
      | .digest
    ' "$raw" | head -n 1
  else
    printf '%s' "$index_digest"
  fi
}

case "$command" in
copy)
  archives="${2:?usage: docker-publish-index.sh copy <archives-dir> <digests-file>}"
  digests="${3:?usage: docker-publish-index.sh copy <archives-dir> <digests-file>}"
  : >"$digests"
  for platform in ${platforms//,/ }; do
    arch="${platform#linux/}"
    archive=""
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      if [ -n "$archive" ]; then
        echo "more than one archive for $platform: $archive and $candidate" >&2
        exit 1
      fi
      archive="$candidate"
    done < <(find "$archives" -type f -name "tps-office-$arch.oci.tar")
    if [ -z "$archive" ]; then
      echo "no tps-office-$arch.oci.tar in $archives for $platform" >&2
      exit 1
    fi

    source_raw="$tmp/$arch.source.json"
    source_digest="$(raw_digest "$source_raw" "oci-archive:$archive")"
    image_digest="$(platform_manifest_digest "$source_raw" "$platform" "$source_digest")"
    if [ -z "$image_digest" ]; then
      echo "no $platform image manifest in $archive (index entries: $(jq -r '.manifests[]? | "\(.platform.os // "?")/\(.platform.architecture // "?")"' "$source_raw" | paste -sd, -))" >&2
      exit 1
    fi

    skopeo copy --all --preserve-digests --dest-tls-verify=false \
      "oci-archive:$archive" "docker://$registry/$repository:$arch"

    target_raw="$tmp/$arch.target.json"
    skopeo inspect --tls-verify=false --raw "docker://$registry/$repository:$arch" >"$target_raw"
    target_digest="sha256:$(sha256sum "$target_raw" | cut -d' ' -f1)"
    if [ "$source_digest" != "$target_digest" ]; then
      echo "digest mismatch for $platform: archive $source_digest, local registry $target_digest" >&2
      exit 1
    fi
    printf '%s %s %s %s\n' "$platform" "$arch" "$source_digest" "$image_digest" >>"$digests"
  done
  cat "$digests"
  ;;
assemble)
  digests="${2:?usage: docker-publish-index.sh assemble <digests-file>}"
  set --
  while read -r _platform _arch _index image; do
    [ -n "$image" ] || continue
    set -- "$@" "$registry/$repository@$image"
  done <"$digests"
  if [ "$#" -eq 0 ]; then
    echo "no platform manifests recorded in $digests" >&2
    exit 1
  fi
  docker buildx imagetools create -t "$registry/$repository:verify" "$@"
  ;;
verify)
  digests="${2:?usage: docker-publish-index.sh verify <digests-file> [raw-index-file]}"
  raw_out="${3-}"
  if [ ! -s "$digests" ]; then
    echo "no platform manifests recorded in $digests" >&2
    exit 1
  fi

  raw="$tmp/index.json"
  skopeo inspect --tls-verify=false --raw "docker://$registry/$repository:verify" >"$raw"
  if ! jq -e 'has("manifests") and (.manifests | length > 0)' "$raw" >/dev/null; then
    echo "$registry/$repository:verify is not an image index" >&2
    exit 1
  fi
  actual="$(jq -r '
    .manifests[]
    | select((.annotations["vnd.docker.reference.type"] // "") != "attestation-manifest")
    | "\(.platform.os)/\(.platform.architecture) \(.digest)"
  ' "$raw" | sort)"
  expected="$(awk '{ print $1, $4 }' "$digests" | sort)"

  fail=0
  while read -r platform digest; do
    [ -n "$platform" ] || continue
    got="$(printf '%s\n' "$actual" | awk -v p="$platform" '$1 == p { print $2 }')"
    if [ -z "$got" ]; then
      echo "missing platform $platform (expected $digest)" >&2
      fail=1
    elif [ "$got" != "$digest" ]; then
      echo "wrong digest for $platform: expected $digest, index has $got" >&2
      fail=1
    fi
  done <<<"$expected"
  while read -r platform digest; do
    [ -n "$platform" ] || continue
    if ! printf '%s\n' "$expected" | awk -v p="$platform" '$1 == p { found = 1 } END { exit !found }'; then
      echo "unexpected platform $platform ($digest)" >&2
      fail=1
    fi
  done <<<"$actual"
  if [ "$fail" -ne 0 ]; then
    echo "the index entries do not match the recorded platform manifests:" >&2
    printf 'expected:\n%s\nactual:\n%s\n' "$expected" "$actual" >&2
    exit 1
  fi
  if [ -n "$raw_out" ]; then
    cp "$raw" "$raw_out"
  fi
  printf '%s\n' "$actual"
  ;;
push)
  dest="${2:?usage: docker-publish-index.sh push <dest-ref> [--rehearsal]}"
  tls_args=()
  inspect_args=()
  case "${3-}" in
    "") ;;
    --rehearsal) tls_args=(--dest-tls-verify=false); inspect_args=(--tls-verify=false) ;;
    *) echo "unknown push option: $3" >&2; exit 1 ;;
  esac
  [ "$#" -le 3 ] || { echo "too many push arguments" >&2; exit 1; }
  digest_file="${RUNNER_TEMP:-/tmp}/index-digest"
  [ -s "$digest_file" ] || { echo "missing local index digest: $digest_file" >&2; exit 1; }
  expected="$(cat "$digest_file")"
  skopeo copy --all --preserve-digests --src-tls-verify=false "${tls_args[@]}" \
    "docker://$registry/$repository:verify" "docker://$dest"
  target_raw="$tmp/pushed-index.json"
  skopeo inspect "${inspect_args[@]}" --raw "docker://$dest" >"$target_raw"
  actual="$(sha256sum "$target_raw" | cut -d' ' -f1)"
  if [ "$expected" != "$actual" ]; then
    echo "digest mismatch for $dest: local index $expected, registry $actual" >&2
    exit 1
  fi
  ;;
*)
  echo "unknown command: $command (expected copy, assemble, verify or push)" >&2
  exit 1
  ;;
esac
