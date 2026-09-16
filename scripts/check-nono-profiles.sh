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

  # The child ENV, from the same source of truth as the launch (sandboxChildEnv
  # in packages/cli/src/utils/nono.ts) — cli#351 r5c: GIT_CONFIG_GLOBAL=/dev/null
  # is what keeps git from reading the agent's $HOME/.gitconfig.
  SBOX_ENV=()
  while IFS= read -r _kv; do [[ -n "${_kv}" ]] && SBOX_ENV+=("${_kv}"); done < <(bun -e 'import { sandboxChildEnv } from "./packages/cli/src/utils/nono.ts"; for (const [k, v] of Object.entries(sandboxChildEnv({}))) console.log(`${k}=${v}`);')
  [[ ${#SBOX_ENV[@]} -gt 0 ]] || fail "could not read sandboxChildEnv() — the launch env is the thing under test"
  echo "  · launch child env: ${SBOX_ENV[*]}"

  # A REAL launch HOME has a ~/.gitconfig (r5b's fixture HOME did not, which is
  # exactly why the $HOME/.gitconfig fatal went unnoticed). Put one there BEFORE
  # the workloads, so the git workload below is the "after" for r5c.
  printf '[user]\n\tname = fixture\n' >"${TMP}/home/.gitconfig"

  smoke() { # <label> <cmd...>
    local label="$1"; shift
    if env "${SBOX_ENV[@]}" HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" "${LAUNCH[@]}" -- "$@" >"${TMP}/smoke.log" 2>&1; then
      ok "workload: ${label}"
      # Self-documenting green lane: a fetch workload reports the status it saw.
      local _line
      _line="$(grep -m1 -E '^fetch (status|error)' "${TMP}/smoke.log" 2>/dev/null || true)"
      [[ -z "${_line}" ]] || echo "  ·   ${_line}"
    else
      # Show the COMMAND's own error line (git's "fatal: …"), not just the exit
      # code: the lane log must make the cause readable (cli#351 r5b). A denial
      # usually prints a `warning: unable to access '…': Permission denied`
      # FIRST and the fatal line after it, so look for the fatal line ahead of
      # the denial, and fall back to nono's report tail.
      local detail
      # The workload's OWN line first, including the HTTP status a fetch prints
      # (cli#352 r2): quoting nono's denial block instead hid a 403 from
      # api.github.com's anonymous per-IP rate limit behind "3 paths blocked",
      # whose paths are just bun walking up from the cwd (benign, see 5b).
      detail="$(grep -m1 -E '(^|[[:space:]])(fatal|error):|^fetch (status|error)|^Exception' "${TMP}/smoke.log" 2>/dev/null || true)"
      [[ -n "${detail}" ]] || detail="$(grep -m1 -E 'denied|Permission denied|Operation not permitted|Name or service not known|Could not resolve' "${TMP}/smoke.log" 2>/dev/null || true)"
      # nono names the BLOCKED PATH only in its denial block — quote it, or a red
      # lane is unreadable (cli#351 r5c: the macOS fetch failure hid its path).
      [[ -n "${detail}" ]] || detail="$(grep -A4 -m1 'Sandbox denial' "${TMP}/smoke.log" 2>/dev/null | tr '\n' ' ')"
      [[ -n "${detail}" ]] || detail="$(tail -n 14 "${TMP}/smoke.log" | tr '\n' ' ')"
      fail "workload FAILED under the launch args: ${label} — ${detail}"
    fi
  }

  # ── 5a. probe: what the sandbox can see for name resolution ────────────────
  # Informational, printed on BOTH lanes so a failure is diagnosable from the
  # log alone (Ubuntu's /etc/resolv.conf is a SYMLINK to a systemd stub file).
  echo "  · read-file grants: $(bun -e 'import { harnessReadFiles } from "./packages/cli/src/utils/nono.ts"; console.log(harnessReadFiles().join(" "))' 2>&1)"
  echo "  · host resolv.conf realpath: $(bun -e 'import {realpathSync} from "node:fs"; console.log(realpathSync("/etc/resolv.conf"))' 2>&1 || true)"
  echo "  · host /etc/resolv.conf: $(tr '\n' ' ' </etc/resolv.conf 2>&1 || true)"
  HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" "${LAUNCH[@]}" -- \
    sh -c 'echo "  · sandbox resolv.conf realpath: $(bun -e '\''import{realpathSync}from"node:fs";console.log(realpathSync("/etc/resolv.conf"))'\'' 2>&1)"; echo "  · sandbox /etc/resolv.conf: $(tr "\n" " " </etc/resolv.conf 2>&1)"; echo "  · sandbox resolution (getent/dns):"; (getent hosts github.com 2>&1 || bun -e '\''require("node:dns").lookup("github.com",(e,a)=>console.log(e?("DNS ERR "+e.code):("DNS OK "+a)))'\'') | head -n 2; echo "  · sandbox GIT_CURL_VERBOSE (head):"; GIT_CURL_VERBOSE=1 git ls-remote https://github.com/tpsdev-ai/cli HEAD 2>&1 | head -n 20' 2>&1 || true

  # ── 5b. the workloads ─────────────────────────────────────────────────────
  # The child's stderr is merged into its stdout (2>&1) so git's own "fatal:"
  # line survives into the log the ❌ message quotes.
  #
  # EXPECTED, BENIGN: bun walks up from the cwd looking for bunfig.toml /
  # package.json, so nono's summary can list the cwd's PARENT dirs as blocked
  # reads (/Users, /Users/runner, the probe dir on macOS). Those are not
  # sandbox failures — each workload above is judged by its OWN exit status.
  echo "  · expected (benign) denials: parent-dir reads while bun walks up from the cwd (/Users, the probe dir) — never a failure by itself"
  smoke "shell redirect to /dev/null" sh -c ': >/dev/null'
  # `getent` is Linux-only (macOS has no getent); fall back to the resolver
  # itself so the SAME check runs on both lanes (cli#351 r5b).
  if command -v getent >/dev/null 2>&1; then
    smoke "getent hosts github.com" sh -c 'getent hosts github.com >/dev/null 2>&1'
  else
    smoke "dns lookup github.com (no getent on macOS)" bun -e 'require("node:dns").lookup("github.com",(e)=>process.exit(e?1:0))'
  fi
  smoke "git ls-remote over https" sh -c 'git ls-remote https://github.com/tpsdev-ai/cli HEAD 2>&1'
  # The egress workload must be able to fail ONLY for sandbox reasons. It used
  # to hit api.github.com, whose anonymous per-IP limit (60/h, and runner IPs
  # are shared) answers 403 → r.ok false → the workload exited 1 while the
  # sandbox was fine (cli#352 r2: the macOS lane). Ping an endpoint with no
  # anonymous rate limit instead, and PRINT the status/error so a red lane
  # names the cause rather than nono's (benign) denial summary.
  smoke "fetch https://registry.npmjs.org/-/ping" bun -e '
    const url = "https://registry.npmjs.org/-/ping";
    // cli#352 r5 — a DNS/TLS/CDN/5xx BLIP must not red the gate, but a sandbox
    // denial (EPERM/EACCES) must fail IMMEDIATELY, never retry. The status/error
    // is printed on EVERY attempt so a red lane still names what it saw. bun
    // reports network failures with a generic message plus a short code (e.g.
    // ConnectionRefused), so classify on code+message together.
    const transient = /ConnectionRefused|ConnectionClosed|FailedToOpenSocket|DNSError|DNS|TLS|Timeout|timed out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|network/i;
    const denial = /EPERM|EACCES|[Pp]ermission denied|[Oo]peration not permitted|denied/i;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(url);
        const body = (await r.text()).replace(/\s+/g, " ").slice(0, 60);
        console.log(`fetch status ${r.status} ${r.statusText} body=${body}`);
        if (r.ok) process.exit(0);
        // Any non-5xx status is a real answer, not a blip (e.g. a 4xx).
        if (r.status < 500) process.exit(1);
      } catch (e) {
        const code = e && e.code ? String(e.code) : "";
        console.log(`fetch error ${e.name}: ${e.message}${code ? " [" + code + "]" : ""}`);
        if (
          denial.test(`${code} ${e.message}`) ||
          !(transient.test(code) || transient.test(e.message))
        ) {
          process.exit(1);
        }
      }
      if (attempt < 3) {
        const wait = 250 * attempt;
        console.log(`fetch retry ${attempt}/3 after ${wait}ms (transient; a sandbox denial never reaches here)`);
        await new Promise((s) => setTimeout(s, wait));
      }
    }
    process.exit(1);
  '

  # ── 5c. mechanism probe: does nono resolve a symlinked --read-file? ────────
  # Informational. Ubuntu's /etc/resolv.conf is a symlink into /run; this shows
  # whether granting the SYMLINK path is enough on the pinned nono, or whether
  # the target needs granting too (cli#351 r5b evidence).
  SYM_DIR="${TMP}/symrepro"; mkdir -p "${SYM_DIR}/real"
  printf 'nameserver 127.0.0.53\n' >"${SYM_DIR}/real/stub-resolv.conf"
  ln -sf "${SYM_DIR}/real/stub-resolv.conf" "${SYM_DIR}/resolv.conf"
  sym_read() { # <flags...> — cat the symlink under the launch args
    HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" "${LAUNCH[@]}" "$@" -- cat "${SYM_DIR}/resolv.conf" >/dev/null 2>&1
  }
  if sym_read; then echo "  · symlink with NO grant: readable (unexpected — fixture dir is inside a grant?)"; else echo "  · symlink with NO grant: DENIED (control: the fixture dir is outside every grant)"; fi
  if sym_read --read-file "${SYM_DIR}/resolv.conf"; then echo "  · symlink-only --read-file: ALLOWED (nono resolves the grant's symlink itself)"; else echo "  · symlink-only --read-file: DENIED (the target needs granting too)"; fi

no_gitcfg_detail() { # <log> → the fatal line, plus the denial that explains it
  printf '%s [%s]' \
    "$(grep -m1 -E 'fatal:|error:' "$1" 2>/dev/null | tr '\n' ' ' || true)" \
    "$(grep -m1 -E 'unable to access|Permission denied|Operation not permitted' "$1" 2>/dev/null | tr '\n' ' ' || true)"
}

  # ── 5d. fails-first: the gitconfig grant is what saves git (cli#351 r5b) ─────
  # On a host WITH /etc/gitconfig, git reads it as part of "reading the
  # configuration files" — drop the grant and git dies (exit 128); the workload
  # above is the "after".
  if [[ -e /etc/gitconfig ]]; then
    NO_GC=(); _i=0
    while (( _i < ${#LAUNCH[@]} )); do
      if [[ "${LAUNCH[$_i]}" == "--read-file" && "${LAUNCH[$((_i + 1))]}" == "/etc/gitconfig" ]]; then _i=$((_i + 2)); continue; fi
      NO_GC+=("${LAUNCH[$_i]}"); _i=$((_i + 1))
    done
    if env "${SBOX_ENV[@]}" HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" "${NO_GC[@]}" -- \
      sh -c 'git ls-remote https://github.com/tpsdev-ai/cli HEAD 2>&1' >"${TMP}/nogitcfg.log" 2>&1; then
      echo "  · fails-first: gitconfig grant removed but git still succeeded (unexpected on this host)"
    else
      ok "fails-first: gitconfig grant removed → $(no_gitcfg_detail "${TMP}/nogitcfg.log")"
    fi
  else
    # No /etc/gitconfig on this host: reproduce the SAME mechanism portably by
    # pointing GIT_CONFIG_SYSTEM at an ungranted synthetic config — identical
    # warning + fatal, and the same --read-file grant clears it. This is what
    # the ubuntu lane hits for real.
    GC_DIR="${TMP}/gitcfg"; mkdir -p "${GC_DIR}"
    printf '[core]\n\tautocrlf = false\n' >"${GC_DIR}/gitconfig"
    gc_run() { # <extra launch flags...>
      env "${SBOX_ENV[@]}" HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 GIT_CONFIG_SYSTEM="${GC_DIR}/gitconfig" \
        "${NONO_BIN}" "${LAUNCH[@]}" "$@" -- sh -c 'git ls-remote https://github.com/tpsdev-ai/cli HEAD 2>&1'
    }
    if gc_run >"${TMP}/gc-no.log" 2>&1; then
      fail "fails-first: git SUCCEEDED with an ungranted system config (mechanism not reproduced)"
    else
      ok "fails-first: ungranted system config → $(no_gitcfg_detail "${TMP}/gc-no.log")"
    fi
    gc_run --read-file "${GC_DIR}/gitconfig" >"${TMP}/gc-yes.log" 2>&1 \
      && ok "the system-config --read-file grant clears it (git ls-remote succeeds)" \
      || fail "granted system config still failed: $(tail -n 1 "${TMP}/gc-yes.log")"
  fi

  # ── 5e. fails-first: the child ENV is what saves git from the agent's HOME ──
  # The git workload above ran with the launch's env (GIT_CONFIG_GLOBAL=/dev/null)
  # and a HOME that HAS ~/.gitconfig → green. Drop just that one var: git then
  # tries the agent's own config, which nothing grants, and dies (exit 128).
  NO_GCE=(); for _kv in "${SBOX_ENV[@]}"; do [[ "${_kv}" == GIT_CONFIG_GLOBAL=* ]] || NO_GCE+=("${_kv}"); done
  if env "${NO_GCE[@]}" HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" "${LAUNCH[@]}" -- \
    sh -c 'git ls-remote https://github.com/tpsdev-ai/cli HEAD 2>&1' >"${TMP}/gc-home-no.log" 2>&1; then
    fail "fails-first: git read \$HOME/.gitconfig with GIT_CONFIG_GLOBAL unset (fixture did not reproduce)"
  else
    ok "fails-first: no GIT_CONFIG_GLOBAL with ~/.gitconfig present → $(no_gitcfg_detail "${TMP}/gc-home-no.log")"
  fi
  # and the same command WITH the launch env is the "after" (the git workload above).
  env "${SBOX_ENV[@]}" HOME="${TMP}/home" NONO_NO_UPDATE_CHECK=1 "${NONO_BIN}" "${LAUNCH[@]}" -- \
    sh -c 'git ls-remote https://github.com/tpsdev-ai/cli HEAD 2>&1' >"${TMP}/gc-home-yes.log" 2>&1 \
    && ok "GIT_CONFIG_GLOBAL=/dev/null clears it (git ls-remote succeeds with ~/.gitconfig present)" \
    || fail "git still failed with the launch env: $(tail -n 1 "${TMP}/gc-home-yes.log")"
fi

echo "✅ nono profile gate passed (nono ${VERSION}, ${#json_files[@]} profiles, enforcement + workload verified)"
