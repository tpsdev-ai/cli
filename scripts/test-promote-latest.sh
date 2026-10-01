#!/usr/bin/env bash
# test-promote-latest.sh — fails-first fixtures for scripts/promote-latest.sh (cli#366).
#
# The promote script's value is its REFUSALS, its verification, and its rollback,
# so this harness pins all three against a FAKE registry: no network, no real npm,
# and no real dist-tag is ever moved. Each fixture builds a fake repo tree plus a
# fake `npm` (injected via NPM_BIN) whose registry state is a JSON file the test
# controls, then drives scripts/promote-latest.sh and asserts its exit code, its
# text, and the resulting registry state.
#
# Covered:
#   * refuse when the target version is not published for all six — and name them
#   * refuse when only SOME are missing — and name only those
#   * proceed (dry-run) when the version is fully published
#   * "already latest" is reported as such, not proposed as a no-op move
#   * a move that does not land (npm exits 0, the registry never changes) is caught
#     by the post-move re-read, and the packages already moved are rolled back
#   * an INTERRUPT (SIGTERM) during the move loop rolls back the packages already
#     moved, including the in-flight one — the all-six-or-none guarantee holds
#   * a signal DURING the rollback, and a SECOND signal during it, do not strand a
#     partial promote — the second must not abandon the remaining restorations
#   * build metadata (1.2.3+build-abc) is not misread as a pre-release
#   * the confirmation gate aborts on anything but "yes"
#   * a DOWNGRADE or a PRE-RELEASE target is allowed but needs --allow-downgrade,
#     which --yes does NOT satisfy
#   * every npm call is pinned with --registry
#   * the fake npm intentionally refuses every `dist-tag add` lacking a TTY on
#     stdin or stdout, returning EOTP. The runner normally supplies both TTYs;
#     fixture S overrides tool stdin with /dev/null while keeping stdout on the
#     pty. Fixture R pins both TTYs on each add, and S pins refusal when stdin
#     is not a TTY
#   * a successful promote dispatches the Docker image workflow once, for the
#     promoted version, only after all six `dist-tag add`s (fixture T); a failed
#     promote never dispatches (U); `--no-docker` promotes but never dispatches
#     (V); a gh failure after a successful promote exits 6, names the failure and
#     the hand-run command, and does NOT roll back (W); a missing gh does the same
#     (X)
#   * MUTATION CHECKS: break the existence check, the post-move re-read, the TERM
#     trap, the pre-add attempt flag, and the trap-clear branch, restore the
#     command substitution around `dist-tag add`, dispatch before the post-check,
#     and roll back on a gh failure; confirm a fixture catches each —
#     a test that passes on both the fixed and the broken script is not a test.
#   * the fixtures run under bash 3.2 too (BASH_BIN; the macos-14 CI leg pins it),
#     and the workflow still invokes this harness
#
# The bash-4 denylist below is a cheap companion, NOT coverage: it catches only the
# constructs that have already bitten. The real control for the bash-3.2 class is
# the `macos-14` CI leg, which runs this whole harness under /bin/bash (3.2.57).
#
# The runner normally gives the tool a pseudo-terminal for stdin and stdout.
# Fixture S overrides tool stdin with /dev/null while keeping stdout on the pty.
# The fake npm intentionally returns EOTP for every add lacking either TTY. The
# pty runner (python3) forwards its own stdin to the pty, keeps the tool's stderr
# in a file, leaves the tool signalable, and exits with its status; the tool's own
# pid is recorded first, so a signal fixture signals the tool and not the runner.
#
# The fixtures are generated at run time, not committed, so no fake registry state
# or mutant script lives in the tree for scanners to read as real.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
tool="$here/promote-latest.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# BASH_BIN is the bash the tool under test must run under. On the machine that
# drives releases that is bash 3.2 (macOS ships 3.2.57), so the CI job pins it;
# locally, `BASH_BIN=/path/to/bash32 ./scripts/test-promote-latest.sh` proves it.
BASH_BIN="${BASH_BIN:-bash}"
printf 'test-promote-latest: harness under bash %s; tool under %s\n' \
  "$BASH_VERSION" "$("$BASH_BIN" --version | head -n1)"

# ── pseudo-terminal runner ───────────────────────────────────────────────────
# The fake npm intentionally refuses every `dist-tag add` lacking a TTY on stdin
# or stdout, returning EOTP. Every invocation below uses this runner, which
# normally supplies both TTYs to the tool; fixture S overrides tool stdin with
# /dev/null while keeping stdout on the pty.
command -v python3 >/dev/null 2>&1 || {
  printf 'test-promote-latest: python3 is required to run the tool under a pty\n' >&2
  exit 1
}
pty_runner="$work/pty-run.py"
cat >"$pty_runner" <<'PTY_RUNNER'
"""Run a command with its stdin and stdout on a pseudo-terminal.

argv: <stderr-file> <command> [args...]

The command's stdin and stdout are the pty slave (a TTY); its stderr is the given
file. This process copies its own stdin into the pty and, when its stdin ends,
sends the pty's end-of-file character, so a `read` in the command gets the
forwarded line and then end of file. Echo is off, so forwarded input is not copied
back out. The pty's output is copied to this process's stdout, and this process
exits with the command's status, or 124 after PTY_TIMEOUT seconds (default 60),
having killed the command. When PTY_PIDFILE is set, the command's pid is written
there first, so a caller can signal the command itself rather than this wrapper.
"""
import os
import select
import subprocess
import sys
import termios
import time

err_path = sys.argv[1]
argv = sys.argv[2:]
master, slave = os.openpty()
attrs = termios.tcgetattr(slave)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(slave, termios.TCSANOW, attrs)
veof = attrs[6][termios.VEOF]
if isinstance(veof, int):
    veof = bytes([veof])
err_fd = os.open(err_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=err_fd)
os.close(slave)
os.close(err_fd)
pidfile = os.environ.get('PTY_PIDFILE')
if pidfile:
    with open(pidfile, 'w') as fh:
        fh.write(str(proc.pid))
deadline = time.monotonic() + float(os.environ.get('PTY_TIMEOUT', '60'))
out = sys.stdout.buffer
inp = sys.stdin.fileno()
inp_open = True
while True:
    left = deadline - time.monotonic()
    if left <= 0:
        proc.kill()
        proc.wait()
        out.flush()
        sys.stderr.write('pty-run: timed out; killed the command\n')
        sys.exit(124)
    ready, _, _ = select.select([master] + ([inp] if inp_open else []), [], [], left)
    if inp_open and inp in ready:
        data = os.read(inp, 65536)
        try:
            os.write(master, data if data else veof)
        except OSError:
            pass
        if not data:
            inp_open = False
    if master in ready:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        out.write(chunk)
out.flush()
sys.exit(proc.wait())
PTY_RUNNER

# strip the CR a pty adds on output, so the assertions see the tool's own lines
strip_cr() { tr -d '\r'; }

six_dirs=(cli-darwin-arm64 cli-darwin-x64 cli-linux-arm64 cli-linux-x64 agent cli)

npass=0
nfail=0
ok() { printf 'PASS  %-42s %s\n' "$1" "$2"; npass=$((npass + 1)); }
bad() { printf 'FAIL  %-42s %s\n' "$1" "$2"; nfail=$((nfail + 1)); }

assert_eq() { # <name> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1" "== $2"; else bad "$1" "expected [$2], got [$3]"; fi
}
assert_contains() { # <name> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1" "found: $3"; else bad "$1" "not found: $3"; fi
}

# ── the fake `npm` ───────────────────────────────────────────────────────────
fake_npm="$work/fake-npm"
cat >"$fake_npm" <<'FAKE_NPM'
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const tty = require('tty');
const statePath = process.env.FAKE_NPM_STATE;
if (!statePath) { process.stderr.write('fake-npm: FAKE_NPM_STATE is not set\n'); process.exit(90); }
const logPath = process.env.FAKE_NPM_LOG || '';
function read() { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
function persist(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }
function log(line) { if (logPath) fs.appendFileSync(logPath, line + '\n'); }
function fail(msg) { process.stderr.write(msg + '\n'); process.exit(1); }
function splitSpec(spec) {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { pkg: spec, ver: null };
  return { pkg: spec.slice(0, at), ver: spec.slice(at + 1) };
}
const args = process.argv.slice(2);
const stdinTTY = tty.isatty(0);
const stdoutTTY = tty.isatty(1);
log(args.join(' ') + ' stdin_tty=' + (stdinTTY ? '1' : '0') + ' stdout_tty=' + (stdoutTTY ? '1' : '0'));
const cmd = args[0];
const sub = args[1];
const rest = args.slice(2);
if (cmd === 'view') {
  const spec = splitSpec(sub);
  const field = rest[0];
  const s = read();
  if (field === 'version') {
    if (spec.ver === null) fail('npm error code E404\nnpm error No version specified');
    const vs = s.versions[spec.pkg] || [];
    if (vs.includes(spec.ver)) { process.stdout.write(spec.ver + '\n'); process.exit(0); }
    fail("npm error code E404\nnpm error 404  '" + spec.pkg + '@' + spec.ver + "' is not in this registry.");
  }
  if (field === 'dist-tags.latest') {
    const l = s.latest[spec.pkg];
    if (l === undefined) fail('npm error code E404\nnpm error 404 Not Found');
    process.stdout.write(l + '\n');
    process.exit(0);
  }
  if (field === 'dist-tags') {
    process.stdout.write(JSON.stringify({ latest: s.latest[spec.pkg] }, null, 2) + '\n');
    process.exit(0);
  }
  fail('npm error unknown field: ' + field);
} else if (cmd === 'dist-tag' && sub === 'add') {
  // For a changing tag whose registry operation requires 2FA, installed npm's
  // otplease (lib/utils/auth.js) can prompt only when stdin and stdout are TTYs;
  // without both, npm can return EOTP without moving the tag (#445). This stub
  // intentionally refuses every add lacking either TTY with EOTP, including an
  // add that leaves a tag at its current value; installed npm skips 2FA for that
  // no-op add, so this stub also refuses its rollback.
  if (!(stdinTTY && stdoutTTY)) {
    fail(
      'npm error code EOTP\nnpm error fake npm: 2FA needs stdin and stdout to be TTYs (stdin_tty=' +
        (stdinTTY ? '1' : '0') + ' stdout_tty=' + (stdoutTTY ? '1' : '0') + ').',
    );
  }
  const spec = splitSpec(rest[0]);
  const tag = rest[1];
  if (tag !== 'latest') fail('npm error only the latest tag is supported');
  const s = read();
  if ((s.failAdd || []).includes(spec.pkg)) fail('npm error code E401\nnpm error Unable to authenticate');
  // `noopAdd`: a command that exits 0 but never moves the tag.
  if (!((s.noopAdd || []).includes(spec.pkg))) { s.latest[spec.pkg] = spec.ver; persist(s); }
  // Hold matching adds in flight (after the tag moved) so a signal from the
  // harness lands inside the in-flight window. The counter file records how many
  // holds have happened, so the harness can time a second signal.
  const holdPkg = process.env.FAKE_NPM_HOLD_PKG;
  const holdVer = process.env.FAKE_NPM_HOLD_VER || '';
  const counter = process.env.FAKE_NPM_MARKER;
  if (holdPkg && counter && spec.pkg === holdPkg && (!holdVer || spec.ver === holdVer)) {
    let n = 0;
    try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch (e) { n = 0; }
    fs.writeFileSync(counter, String(n + 1));
    const t0 = Date.now();
    while (Date.now() - t0 < 1200) { /* hold */ }
  }
  process.stdout.write('+latest: ' + spec.pkg + '@' + spec.ver + '\n');
  process.exit(0);
} else {
  fail('npm error unknown command: ' + args.join(' '));
}
FAKE_NPM
chmod +x "$fake_npm"

# ── the fake `gh` ────────────────────────────────────────────────────────────
# The promote script dispatches `gh workflow run docker.yml --repo tpsdev-ai/cli
# -f version=<v>` after a successful promote. This stub records every invocation
# (its argv, and how many `dist-tag add` calls the promote had made when it ran),
# then succeeds — or fails when GH_STUB_FAIL=1, standing in for an
# unauthenticated or otherwise failed dispatch. Bash 3.2-compatible.
gh_stub="$work/fake-gh"
cat >"$gh_stub" <<'FAKE_GH'
#!/usr/bin/env bash
set -uo pipefail
if [ -z "${GH_LOG:-}" ]; then
  printf 'fake-gh: GH_LOG is not set\n' >&2
  exit 90
fi
adds=0
if [ -n "${GH_NPM_LOG:-}" ] && [ -f "$GH_NPM_LOG" ]; then
  adds="$(grep -c '^dist-tag add ' "$GH_NPM_LOG" 2>/dev/null)"
  case "$adds" in '' | *[!0-9]*) adds=0 ;; esac
fi
{
  printf 'argv:'
  for a in "$@"; do printf ' %s' "$a"; done
  printf '\nadds_before=%s\n' "$adds"
} >>"$GH_LOG"
if [ "${GH_STUB_FAIL:-0}" = "1" ]; then
  printf 'gh: authentication required: please run gh auth login\n' >&2
  exit 1
fi
exit 0
FAKE_GH
chmod +x "$gh_stub"

# ── fixture helpers ──────────────────────────────────────────────────────────
cat >"$work/mkstate.mjs" <<'MK'
import fs from 'fs';
const [file, pub, latest, noop = '', fail = '', drop = ''] = process.argv.slice(2);
const dirs = ['cli-darwin-arm64', 'cli-darwin-x64', 'cli-linux-arm64', 'cli-linux-x64', 'agent', 'cli'];
const vers = pub ? pub.split(',') : [];
const versions = {};
const lat = {};
for (const d of dirs) {
  const p = '@tpsdev-ai/' + d;
  versions[p] = vers.slice();
  lat[p] = latest;
}
if (drop) for (const d of drop.split(',')) versions['@tpsdev-ai/' + d] = [];
const s = { versions, latest: lat };
if (noop) s.noopAdd = noop.split(',').map((x) => '@tpsdev-ai/' + x);
if (fail) s.failAdd = fail.split(',').map((x) => '@tpsdev-ai/' + x);
fs.writeFileSync(file, JSON.stringify(s, null, 2));
MK

cat >"$work/latest.mjs" <<'LM'
import fs from 'fs';
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(String(s.latest[process.argv[3]] ?? '') + '\n');
LM

# mutate.mjs — break the script under test so the fixtures must catch it.
cat >"$work/mutate.mjs" <<'MUT'
import fs from 'fs';
const [src, dst, which] = process.argv.slice(2);
const s = fs.readFileSync(src, 'utf8');
const targets = {
  existence: ['  exit "$EXIT_REFUSED"\n', '  : # MUTATED: existence check disabled\n'],
  verify: [
    '  if [ "$rc" -ne 0 ] || [ "$prc" -ne 0 ] || [ "$post" != "$version" ]; then\n',
    '  if [ "$rc" -ne 0 ]; then\n',
  ],
  interrupt: ["trap 'on_signal TERM' TERM\n", ': # MUTATED: no TERM trap\n'],
  trapclear: [
    "if [ \"$failure\" -ne 0 ]; then\n  trap '' TERM INT HUP\n  rollback_moved\nelse\n  trap - TERM INT HUP\nfi\n",
    "trap - TERM INT HUP\nif [ \"$failure\" -ne 0 ]; then\n  rollback_moved\nfi\n",
  ],
  reorder: [
    '  moved[i]=1\n  printf \'\\n-> %s: npm dist-tag add %s@%s latest\\n\' "${names[i]}" "${names[i]}" "$version"\n  # The add runs with the script\'s own stdin/stdout/stderr (not captured): no\n  # command substitution and no pipe, so npm\'s browser 2FA can run when the script\n  # itself is run from a terminal. npm prompts for 2FA only when stdin and stdout\n  # are both TTYs; captured output loses stdout\'s TTY, and npm then exits EOTP\n  # without moving the tag.\n  set +e\n  "$NPM_BIN" dist-tag add "${names[i]}@${version}" latest --registry "$NPM_REGISTRY"\n  rc=$?\n  set -e\n',
    '  printf \'\\n-> %s: npm dist-tag add %s@%s latest\\n\' "${names[i]}" "${names[i]}" "$version"\n  # The add runs with the script\'s own stdin/stdout/stderr (not captured): no\n  # command substitution and no pipe, so npm\'s browser 2FA can run when the script\n  # itself is run from a terminal. npm prompts for 2FA only when stdin and stdout\n  # are both TTYs; captured output loses stdout\'s TTY, and npm then exits EOTP\n  # without moving the tag.\n  set +e\n  "$NPM_BIN" dist-tag add "${names[i]}@${version}" latest --registry "$NPM_REGISTRY"\n  rc=$?\n  moved[i]=1\n  set -e\n',
  ],
  capture: [
    '  set +e\n  "$NPM_BIN" dist-tag add "${names[i]}@${version}" latest --registry "$NPM_REGISTRY"\n  rc=$?\n  set -e\n',
    '  set +e\n  out="$("$NPM_BIN" dist-tag add "${names[i]}@${version}" latest --registry "$NPM_REGISTRY" 2>&1)"\n  rc=$?\n  set -e\n  [ -z "$out" ] || printf \'%s\\n\' "$out"\n',
  ],
  dispatch_early: [
    '  "$NPM_BIN" dist-tag add "${names[i]}@${version}" latest --registry "$NPM_REGISTRY"\n  rc=$?\n  set -e\n\n  # Do NOT trust the exit code: re-read the registry and confirm the tag moved.\n',
    '  "$NPM_BIN" dist-tag add "${names[i]}@${version}" latest --registry "$NPM_REGISTRY"\n  rc=$?\n  set -e\n  dispatch_docker\n\n  # Do NOT trust the exit code: re-read the registry and confirm the tag moved.\n',
  ],
  dispatch_rollback: [
    '  exit "$EXIT_DISPATCH_FAILED"\n',
    '  rollback_moved\n  exit "$EXIT_DISPATCH_FAILED"\n',
  ],
};
const t = targets[which];
if (!t) { console.error('unknown mutation: ' + which); process.exit(2); }
if (!s.includes(t[0])) { console.error('mutation target not found: ' + which); process.exit(3); }
fs.writeFileSync(dst, s.replace(t[0], t[1]));
MUT

new_fixture() { # <name> -> prints the fixture dir
  local d="$work/$1"
  mkdir -p "$d/root"
  local p
  for p in "${six_dirs[@]}"; do
    mkdir -p "$d/root/packages/$p"
    printf '{\n  "name": "@tpsdev-ai/%s",\n  "version": "0.5.4"\n}\n' "$p" >"$d/root/packages/$p/package.json"
  done
  printf '%s' "$d"
}

write_state() { node "$work/mkstate.mjs" "$@"; }

state_latest() { node "$work/latest.mjs" "$1" "$2"; }

all_latest_eq() { # <state-file> <version>
  local st="$1" v="$2" p
  for p in "${six_dirs[@]}"; do
    [ "$(state_latest "$st" "@tpsdev-ai/$p")" = "$v" ] || return 1
  done
  return 0
}

RC=0
OUT=""
ERR=""
LOG=""
IRC=0
invoke() { # [TOOL=...] <fixture-dir> [args...] — stdin and stdout on the pty; a read gets end of file
  local d="$1"
  shift
  local t="${TOOL:-$tool}"
  local raw
  LOG="$d/log.txt"
  : >"$LOG"
  : >"$d/gh.log"
  raw="$(FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="$fake_npm" \
    GH_BIN="${GH_BIN_OVERRIDE:-$gh_stub}" GH_LOG="$d/gh.log" GH_NPM_LOG="$LOG" GH_STUB_FAIL="${GH_STUB_FAIL:-0}" \
    python3 "$pty_runner" "$d/err.txt" "$BASH_BIN" "$t" "$@" </dev/null)"
  RC=$?
  OUT="$(printf '%s\n' "$raw" | strip_cr)"
  ERR="$(cat "$d/err.txt")"
}
invoke_stdin() { # [TOOL=...] <fixture-dir> <reply> [args...] — the reply is typed into the pty
  local d="$1"
  local reply="$2"
  shift 2
  local t="${TOOL:-$tool}"
  local raw
  LOG="$d/log.txt"
  : >"$LOG"
  : >"$d/gh.log"
  raw="$(printf '%s\n' "$reply" | FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="$fake_npm" \
    GH_BIN="${GH_BIN_OVERRIDE:-$gh_stub}" GH_LOG="$d/gh.log" GH_NPM_LOG="$LOG" GH_STUB_FAIL="${GH_STUB_FAIL:-0}" \
    python3 "$pty_runner" "$d/err.txt" "$BASH_BIN" "$t" "$@")"
  RC=$?
  OUT="$(printf '%s\n' "$raw" | strip_cr)"
  ERR="$(cat "$d/err.txt")"
}
invoke_stdin_not_tty() { # [TOOL=...] <fixture-dir> [args...] — stdout on the pty, stdin /dev/null
  local d="$1"
  shift
  local t="${TOOL:-$tool}"
  local raw
  LOG="$d/log.txt"
  : >"$LOG"
  : >"$d/gh.log"
  # shellcheck disable=SC2016  # "$@" is expanded by the inner bash, not here
  raw="$(FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="$fake_npm" \
    GH_BIN="${GH_BIN_OVERRIDE:-$gh_stub}" GH_LOG="$d/gh.log" GH_NPM_LOG="$LOG" GH_STUB_FAIL="${GH_STUB_FAIL:-0}" \
    python3 "$pty_runner" "$d/err.txt" "$BASH_BIN" -c 'exec "$@" </dev/null' stdin-null "$BASH_BIN" "$t" "$@" </dev/null)"
  RC=$?
  OUT="$(printf '%s\n' "$raw" | strip_cr)"
  ERR="$(cat "$d/err.txt")"
}
wait_count() { # <counter-file> <n> -> 0 if the file reached n within ~15s
  local f="$1" want="$2" n=0 cur=0
  while [ "$n" -lt 300 ]; do
    cur=0
    [ -f "$f" ] && cur="$(cat "$f")"
    case "$cur" in '' | *[!0-9]*) cur=0 ;; esac
    [ "$cur" -ge "$want" ] && return 0
    sleep 0.05
    n=$((n + 1))
  done
  return 1
}

HCOUNTER=""
HPID=""
start_held() { # [TOOL=...] <dir> <hold-pkg-short> <hold-ver|-> [args...]
  local d="$1"
  local hold="$2"
  local holdver="$3"
  shift 3
  local t="${TOOL:-$tool}"
  LOG="$d/log.txt"
  : >"$LOG"
  HCOUNTER="$d/hold.count"
  rm -f "$HCOUNTER"
  rm -f "$d/tool.pid"
  local hv="$holdver"
  [ "$holdver" = "-" ] && hv=""
  FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="$fake_npm" \
    FAKE_NPM_HOLD_PKG="@tpsdev-ai/$hold" FAKE_NPM_HOLD_VER="$hv" FAKE_NPM_MARKER="$HCOUNTER" \
    PTY_PIDFILE="$d/tool.pid" \
    python3 "$pty_runner" "$d/err.txt" "$BASH_BIN" "$t" "$@" </dev/null >"$d/out.txt" &
  HPID=$!
}
finish_held() { # <dir>
  local d="$1"
  wait "$HPID" 2>/dev/null
  IRC=$?
  OUT="$(cat "$d/out.txt" | strip_cr)"
  ERR="$(cat "$d/err.txt")"
}
signal_tool() { # <dir> <signal> — signal the tool itself, never the pty runner
  local d="$1"
  local sig="$2"
  local pid
  pid="$(cat "$d/tool.pid" 2>/dev/null)"
  if [ -z "$pid" ]; then
    bad "signal: tool pid recorded" "$d/tool.pid is empty"
    return 1
  fi
  kill -"$sig" "$pid" 2>/dev/null
}
run_interrupt() { # [TOOL=...] <dir> <hold-pkg-short> <hold-ver|-> <signal> [args...]
  local d="$1"
  local hold="$2"
  local holdver="$3"
  local sig="$4"
  shift 4
  start_held "$d" "$hold" "$holdver" "$@"
  wait_count "$HCOUNTER" 1
  signal_tool "$d" "$sig"
  finish_held "$d"
}
run_interrupt2() { # [TOOL=...] <dir> <hold-pkg-short> <hold-ver|-> <sig1> <sig2> [args...]
  local d="$1"
  local hold="$2"
  local holdver="$3"
  local sig1="$4"
  local sig2="$5"
  shift 5
  start_held "$d" "$hold" "$holdver" "$@"
  wait_count "$HCOUNTER" 1
  signal_tool "$d" "$sig1"
  wait_count "$HCOUNTER" 2
  signal_tool "$d" "$sig2"
  finish_held "$d"
}
adds_count() {
  local n
  n="$(grep -c '^dist-tag add ' "$LOG" 2>/dev/null)"
  printf '%s' "${n:-0}"
}

gh_calls() { # <fixture-dir> — how many times the stub gh was invoked
  local n
  n="$(grep -c '^argv:' "$1/gh.log" 2>/dev/null)"
  printf '%s' "${n:-0}"
}

# ── A. refuse when the version is not published for all six ───────────────────
d="$(new_fixture refuse-missing)"
write_state "$d/state.json" "0.5.4" "0.5.4"
invoke "$d" 0.6.0 --dry-run
assert_eq "A refuse-missing: exit" 2 "$RC"
assert_contains "A refuse-missing: says REFUSED" "$ERR" "REFUSED"
assert_eq "A refuse-missing: names all six" 6 "$(printf '%s\n' "$ERR" | grep -c '^  - @tpsdev-ai/')"
assert_eq "A refuse-missing: no dist-tag add attempted" 0 "$(adds_count)"

# ── B. a fully-published version already at latest → proceed, "already latest" ─
d="$(new_fixture already-latest)"
write_state "$d/state.json" "0.5.4" "0.5.4"
invoke "$d" 0.5.4 --dry-run
assert_eq "B already-latest: exit" 0 "$RC"
assert_contains "B already-latest: dry-run banner" "$OUT" "DRY RUN"
assert_eq "B already-latest: six 'already latest' rows" 6 "$(printf '%s\n' "$OUT" | grep -c 'already latest')"
assert_eq "B already-latest: no dist-tag add attempted" 0 "$(adds_count)"

# ── C. only SOME missing → refuse and name only those ─────────────────────────
d="$(new_fixture refuse-partial)"
write_state "$d/state.json" "0.6.0" "0.5.4" "" "" "cli-linux-arm64"
invoke "$d" 0.6.0 --dry-run
assert_eq "C refuse-partial: exit" 2 "$RC"
assert_eq "C refuse-partial: exactly one named" 1 "$(printf '%s\n' "$ERR" | grep -c '^  - @tpsdev-ai/')"
assert_contains "C refuse-partial: names the missing one" "$ERR" "  - @tpsdev-ai/cli-linux-arm64"
assert_eq "C refuse-partial: no dist-tag add attempted" 0 "$(adds_count)"

# ── D. a fully-published version behind latest → plan the move (dry-run) ──────
d="$(new_fixture move-plan)"
write_state "$d/state.json" "0.5.4" "0.5.3"
invoke "$d" 0.5.4 --dry-run
assert_eq "D move-plan: exit" 0 "$RC"
assert_contains "D move-plan: dry-run banner" "$OUT" "DRY RUN"
assert_eq "D move-plan: six 'move' rows" 6 "$(printf '%s\n' "$OUT" | grep -cE 'move$')"
assert_eq "D move-plan: no dist-tag add attempted" 0 "$(adds_count)"
assert_eq "D move-plan: no Docker dispatch" 0 "$(gh_calls "$d")"

# ── E. --yes moves all six and verifies each against the registry ─────────────
d="$(new_fixture move-all)"
write_state "$d/state.json" "0.5.4" "0.5.3"
invoke "$d" 0.5.4 --yes
assert_eq "E move-all: exit" 0 "$RC"
assert_eq "E move-all: six dist-tag adds" 6 "$(adds_count)"
if all_latest_eq "$d/state.json" "0.5.4"; then ok "E move-all: registry end state" "latest=0.5.4 for all six"; else bad "E move-all: registry end state" "not all 0.5.4"; fi
assert_eq "E move-all: six 'yes' in final table" 6 "$(printf '%s\n' "$OUT" | grep -cE 'yes$')"

# ── F. the confirmation gate aborts on anything but "yes" ─────────────────────
d="$(new_fixture confirm-abort)"
write_state "$d/state.json" "0.5.4" "0.5.3"
invoke_stdin "$d" "no" 0.5.4
assert_eq "F confirm-abort: exit" 3 "$RC"
assert_contains "F confirm-abort: read the reply via the pty" "$ERR" 'got "no"'
assert_eq "F confirm-abort: no dist-tag add attempted" 0 "$(adds_count)"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "F confirm-abort: registry untouched" "latest=0.5.3 for all six"; else bad "F confirm-abort: registry untouched" "registry changed"; fi

# ── G. a move that does not land is caught and rolled back (all-or-none) ──────
d="$(new_fixture noop-rollback)"
write_state "$d/state.json" "0.5.4" "0.5.3" "cli-linux-arm64"
invoke "$d" 0.5.4 --yes
assert_eq "G noop-rollback: exit" 4 "$RC"
assert_contains "G noop-rollback: reports the rollback" "$ERR" "rolling back"
assert_contains "G noop-rollback: final table flags NO" "$OUT" "NO"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "G noop-rollback: registry restored" "latest=0.5.3 for all six"; else bad "G noop-rollback: registry restored" "a partial promote was left behind"; fi

# ── J. no VERSION → default comes from packages/cli/package.json ──────────────
d="$(new_fixture default-version)"
write_state "$d/state.json" "0.5.4" "0.5.4"
invoke "$d" --dry-run
assert_eq "J default-version: exit" 0 "$RC"
assert_contains "J default-version: used package.json version" "$OUT" 'Promoting the "latest" dist-tag to 0.5.4'

# ── K. SIGTERM mid-move rolls back, including the in-flight package ───────────
# The in-flight package (cli-linux-arm64, index 2) has already had its tag moved
# by the fake npm when the signal lands; the attempt flag is set BEFORE the add, so
# the rollback must restore it too. A script with no trap dies here and leaves a
# partial promote — this fixture is the control for that.
d="$(new_fixture interrupt)"
write_state "$d/state.json" "0.5.4" "0.5.3"
run_interrupt "$d" "cli-linux-arm64" "0.5.4" TERM 0.5.4 --yes
assert_eq "K interrupt: exit" 4 "$IRC"
assert_contains "K interrupt: reports the rollback" "$ERR" "rolling back"
assert_contains "K interrupt: names the signal" "$ERR" "SIGTERM"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "K interrupt: registry restored" "latest=0.5.3 for all six"; else bad "K interrupt: registry restored" "a partial promote was left behind"; fi

# ── O. a signal DURING the failure-path rollback must not strand a partial ────
# Drive a failing move (a noop add for the CLI) so the failure branch is taken,
# and hold the rollback of the in-flight platform package. The signal lands while
# rollback_moved is running. A script that clears its traps before this branch is
# killed mid-rollback and strands a partial promote — this fixture is its control.
d="$(new_fixture interrupt-rollback)"
write_state "$d/state.json" "0.5.4" "0.5.3" "cli"
run_interrupt "$d" "cli-linux-arm64" "0.5.3" TERM 0.5.4 --yes
assert_eq "O interrupt-during-rollback: exit" 4 "$IRC"
assert_contains "O interrupt-during-rollback: reports rollback" "$ERR" "rolling back"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "O interrupt-during-rollback: restored" "latest=0.5.3 for all six"; else bad "O interrupt-during-rollback: restored" "a partial promote was stranded"; fi

# ── P. a SECOND signal during rollback must not abandon it ────────────────────
# Hold every add of the platform package, so signal #1 starts the handler's
# rollback and signal #2 lands during that rollback. The handler must IGNORE the
# second signal, not exit (which would abandon the remaining restorations).
d="$(new_fixture interrupt-second)"
write_state "$d/state.json" "0.5.4" "0.5.3"
run_interrupt2 "$d" "cli-linux-arm64" "-" TERM TERM 0.5.4 --yes
assert_contains "P second-signal: reports rollback" "$ERR" "rolling back"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "P second-signal: all six restored" "latest=0.5.3 for all six"; else bad "P second-signal: all six restored" "the second signal abandoned part of the rollback"; fi

# ── Q. build metadata is NOT a pre-release ────────────────────────────────────
# SemVer permits hyphens in build metadata; 1.2.3+build-abc is a stable release
# and must not be mistaken for a pre-release (which would demand --allow-downgrade).
d="$(new_fixture build-metadata)"
write_state "$d/state.json" "1.2.3+build-abc" "0.5.4"
invoke "$d" "1.2.3+build-abc" --yes
assert_eq "Q build-metadata: exit" 0 "$RC"
if printf '%s' "$ERR" | grep -qF 'PRE-RELEASE'; then bad "Q build-metadata: not a pre-release" "flagged a stable build as a pre-release"; else ok "Q build-metadata: not a pre-release" "treated as stable"; fi
assert_eq "Q build-metadata: six dist-tag adds" 6 "$(adds_count)"
if all_latest_eq "$d/state.json" "1.2.3+build-abc"; then ok "Q build-metadata: moved" "latest=1.2.3+build-abc for all six"; else bad "Q build-metadata: moved" "not all moved to 1.2.3+build-abc"; fi

# ── L. a DOWNGRADE is allowed but needs --allow-downgrade, not --yes ──────────
d="$(new_fixture downgrade)"
write_state "$d/state.json" "0.5.3,0.5.4" "0.5.4"
invoke "$d" 0.5.3 --yes
assert_eq "L downgrade: --yes alone aborts" 3 "$RC"
assert_contains "L downgrade: says DOWNGRADE" "$ERR" "DOWNGRADE"
assert_eq "L downgrade: no dist-tag add attempted" 0 "$(adds_count)"
if all_latest_eq "$d/state.json" "0.5.4"; then ok "L downgrade: registry untouched" "latest=0.5.4 for all six"; else bad "L downgrade: registry untouched" "registry changed"; fi
invoke "$d" 0.5.3 --yes --allow-downgrade
assert_eq "L downgrade: --allow-downgrade proceeds" 0 "$RC"
assert_eq "L downgrade: six dist-tag adds" 6 "$(adds_count)"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "L downgrade: moved to 0.5.3" "latest=0.5.3 for all six"; else bad "L downgrade: moved to 0.5.3" "not all 0.5.3"; fi

# ── M. a PRE-RELEASE target gets the same loud confirm ────────────────────────
d="$(new_fixture prerelease)"
write_state "$d/state.json" "0.6.0-rc.1" "0.5.4"
invoke "$d" 0.6.0-rc.1 --yes
assert_eq "M prerelease: --yes alone aborts" 3 "$RC"
assert_contains "M prerelease: says PRE-RELEASE" "$ERR" "PRE-RELEASE"
assert_eq "M prerelease: no dist-tag add attempted" 0 "$(adds_count)"
invoke "$d" 0.6.0-rc.1 --yes --allow-downgrade
assert_eq "M prerelease: --allow-downgrade proceeds" 0 "$RC"
assert_eq "M prerelease: six dist-tag adds" 6 "$(adds_count)"

# ── N. every npm call is pinned to a registry ────────────────────────────────
d="$(new_fixture registry-pin)"
write_state "$d/state.json" "0.5.4" "0.5.3"
invoke "$d" 0.5.4 --yes
total_lines="$(wc -l <"$LOG")"
unpinned="$(grep -vF -- '--registry https://registry.npmjs.org' "$LOG" | grep -c .)"
if [ "$total_lines" -gt 0 ] && [ "$unpinned" -eq 0 ]; then
  ok "N registry pin: every npm call pinned" "$total_lines calls, 0 unpinned"
else
  bad "N registry pin: every npm call pinned" "$total_lines calls, $unpinned unpinned"
fi

# ── R. each dist-tag add inherits the tool's stdin and stdout (npm's 2FA gate) ──
# The fake npm intentionally refuses every `dist-tag add` lacking either TTY,
# returning EOTP. This fixture gives the tool both on the pty and pins that each
# add had both. A script that captures the add's output (the pre-fix shape) gets
# EOTP from the fake npm on the first add, and the tag does not move; this fixture
# and M6 are that control.
d="$(new_fixture tty-2fa)"
write_state "$d/state.json" "0.5.4" "0.5.3"
invoke "$d" 0.5.4 --yes
assert_eq "R tty-2fa: exit" 0 "$RC"
assert_eq "R tty-2fa: six dist-tag adds" 6 "$(adds_count)"
assert_eq "R tty-2fa: every add had stdin+stdout TTYs" 6 "$(grep -c '^dist-tag add .* stdin_tty=1 stdout_tty=1$' "$LOG")"
assert_eq "R tty-2fa: no add without both TTYs" 0 "$(grep '^dist-tag add ' "$LOG" | grep -vc 'stdin_tty=1 stdout_tty=1$')"
if all_latest_eq "$d/state.json" "0.5.4"; then ok "R tty-2fa: registry moved" "latest=0.5.4 for all six"; else bad "R tty-2fa: registry moved" "not all 0.5.4"; fi

# ── S. stdout on the pty but stdin not: the add is refused ───────────────────
# For a changing tag whose registry operation requires 2FA, npm can prompt only
# with TTYs on stdin and stdout. This fixture overrides tool stdin with /dev/null
# while keeping stdout on the pty. The fake npm refuses the first add with EOTP,
# leaving its tag unmoved. It also refuses the rollback add of that unmoved tag,
# so here the tool reports ROLLBACK FAILED (exit 5)
# with the registry unchanged. A stub that checks only stdout lets these adds
# through, and this fixture fails.
d="$(new_fixture stdin-not-tty)"
write_state "$d/state.json" "0.5.4" "0.5.3"
invoke_stdin_not_tty "$d" 0.5.4 --yes
assert_eq "S stdin-not-tty: exit" 5 "$RC"
assert_eq "S stdin-not-tty: two adds (promote, rollback)" 2 "$(adds_count)"
assert_eq "S stdin-not-tty: adds had stdout TTY only" 2 "$(grep -c '^dist-tag add .* stdin_tty=0 stdout_tty=1$' "$LOG")"
assert_contains "S stdin-not-tty: npm refused with EOTP" "$ERR" "npm error code EOTP"
assert_contains "S stdin-not-tty: reports the rollback failure" "$ERR" "ROLLBACK FAILED for @tpsdev-ai/cli-darwin-arm64"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "S stdin-not-tty: registry unchanged" "latest=0.5.3 for all six"; else bad "S stdin-not-tty: registry unchanged" "registry changed"; fi

# ── T. a successful promote dispatches the Docker image once, after the moves ──
d="$(new_fixture dispatch-success)"
write_state "$d/state.json" "0.5.4" "0.5.3"
invoke "$d" 0.5.4 --yes
assert_eq "T dispatch: exit" 0 "$RC"
assert_eq "T dispatch: gh called exactly once" 1 "$(gh_calls "$d")"
assert_contains "T dispatch: the right command" "$(cat "$d/gh.log")" "workflow run docker.yml --repo tpsdev-ai/cli -f version=0.5.4"
assert_eq "T dispatch: ran after all six dist-tag adds" 1 "$(grep -c '^adds_before=6$' "$d/gh.log" 2>/dev/null || true)"
assert_eq "T dispatch: six dist-tag adds" 6 "$(adds_count)"
if all_latest_eq "$d/state.json" "0.5.4"; then ok "T dispatch: registry moved" "latest=0.5.4 for all six"; else bad "T dispatch: registry moved" "not all 0.5.4"; fi

# ── U. a failed promote never dispatches the Docker image ─────────────────────
d="$(new_fixture dispatch-on-failure)"
write_state "$d/state.json" "0.5.4" "0.5.3" "cli-linux-arm64"
invoke "$d" 0.5.4 --yes
assert_eq "U no-dispatch-on-failure: exit" 4 "$RC"
assert_eq "U no-dispatch-on-failure: gh never called" 0 "$(gh_calls "$d")"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "U no-dispatch-on-failure: rolled back" "latest=0.5.3 for all six"; else bad "U no-dispatch-on-failure: rolled back" "a partial promote was left behind"; fi

# ── V. --no-docker promotes but never dispatches ──────────────────────────────
d="$(new_fixture no-docker)"
write_state "$d/state.json" "0.5.4" "0.5.3"
invoke "$d" 0.5.4 --yes --no-docker
assert_eq "V no-docker: exit" 0 "$RC"
assert_eq "V no-docker: gh never called" 0 "$(gh_calls "$d")"
assert_eq "V no-docker: six dist-tag adds" 6 "$(adds_count)"
if all_latest_eq "$d/state.json" "0.5.4"; then ok "V no-docker: registry moved" "latest=0.5.4 for all six"; else bad "V no-docker: registry moved" "not all 0.5.4"; fi

# ── W. a gh failure after a successful promote: distinct exit, message, no rollback ─
d="$(new_fixture dispatch-fail)"
write_state "$d/state.json" "0.5.4" "0.5.3"
GH_STUB_FAIL=1 invoke "$d" 0.5.4 --yes
assert_eq "W dispatch-fail: exit" 6 "$RC"
assert_contains "W dispatch-fail: says NOT dispatched" "$ERR" "the Docker image was NOT dispatched"
assert_contains "W dispatch-fail: prints the command" "$ERR" "gh workflow run docker.yml --repo tpsdev-ai/cli -f version=0.5.4"
if all_latest_eq "$d/state.json" "0.5.4"; then ok "W dispatch-fail: no rollback" "latest=0.5.4 for all six"; else bad "W dispatch-fail: no rollback" "the promote was rolled back"; fi
GH_STUB_FAIL=""

# ── X. gh missing: same distinct exit and message, no rollback ────────────────
d="$(new_fixture gh-missing)"
write_state "$d/state.json" "0.5.4" "0.5.3"
GH_BIN_OVERRIDE="$work/no-such-gh" invoke "$d" 0.5.4 --yes
assert_eq "X gh-missing: exit" 6 "$RC"
assert_contains "X gh-missing: says NOT dispatched" "$ERR" "the Docker image was NOT dispatched"
assert_contains "X gh-missing: names the missing binary" "$ERR" "gh not found"
if all_latest_eq "$d/state.json" "0.5.4"; then ok "X gh-missing: no rollback" "latest=0.5.4 for all six"; else bad "X gh-missing: no rollback" "the promote was rolled back"; fi
GH_BIN_OVERRIDE=""

# ── M1. mutation: break the existence check; fixture A must catch it ──────────
mut="$work/tool-no-existence.sh"
if node "$work/mutate.mjs" "$tool" "$mut" existence; then
  d="$(new_fixture mut-existence)"
  write_state "$d/state.json" "0.5.4" "0.5.4"
  TOOL="$mut" invoke "$d" 0.6.0 --dry-run
  if [ "$RC" -eq 2 ]; then bad "M1 mutation: existence break caught" "mutant still exited 2 — fixture A is blind to it"; else ok "M1 mutation: existence break caught" "mutant exited $RC (fixture A expects 2)"; fi
  TOOL=""
else
  bad "M1 mutation: existence break caught" "could not build the mutant"
fi

# ── M2. mutation: break the post-move re-read; fixture G must catch it ────────
mut="$work/tool-no-verify.sh"
if node "$work/mutate.mjs" "$tool" "$mut" verify; then
  d="$(new_fixture mut-verify)"
  write_state "$d/state.json" "0.5.4" "0.5.3" "cli-linux-arm64"
  TOOL="$mut" invoke "$d" 0.5.4 --yes
  if all_latest_eq "$d/state.json" "0.5.3"; then bad "M2 mutation: re-read break caught" "mutant restored the registry — fixture G is blind to it"; else ok "M2 mutation: re-read break caught" "mutant left a partial promote (fixture G catches it)"; fi
  TOOL=""
else
  bad "M2 mutation: re-read break caught" "could not build the mutant"
fi

# ── M3. mutation: remove the TERM trap; fixture K must catch it ───────────────
mut="$work/tool-no-trap.sh"
if node "$work/mutate.mjs" "$tool" "$mut" interrupt; then
  d="$(new_fixture mut-trap)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  TOOL="$mut" run_interrupt "$d" "cli-linux-arm64" "0.5.4" TERM 0.5.4 --yes
  if all_latest_eq "$d/state.json" "0.5.3"; then bad "M3 mutation: missing TERM trap caught" "mutant restored the registry — fixture K is blind to it"; else ok "M3 mutation: missing TERM trap caught" "mutant left a partial promote (fixture K catches it)"; fi
  TOOL=""
else
  bad "M3 mutation: missing TERM trap caught" "could not build the mutant"
fi

# ── M4. mutation: flag the attempt AFTER the add; fixture K must catch it ─────
mut="$work/tool-reorder.sh"
if node "$work/mutate.mjs" "$tool" "$mut" reorder; then
  d="$(new_fixture mut-reorder)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  TOOL="$mut" run_interrupt "$d" "cli-linux-arm64" "0.5.4" TERM 0.5.4 --yes
  if all_latest_eq "$d/state.json" "0.5.3"; then bad "M4 mutation: late attempt flag caught" "mutant restored the registry — fixture K is blind to it"; else ok "M4 mutation: late attempt flag caught" "mutant left the in-flight package moved (fixture K catches it)"; fi
  TOOL=""
else
  bad "M4 mutation: late attempt flag caught" "could not build the mutant"
fi

# ── M5. mutation: clear the traps before the failure branch; O must catch it ──
mut="$work/tool-trapclear.sh"
if node "$work/mutate.mjs" "$tool" "$mut" trapclear; then
  d="$(new_fixture mut-trapclear)"
  write_state "$d/state.json" "0.5.4" "0.5.3" "cli"
  TOOL="$mut" run_interrupt "$d" "cli-linux-arm64" "0.5.3" TERM 0.5.4 --yes
  if all_latest_eq "$d/state.json" "0.5.3"; then bad "M5 mutation: early trap clear caught" "mutant restored the registry — fixture O is blind to it"; else ok "M5 mutation: early trap clear caught" "mutant stranded a partial promote (fixture O catches it)"; fi
  TOOL=""
else
  bad "M4 mutation: late attempt flag caught" "could not build the mutant"
fi

# ── M6. mutation: capture the add again; fixture R must catch it ─────────────
# A captured add's stdout is not a TTY, so the fake npm EOTPs it and the tag does
# not move. Only the promote add is captured here; the rollback add still inherits
# the pty, so the mutant's rollback succeeds (exit 4). A test that passes on this
# mutant is blind to the bug this issue is about.
mut="$work/tool-capture.sh"
if node "$work/mutate.mjs" "$tool" "$mut" capture; then
  d="$(new_fixture mut-capture)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  TOOL="$mut" invoke "$d" 0.5.4 --yes
  captured="$(grep -c '^dist-tag add .* stdout_tty=0$' "$LOG")"
  if [ "$RC" -eq 0 ]; then bad "M6 mutation: captured add caught" "mutant exited 0 — fixture R is blind to it"; else ok "M6 mutation: captured add caught" "mutant exited $RC (fixture R expects 0)"; fi
  if [ "$captured" -ge 1 ]; then ok "M6 mutation: add's stdout not a TTY" "the log records a captured add"; else bad "M6 mutation: add's stdout not a TTY" "no stdout_tty=0 add in the log"; fi
  TOOL=""
else
  bad "M6 mutation: captured add caught" "could not build the mutant"
fi

# ── M7. mutation: dispatch inside the move loop (before the post-check) ───────
# The mutant dispatches right after each `dist-tag add`, before the registry is
# re-read to confirm the move, as well as at the end. Fixture T (exactly one
# dispatch) must catch it: the mutant dispatches once per move, not once per
# promote. A test that passes on this mutant is blind to dispatching before the
# post-check.
mut="$work/tool-dispatch-early.sh"
if node "$work/mutate.mjs" "$tool" "$mut" dispatch_early; then
  d="$(new_fixture mut-dispatch-early)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  TOOL="$mut" invoke "$d" 0.5.4 --yes
  if [ "$(gh_calls "$d")" -eq 1 ]; then bad "M7 mutation: early dispatch caught" "mutant still dispatched once — fixture T is blind to it"; else ok "M7 mutation: early dispatch caught" "mutant dispatched $(gh_calls "$d") times (fixture T expects 1)"; fi
  TOOL=""
else
  bad "M7 mutation: early dispatch caught" "could not build the mutant"
fi

# ── M8. mutation: roll back on a gh failure; fixture W must catch it ──────────
# The mutant rolls the promote back when the dispatch fails. Fixture W (a gh
# failure leaves `latest` at the target) must catch it: the mutant restores the
# previous `latest`. A test that passes on this mutant is blind to a dispatch
# failure undoing a promote that already succeeded.
mut="$work/tool-dispatch-rollback.sh"
if node "$work/mutate.mjs" "$tool" "$mut" dispatch_rollback; then
  d="$(new_fixture mut-dispatch-rollback)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  GH_STUB_FAIL=1 TOOL="$mut" invoke "$d" 0.5.4 --yes
  if all_latest_eq "$d/state.json" "0.5.4"; then bad "M8 mutation: rollback on gh failure caught" "mutant kept the promote — fixture W is blind to it"; else ok "M8 mutation: rollback on gh failure caught" "mutant rolled the promote back (fixture W catches it)"; fi
  GH_STUB_FAIL=""
  TOOL=""
else
  bad "M8 mutation: rollback on gh failure caught" "could not build the mutant"
fi

# ── regression guard: the tool must stay clear of known bash-4 syntax ─────────
# Companion only, NOT coverage — see the header. The real control is the macos-14
# CI leg running this harness under bash 3.2.
grep -vE '^[[:space:]]*#' "$tool" >"$work/tool-code.txt"
if grep -nF -e 'declare -A' -e 'mapfile' -e 'readarray' -e ';;&' -e '&>>' -e '^^' "$work/tool-code.txt" >"$work/b4.txt"; then
  bad "bash-4 denylist (companion only)" "known bash-4-only syntax found:"
  sed 's/^/      /' "$work/b4.txt"
else
  ok "bash-4 denylist (companion only)" "no known bash-4-only syntax"
fi

# ── regression guard: the CI workflow must still invoke this harness ──────────
if grep -qF './scripts/test-promote-latest.sh' "$repo_root/.github/workflows/test.yml"; then
  ok "workflow invokes this harness" "test.yml"
else
  bad "workflow invokes this harness" "test.yml no longer calls ./scripts/test-promote-latest.sh"
fi

# ── the tool itself must be executable ───────────────────────────────────────
if [ -x "$tool" ]; then ok "promote-latest.sh is executable" ""; else bad "promote-latest.sh is executable" "not executable"; fi

# ── shellcheck the scripts (warning+), when available ────────────────────────
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -S warning -s bash "$tool" "$here/test-promote-latest.sh" >"$work/sc.txt" 2>&1; then
    ok "shellcheck (warning+)" "clean"
  else
    bad "shellcheck (warning+)" "findings:"
    sed 's/^/      /' "$work/sc.txt"
  fi
else
  printf 'SKIP  %-42s shellcheck not installed\n' "shellcheck (warning+)"
fi

printf '\ntest-promote-latest: %d passed, %d failed\n' "$npass" "$nfail"
[ "$nfail" -eq 0 ]
