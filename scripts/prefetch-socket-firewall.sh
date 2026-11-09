#!/usr/bin/env bash
# Pre-fetch the Socket Firewall binary the pinned socketdev/action installs, with
# a bounded retry, and verify it against a sha256 pinned here (cli#898).
#
# The pinned action (v1.3.2) makes one un-retried download of this binary and
# verifies no checksum of its own. It reuses a binary already present at its
# tool-cache path, so the checks below run before the action can use the file:
# a failed download or a checksum mismatch fails the job, and the firewall is
# never skipped.
set -euo pipefail

FIREWALL_VERSION="1.15.4"
# sha256 of SocketDev/sfw-free v1.15.4 sfw-free-linux-x86_64.
SHA256="cf9f55b8343e1ef6e6dcccdb09b99c70c0430a22ed7d0079286eccddeaf72670"
URL="https://github.com/SocketDev/sfw-free/releases/download/v${FIREWALL_VERSION}/sfw-free-linux-x86_64"

# The action runs only on an Actions runner, where RUNNER_TOOL_CACHE is set.
# The review sandbox runs run: steps without it and skips the action, so there
# is no cache to populate there.
if [ -z "${RUNNER_TOOL_CACHE:-}" ]; then
  echo "RUNNER_TOOL_CACHE is unset; the firewall action is not installed here, nothing to pre-fetch."
  exit 0
fi

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "::error::socket firewall pre-fetch supports linux-x64 only (this runner is $(uname -s)-$(uname -m))" >&2
  exit 1
fi

CACHE_DIR="${RUNNER_TOOL_CACHE}/socket-firewall-free/${FIREWALL_VERSION}/x64"
CACHE_BINARY="${CACHE_DIR}/sfw"

if [ -f "${CACHE_BINARY}" ] && echo "${SHA256}  ${CACHE_BINARY}" | sha256sum -c --status -; then
  exit 0
fi

tmp="$(mktemp "${RUNNER_TEMP:-/tmp}/sfw-prefetch.XXXXXX")"
trap 'rm -f "${tmp}"' EXIT

curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 --connect-timeout 20 --max-time 300 -o "${tmp}" "${URL}"
echo "${SHA256}  ${tmp}" | sha256sum -c -

mkdir -p "${CACHE_DIR}"
cp "${tmp}" "${CACHE_BINARY}"
chmod 0755 "${CACHE_BINARY}"
: > "${CACHE_DIR}.complete"
