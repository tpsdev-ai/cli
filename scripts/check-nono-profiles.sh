#!/usr/bin/env bash
# check-nono-profiles.sh — the fail-closed profile gate (cli#341, slice S1)
#
# Everything here fails LOUDLY. There is no "nono is missing, carry on" branch:
# a sandbox that cannot be loaded stops the build, exactly like it stops a run.
#
# It checks, in order:
#   1. nono is present (NONO_BIN, else PATH) and is >= the 0.70.0 floor
#   2. the bundled profile dir has no pre-2.0 *.toml left in it
#   3. every bundled profile passes `nono profile validate --strict`
#   4. real kernel enforcement is live: a granted write succeeds and a write to
#      a deny-listed path (~/.tps/secrets) does not
#
# Usage:
#   scripts/check-nono-profiles.sh
#   NONO_BIN=/path/to/nono scripts/check-nono-profiles.sh
#
# CI: set NONO_BIN (pinned) — see .github/workflows/test.yml "nono-profile-gate"
# (ubuntu-latest + macos-14).

set -euo pipefail

NONO_MIN_VERSION="0.70.0"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${REPO_ROOT}/packages/cli/nono-profiles"
REMEDY="brew untap always-further/nono && brew install nono"

fail() {
  echo "❌ $*" >&2
  exit 1
}

ok() {
  echo "  ✓ $*"
}

# ── 1. nono present and new enough ───────────────────────────────────────────
NONO_BIN="${NONO_BIN:-$(command -v nono || true)}"
if [[ -z "${NONO_BIN}" || ! -x "${NONO_BIN}" ]]; then
  fail "nono not found (NONO_BIN unset and no 'nono' on PATH).
   The sandbox cannot be verified without it. Install nono >= ${NONO_MIN_VERSION}: ${REMEDY}"
fi

RAW_VERSION="$("${NONO_BIN}" --version 2>/dev/null | head -1 || true)"
VERSION="$(printf '%s' "${RAW_VERSION}" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[[ -n "${VERSION}" ]] || fail "could not parse a version out of '${NONO_BIN} --version' (got: '${RAW_VERSION}')"

lowest="$(printf '%s\n%s\n' "${NONO_MIN_VERSION}" "${VERSION}" | sort -V | head -1)"
[[ "${lowest}" == "${NONO_MIN_VERSION}" ]] || fail "nono ${VERSION} is below the ${NONO_MIN_VERSION} floor (JSON profiles are not loadable there). ${REMEDY}"
ok "nono ${VERSION} at ${NONO_BIN} (floor ${NONO_MIN_VERSION})"

# ── 2. no pre-2.0 TOML left in the bundled dir ───────────────────────────────
[[ -d "${PROFILE_DIR}" ]] || fail "bundled profile dir missing: ${PROFILE_DIR}"
shopt -s nullglob
toml_files=("${PROFILE_DIR}"/*.toml)
json_files=("${PROFILE_DIR}"/*.json)
shopt -u nullglob

[[ ${#toml_files[@]} -eq 0 ]] || fail "pre-2.0 TOML profiles still bundled: ${toml_files[*]}"
[[ ${#json_files[@]} -gt 0 ]] || fail "no JSON profiles found in ${PROFILE_DIR}"
ok "no *.toml in ${PROFILE_DIR} (${#json_files[@]} JSON profiles)"

# ── 3. validate-or-FAIL, every profile ───────────────────────────────────────
for f in "${json_files[@]}"; do
  if ! out="$("${NONO_BIN}" profile validate --strict "${f}" 2>&1)"; then
    echo "${out}" >&2
    fail "profile does not validate: ${f}"
  fi
done
ok "all ${#json_files[@]} profiles pass 'nono profile validate --strict'"

# ── 4. real enforcement (control + denial) ───────────────────────────────────
# The probe tree lives under the REAL $HOME, not $TMPDIR. On macOS $TMPDIR is
# /private/var/folders/…, which the tps-agent-run profile reads (system_read_macos),
# and nono's own state root for the synthetic HOME ($TMP/home/.local/state/nono)
# would then sit inside /private — nono refuses the run outright
# ("… overlaps protected nono state root"), failing the positive control for the
# wrong reason. Under $HOME the synthetic state root cannot overlap a granted
# root. (A genuine enforcement break still fails loudly below.)
TMP="$(mktemp -d "${HOME:?}/.nono-gate-probe.XXXXXX")"
trap 'rm -rf "${TMP}"' EXIT
mkdir -p "${TMP}/home/.tps/secrets" "${TMP}/home/.tps/identity" "${TMP}/ws"

AGENT_PROFILE="${PROFILE_DIR}/tps-agent-run.json"

if ! HOME="${TMP}/home" "${NONO_BIN}" run --profile "${AGENT_PROFILE}" \
      --workdir "${TMP}/ws" --allow "${TMP}/ws" \
      -- sh -c "echo control > '${TMP}/ws/control'" >/dev/null 2>&1; then
  fail "positive control FAILED: a write to a granted path was blocked.
   The kernel backend is not enforcing for this host (landlock/Seatbelt), so the
   deny assertions below would be meaningless. Not treating that as a pass."
fi
[[ -f "${TMP}/ws/control" ]] || fail "positive control wrote no file (${TMP}/ws/control)"
ok "positive control: granted path is writable"

if HOME="${TMP}/home" "${NONO_BIN}" run --profile "${AGENT_PROFILE}" \
      --workdir "${TMP}/ws" --allow "${TMP}/ws" \
      -- sh -c "echo leak > '${TMP}/home/.tps/secrets/leak'" >/dev/null 2>&1; then
  fail "deny-list FAILED: a write to ~/.tps/secrets succeeded under tps-agent-run"
fi
[[ ! -f "${TMP}/home/.tps/secrets/leak" ]] || fail "deny-list FAILED: ${TMP}/home/.tps/secrets/leak exists"
ok "deny-list: write to ~/.tps/secrets is blocked"

# The agent must be able to read its OWN identity key (the launch grants
# ~/.tps/identity read; the base must not deny it — nono resolves deny over
# grant, so a stale deny would silently break signing). cli#341 S1b r2.
printf 'KEYMATERIAL' > "${TMP}/home/.tps/identity/agent1.key"
if ! ident_out="$(HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" run --profile "${AGENT_PROFILE}" \
      --workdir "${TMP}/ws" --allow "${TMP}/ws" --read "${TMP}/home/.tps/identity" \
      -- sh -c "cat '${TMP}/home/.tps/identity/agent1.key'" 2>&1)"; then
  fail "identity key read FAILED: the agent cannot read its own key under tps-agent-run"
fi
case "${ident_out}" in
  *KEYMATERIAL*) ok "agent identity key is readable under tps-agent-run" ;;
  *) fail "agent identity key not readable (got: ${ident_out})" ;;
esac

# nono why assertions (deny must survive the broad system reads).
why_denied() { # <path>
  local out verdict
  out="$(HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" why --path "$1" --op read --profile "${AGENT_PROFILE}" 2>&1 || true)"
  verdict="${out%%$'\n'*}"
  case "${out}" in
    *DENIED*) ok "denied: $1" ;;
    *) fail "expected DENIED for $1, got: ${verdict}" ;;
  esac
}
why_denied "${TMP}/home/.tps/secrets/leak"
why_denied "/etc/shadow"
why_denied "/etc/sudoers"
why_denied "/etc/ssh/ssh_host_rsa_key"

echo "✅ nono profile gate passed (nono ${VERSION}, ${#json_files[@]} profiles, enforcement verified)"
