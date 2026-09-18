#!/usr/bin/env bash
# test-promote-latest.sh — fails-first fixtures for scripts/promote-latest.sh (cli#366).
#
# The promote script's value is its REFUSALS and its verification, so this harness
# pins both against a FAKE registry: no network, no real npm, and no real dist-tag
# is ever moved. Each fixture builds a fake repo tree plus a fake `npm` (injected via
# NPM_BIN) whose registry state is a JSON file the test controls, then drives
# scripts/promote-latest.sh and asserts its exit code, its text, and the resulting
# registry state.
#
# Covered:
#   * refuse when the target version is not published for all six — and name them
#   * refuse when only SOME are missing — and name only those
#   * proceed (dry-run) when the version is fully published
#   * "already latest" is reported as such, not proposed as a no-op move
#   * a move that does not land (npm exits 0, the registry never changes) is caught
#     by the post-move re-read, and the packages already moved are rolled back
#   * the confirmation gate aborts on anything but "yes"
#   * MUTATION CHECKS: break the existence check and the re-read, confirm a fixture
#     catches each — a test that passes on both the fixed and the broken script is
#     not a test. This harness runs its own mutants and asserts it catches them.
#   * the CI workflow still invokes this harness, so a later edit cannot orphan it
#
# The fixtures are generated at run time, not committed, so no fake registry state
# or mutant script lives in the tree for scanners to read as real.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
tool="$here/promote-latest.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

six_dirs=(cli-darwin-arm64 cli-darwin-x64 cli-linux-arm64 cli-linux-x64 agent cli)

npass=0
nfail=0
ok() { printf 'PASS  %-38s %s\n' "$1" "$2"; npass=$((npass + 1)); }
bad() { printf 'FAIL  %-38s %s\n' "$1" "$2"; nfail=$((nfail + 1)); }

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
  // `noopAdd`: simulate a command that exits 0 but never moves the tag — the exact
  // failure prompt 3 exists to catch.
  if (!((s.noopAdd || []).includes(spec.pkg))) { s.latest[spec.pkg] = spec.ver; persist(s); }
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
invoke() { # [TOOL=...] <fixture-dir> [args...]
  local d="$1"
  shift
  local t="${TOOL:-$tool}"
  LOG="$d/log.txt"
  : >"$LOG"
  OUT="$(FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="$fake_npm" \
    bash "$t" "$@" 2>"$d/err.txt")"
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
    bash "$t" "$@" 2>"$d/err.txt")"
  RC=$?
  ERR="$(cat "$d/err.txt")"
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

# ── M1. mutation check: break the existence check, the fixture must catch it ──
mut1="$work/tool-no-existence.sh"
if node "$work/mutate.mjs" "$tool" "$mut1" existence; then
  d="$(new_fixture mut-existence)"
  write_state "$d/state.json" "0.5.4" "0.5.4"
  TOOL="$mut1" invoke "$d" 0.6.0 --dry-run
  # Fixture A expects exit 2 here. A mutant that no longer refuses must NOT exit 2,
  # or the fixture is blind to the break.
  if [ "$RC" -eq 2 ]; then
    bad "M1 mutation: existence break caught" "mutant still exited 2 — fixture A is blind to it"
  else
    ok "M1 mutation: existence break caught" "mutant exited $RC (fixture A expects 2)"
  fi
  TOOL=""
else
  bad "M1 mutation: existence break caught" "could not build the mutant"
fi

# ── M2. mutation check: break the post-move re-read, the fixture must catch it ─
mut2="$work/tool-no-verify.sh"
if node "$work/mutate.mjs" "$tool" "$mut2" verify; then
  d="$(new_fixture mut-verify)"
  write_state "$d/state.json" "0.5.4" "0.5.3" "cli-linux-arm64"
  TOOL="$mut2" invoke "$d" 0.5.4 --yes
  # Fixture G asserts the registry is restored to none-moved. A mutant that trusts
  # the exit code never triggers the rollback, so the partial promote survives.
  if all_latest_eq "$d/state.json" "0.5.3"; then
    bad "M2 mutation: re-read break caught" "mutant restored the registry — fixture G is blind to it"
  else
    ok "M2 mutation: re-read break caught" "mutant left a partial promote (fixture G catches it)"
  fi
  TOOL=""
else
  bad "M2 mutation: re-read break caught" "could not build the mutant"
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
  if shellcheck -S warning "$tool" "$here/test-promote-latest.sh" >"$work/sc.txt" 2>&1; then
    ok "shellcheck (warning+)" "clean"
  else
    bad "shellcheck (warning+)" "findings:"
    sed 's/^/      /' "$work/sc.txt"
  fi
else
  printf 'SKIP  %-38s shellcheck not installed\n' "shellcheck (warning+)"
fi

printf '\ntest-promote-latest: %d passed, %d failed\n' "$npass" "$nfail"
[ "$nfail" -eq 0 ]
