#!/usr/bin/env bash
# Pre-fetch the Socket Firewall binary the pinned socketdev/action installs, with
# a bounded retry, and verify it against a sha256 pinned here (cli#898).
#
# The pinned action (v1.3.2) makes one un-retried download of this binary and
# verifies no checksum of its own. It reuses a binary already present at its
# tool-cache path, so the checks below run before the action can use the file:
# in an Actions job, a downloaded binary whose checksum does not match the pin,
# or a failed download, fails the job, so the action does not install a missing
# or unverified binary. The review sandbox skips the action and runs this script
# with RUNNER_TOOL_CACHE unset, so there it exits before the platform and
# checksum checks.
#
# Each job also attempts to restore a verified binary through actions/cache (the
# restore step that precedes this script). A restored entry whose checksum does
# not match the pin is discarded; the script downloads instead.
set -euo pipefail

# Test overrides are command-line flags only, which a workflow step cannot
# inject: workflow steps invoke this script with no arguments, so no
# SFW_PREFETCH_* variable can change the download URL or the pinned sha256.
# Clear any such variable inherited from the job environment. The rest of the
# job's shell environment (PATH, BASH_ENV) is trusted, as for any other step in
# the job.
for sfw_env_name in $(compgen -e); do
  case "${sfw_env_name}" in
    SFW_PREFETCH_*) unset "${sfw_env_name}" ;;
  esac
done

test_url=""
test_sha256=""
test_retry_delay=""
while [ $# -gt 0 ]; do
  case "$1" in
    --test-url)
      if [ $# -lt 2 ]; then
        echo "::error::--test-url requires a value" >&2
        exit 2
      fi
      test_url="$2"
      shift 2
      ;;
    --test-sha256)
      if [ $# -lt 2 ]; then
        echo "::error::--test-sha256 requires a value" >&2
        exit 2
      fi
      test_sha256="$2"
      shift 2
      ;;
    --test-retry-delay)
      if [ $# -lt 2 ]; then
        echo "::error::--test-retry-delay requires a value" >&2
        exit 2
      fi
      test_retry_delay="$2"
      shift 2
      ;;
    *)
      echo "::error::unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

FIREWALL_VERSION="1.15.4"

# Two environments reach this script. An Actions job sets GITHUB_ACTIONS=true
# and the runner sets RUNNER_TOOL_CACHE; there a missing tool cache is a job
# error, because the action has no place to install the binary. The review
# sandbox sets neither, runs run: steps but skips the action, so there is no
# tool cache to populate and nothing to check.
if [ -z "${RUNNER_TOOL_CACHE:-}" ]; then
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::error::RUNNER_TOOL_CACHE is unset in an Actions job; the Socket Firewall action has no tool cache to install into." >&2
    exit 1
  fi
  echo "RUNNER_TOOL_CACHE is unset and GITHUB_ACTIONS is not true; the review sandbox skips the firewall action, nothing to pre-fetch."
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

# The production URL and sha256 are the values above. Test flags may replace
# them; no workflow step passes one.
URL="https://github.com/SocketDev/sfw-free/releases/download/v${FIREWALL_VERSION}/sfw-free-${ASSET}"
if [ -n "${test_url}" ]; then
  URL="${test_url}"
fi
if [ -n "${test_sha256}" ]; then
  SHA256="${test_sha256}"
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

# A binary already in the action's tool cache is used only when the checksum
# tool found on the job's PATH reports the pinned sha256.
if [ -f "${CACHE_BINARY}" ]; then
  if [ "$(sha256_of "${CACHE_BINARY}")" = "${SHA256}" ]; then
    : > "${CACHE_DIR}.complete"
    exit 0
  fi
  rm -f "${CACHE_BINARY}" "${CACHE_DIR}.complete"
fi

# A restored cache entry is used only when the checksum tool found on the job's
# PATH reports the pinned sha256. A mismatched file is deleted and the download
# runs instead.
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
# still bounds the wait. --test-retry-delay replaces curl's backoff in the
# tests only.
retry_delay_args=()
if [ -n "${test_retry_delay}" ]; then
  retry_delay_args=(--retry-delay "${test_retry_delay}")
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
