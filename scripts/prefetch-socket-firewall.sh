#!/usr/bin/env bash
# Pre-fetch the Socket Firewall binary the pinned socketdev/action installs, with
# a bounded retry, and verify it against a sha256 pinned here (cli#898).
#
# The pinned action (v1.3.2) makes one un-retried download of this binary and
# verifies no checksum of its own. It reuses a binary already present at its
# tool-cache path, so the checks below run before the action can use the file:
# a downloaded binary that does not match the pin, or a failed download, fails
# the job, and the firewall is never skipped.
#
# Each job also attempts to restore a verified binary through actions/cache (the
# restore step that precedes this script). A restored entry that does not match
# the pin is discarded; the script downloads instead.
set -euo pipefail

FIREWALL_VERSION="1.15.4"

# The action runs only on an Actions runner, where RUNNER_TOOL_CACHE is set.
# The review sandbox runs run: steps without it and skips the action, so there
# is no cache to populate there.
if [ -z "${RUNNER_TOOL_CACHE:-}" ]; then
  echo "RUNNER_TOOL_CACHE is unset; the firewall action is not installed here, nothing to pre-fetch."
  exit 0
fi

# <platform>-<arch> as Node names it, the release asset suffix, and the sha256
# of that asset at FIREWALL_VERSION.
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    ARCH="x64"; ASSET="linux-x86_64"
    SHA256="cf9f55b8343e1ef6e6dcccdb09b99c70c0430a22ed7d0079286eccddeaf72670"
    ;;
  Linux-aarch64 | Linux-arm64)
    ARCH="arm64"; ASSET="linux-arm64"
    SHA256="c8c80aa582829f24f5d633f2c3f2ccd0b070bbee80bf3b956e5e2a9880184e20"
    ;;
  Darwin-x86_64)
    ARCH="x64"; ASSET="macos-x86_64"
    SHA256="b19f96f0dd3ebc4ecc7111dbc43cc2b095f37bf759273c0bd9c0c4784ea24731"
    ;;
  Darwin-arm64)
    ARCH="arm64"; ASSET="macos-arm64"
    SHA256="1b705ea7c399727ee41aa93f63e0469d2c3787c50e1dd8842cb8ff5ceec9eb99"
    ;;
  *)
    echo "::error::no Socket Firewall ${FIREWALL_VERSION} binary for $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

# Test-only seams, unset in CI: the retry test points the real curl at a local
# server, overrides the pin to that server's payload, and shortens the backoff.
# Unset, the URL and sha256 are the production values and curl uses its own
# backoff.
URL="${SFW_PREFETCH_URL:-https://github.com/SocketDev/sfw-free/releases/download/v${FIREWALL_VERSION}/sfw-free-${ASSET}}"
if [ -n "${SFW_PREFETCH_TEST_SHA256:-}" ]; then
  SHA256="${SFW_PREFETCH_TEST_SHA256}"
fi
CACHE_DIR="${RUNNER_TOOL_CACHE}/socket-firewall-free/${FIREWALL_VERSION}/${ARCH}"
CACHE_BINARY="${CACHE_DIR}/sfw"
# actions/cache restores this workspace-relative path before the script runs.
RESTORED_BINARY="${GITHUB_WORKSPACE:-$PWD}/.sfw-cache/sfw"

# GNU coreutils on Linux; macOS carries shasum.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

install_binary() {
  mkdir -p "${CACHE_DIR}"
  cp "$1" "${CACHE_BINARY}"
  chmod 0755 "${CACHE_BINARY}"
  : > "${CACHE_DIR}.complete"
}

# A binary already in the action's tool cache is used only when it matches the
# pin.
if [ -f "${CACHE_BINARY}" ]; then
  if [ "$(sha256_of "${CACHE_BINARY}")" = "${SHA256}" ]; then
    : > "${CACHE_DIR}.complete"
    exit 0
  fi
  rm -f "${CACHE_BINARY}" "${CACHE_DIR}.complete"
fi

# A restored cache entry is used only when its sha256 still matches the pin. A
# mismatched file is never used: it is deleted and the download runs instead.
if [ -f "${RESTORED_BINARY}" ]; then
  if [ "$(sha256_of "${RESTORED_BINARY}")" = "${SHA256}" ]; then
    install_binary "${RESTORED_BINARY}"
    exit 0
  fi
  echo "Cached Socket Firewall binary does not match the pinned sha256; discarding it." >&2
  rm -f "${RESTORED_BINARY}"
fi

tmp="$(mktemp "${RUNNER_TEMP:-/tmp}/sfw-prefetch.XXXXXX")"
trap 'rm -f "${tmp}"' EXIT

# Cold cache: bounded exponential backoff (curl doubles its delay between
# attempts), so an outage of a few minutes is ridden out but the job's timeout
# still bounds the wait. SFW_PREFETCH_RETRY_DELAY is test-only: unset in CI,
# where curl keeps its own backoff.
retry_delay_args=()
if [ -n "${SFW_PREFETCH_RETRY_DELAY:-}" ]; then
  retry_delay_args=(--retry-delay "${SFW_PREFETCH_RETRY_DELAY}")
fi
curl -fsSL --retry 8 --retry-all-errors --retry-max-time 300 --connect-timeout 20 --max-time 60 "${retry_delay_args[@]+"${retry_delay_args[@]}"}" -o "${tmp}" "${URL}"
if [ "$(sha256_of "${tmp}")" != "${SHA256}" ]; then
  echo "::error::Socket Firewall binary checksum mismatch; refusing to install it" >&2
  exit 1
fi

mkdir -p "$(dirname "${RESTORED_BINARY}")"
cp "${tmp}" "${RESTORED_BINARY}"
chmod 0755 "${RESTORED_BINARY}"
install_binary "${tmp}"
