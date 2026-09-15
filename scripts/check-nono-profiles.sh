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

# Identity reads (cli#351 r4): the launch grants exactly the launching agent's
# OWN key via --read-file. nono's read model is an allow-list, so no directory
# deny is needed; the assertion proves own-key ALLOWED and a sibling DENIED.
printf 'KEYMATERIAL' > "${TMP}/home/.tps/identity/agent1.key"
printf 'PUB' > "${TMP}/home/.tps/identity/agent1.pub"
printf 'OTHERKEY' > "${TMP}/home/.tps/identity/agent2.key"
if ! ident_out="$(HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" run --profile "${AGENT_PROFILE}" \
      --workdir "${TMP}/ws" --allow "${TMP}/ws" --read-file "${TMP}/home/.tps/identity/agent1.key" \
      -- sh -c "cat '${TMP}/home/.tps/identity/agent1.key'" 2>&1)"; then
  fail "own-key read FAILED: the agent cannot read its own key under tps-agent-run"
fi
case "${ident_out}" in
  *KEYMATERIAL*) ok "own identity key is readable under tps-agent-run" ;;
  *) fail "own identity key not readable (got: ${ident_out})" ;;
esac
# the sibling key must NOT be readable (no directory grant)
if HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" run --profile "${AGENT_PROFILE}" \
      --workdir "${TMP}/ws" --allow "${TMP}/ws" --read-file "${TMP}/home/.tps/identity/agent1.key" \
      -- sh -c "cat '${TMP}/home/.tps/identity/agent2.key'" >/dev/null 2>&1; then
  fail "sibling identity key is READABLE under tps-agent-run — the launch must grant only the agent's own key"
else
  ok "sibling identity key is not readable under tps-agent-run"
fi

# nono why assertions (the launch's own-key grant is the only identity read;
# everything else is denied).
why_denied() { # <path>
  local out verdict
  out="$(HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" why --path "$1" --op read \
        --profile "${AGENT_PROFILE}" --read-file "${TMP}/home/.tps/identity/agent1.key" 2>&1 || true)"
  verdict="${out%%$'\n'*}"
  case "${out}" in
    *DENIED*) ok "denied: $1" ;;
    *) fail "expected DENIED for $1, got: ${verdict}" ;;
  esac
}
why_allowed() { # <path>
  local out verdict
  out="$(HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" why --path "$1" --op read \
        --profile "${AGENT_PROFILE}" --read-file "${TMP}/home/.tps/identity/agent1.key" 2>&1 || true)"
  verdict="${out%%$'\n'*}"
  case "${out}" in
    *ALLOWED*) ok "allowed: $1" ;;
    *) fail "expected ALLOWED for $1, got: ${verdict}" ;;
  esac
}
why_allowed "${TMP}/home/.tps/identity/agent1.key"
why_denied "${TMP}/home/.tps/identity/agent2.key"
why_denied "${TMP}/home/.tps/secrets/leak"
why_denied "/etc/shadow"
why_denied "/etc/sudoers"
why_denied "/etc/ssh/ssh_host_rsa_key"

# /dev/null read+write must be ALLOWED for EVERY shipped profile — it is the
# tps-base allow_file every profile inherits, and without it `cmd >/dev/null`
# and `git ls-remote` die inside the sandbox (cli#351 r5). HOME=/ keeps the
# synthetic state root clear of profiles that grant /home or /tmp.
for f in "${PROFILE_DIR}"/*.json; do
  pname="$(basename "$f" .json)"
  out="$(HOME=/ NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" why --path /dev/null --op readwrite --profile "$f" 2>&1 || true)"
  case "${out}" in
    *ALLOWED*) ok "/dev/null readwrite ALLOWED (${pname})" ;;
    *) fail "/dev/null readwrite DENIED under ${pname}" ;;
  esac
done

# ── 5. WORKLOAD smoke under the EXACT launch args (cli#351 r5) ───────────────
# Built with the SAME helper the launch uses (harnessReadPaths/harnessReadFiles),
# so the gate exercises what the agent actually gets: a shell redirect to
# /dev/null, `git ls-remote` over https (TLS CA), and a `fetch`.
if ! command -v bun >/dev/null 2>&1; then
  fail "bun not on PATH — the workload smoke needs it to build the launch args"
else
  PROBE_WS="${TMP}/ws"
  LAUNCH=()
  while IFS= read -r _arg; do LAUNCH+=("$_arg"); done < <(WS="${PROBE_WS}" ID=probeagent PROF="${AGENT_PROFILE}" \
    bun -e 'import { harnessReadPaths, harnessReadFiles } from "./packages/cli/src/utils/nono.ts"; const a=["run","--profile",process.env.PROF,"--allow-cwd","--workdir",process.env.WS,"--allow",process.env.WS]; for(const p of harnessReadPaths()) a.push("--read",p); for(const p of harnessReadFiles(process.env.ID)) a.push("--read-file",p); for(const x of a) console.log(x);')
  smoke() { # <label> <cmd...>
    local label="$1"; shift
    if HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" "${LAUNCH[@]}" -- "$@" >"${TMP}/smoke.log" 2>&1; then
      ok "workload: ${label}"
    else
      # Surface the failure detail: a sandboxed git/fetch that fails must not be
      # a silent red. (flint: never skip silently.)
      fail "workload FAILED under the launch args: ${label} — $(tail -n 6 "${TMP}/smoke.log" | tr '\n' ' ')"
    fi
  }
  smoke "shell redirect to /dev/null" sh -c ': >/dev/null'
  smoke "git ls-remote over https" git ls-remote https://github.com/tpsdev-ai/cli HEAD
  smoke "fetch https://api.github.com/zen" bun -e 'fetch("https://api.github.com/zen").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
fi

echo "✅ nono profile gate passed (nono ${VERSION}, ${#json_files[@]} profiles, enforcement + workload verified)"
