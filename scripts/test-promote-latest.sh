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
#   * MUTATION CHECKS: break the existence check, the post-move re-read, the TERM
#     trap, and the pre-add attempt flag; confirm a fixture catches each — a test
#     that passes on both the fixed and the broken script is not a test.
#   * the fixtures run under bash 3.2 too (BASH_BIN; the macos-14 CI leg pins it),
#     and the workflow still invokes this harness
#
# The bash-4 denylist below is a cheap companion, NOT coverage: it catches only the
# constructs that have already bitten. The real control for the bash-3.2 class is
# the `macos-14` CI leg, which runs this whole harness under /bin/bash (3.2.57).
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
log(args.join(' '));
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
    "  moved[i]=1\n  printf '\\n-> %s: npm dist-tag add %s@%s latest\\n' \"${names[i]}\" \"${names[i]}\" \"$version\"\n  set +e\n  out=\"$(\"$NPM_BIN\" dist-tag add \"${names[i]}@${version}\" latest --registry \"$NPM_REGISTRY\" 2>&1)\"\n  rc=$?\n  set -e\n",
    "  printf '\\n-> %s: npm dist-tag add %s@%s latest\\n' \"${names[i]}\" \"${names[i]}\" \"$version\"\n  set +e\n  out=\"$(\"$NPM_BIN\" dist-tag add \"${names[i]}@${version}\" latest --registry \"$NPM_REGISTRY\" 2>&1)\"\n  rc=$?\n  set -e\n  moved[i]=1\n",
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
invoke() { # [TOOL=...] <fixture-dir> [args...]
  local d="$1"
  shift
  local t="${TOOL:-$tool}"
  LOG="$d/log.txt"
  : >"$LOG"
  OUT="$(FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="$fake_npm" \
    "$BASH_BIN" "$t" "$@" 2>"$d/err.txt")"
  RC=$?
  ERR="$(cat "$d/err.txt")"
}
invoke_stdin() { # [TOOL=...] <fixture-dir> <reply> [args...]
  local d="$1"
  local reply="$2"
  shift 2
  local t="${TOOL:-$tool}"
  LOG="$d/log.txt"
  : >"$LOG"
  OUT="$(printf '%s\n' "$reply" | FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="$fake_npm" \
    "$BASH_BIN" "$t" "$@" 2>"$d/err.txt")"
  RC=$?
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
  local hv="$holdver"
  [ "$holdver" = "-" ] && hv=""
  FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="$fake_npm" \
    FAKE_NPM_HOLD_PKG="@tpsdev-ai/$hold" FAKE_NPM_HOLD_VER="$hv" FAKE_NPM_MARKER="$HCOUNTER" \
    "$BASH_BIN" "$t" "$@" >"$d/out.txt" 2>"$d/err.txt" &
  HPID=$!
}
finish_held() { # <dir>
  local d="$1"
  wait "$HPID" 2>/dev/null
  IRC=$?
  OUT="$(cat "$d/out.txt")"
  ERR="$(cat "$d/err.txt")"
}
run_interrupt() { # [TOOL=...] <dir> <hold-pkg-short> <hold-ver|-> <signal> [args...]
  local d="$1"
  local hold="$2"
  local holdver="$3"
  local sig="$4"
  shift 4
  start_held "$d" "$hold" "$holdver" "$@"
  wait_count "$HCOUNTER" 1
  kill -"$sig" "$HPID" 2>/dev/null
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
  kill -"$sig1" "$HPID" 2>/dev/null
  wait_count "$HCOUNTER" 2
  kill -"$sig2" "$HPID" 2>/dev/null
  finish_held "$d"
}
adds_count() {
  local n
  n="$(grep -c '^dist-tag add ' "$LOG" 2>/dev/null)"
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
