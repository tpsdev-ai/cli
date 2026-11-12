#!/usr/bin/env bash
# test-promote-latest.sh — fails-first fixtures for scripts/promote-latest.sh (cli#366).
#
# The promote script's value is its REFUSALS, its verification, and its rollback,
# so this harness pins all three. Most fixtures run against a FAKE registry: no
# network, no real npm, and no real dist-tag is ever moved. Each such fixture
# builds a fake repo tree plus a fake `npm` (injected via NPM_BIN) whose registry
# state is a JSON file the test controls, then drives scripts/promote-latest.sh
# and asserts its exit code, its text, and the resulting registry state. Four
# cases (AI, AJ, AS, AN), and mutants M12/M13, run the REAL npm CLI against a registry the test starts on
# 127.0.0.1, so the 2FA prompt seam is exercised by the real client.
#
# Covered:
#   * refuse when the target version is not published for all six — and name them
#   * refuse when only SOME are missing — and name only those
#   * proceed (dry-run) when the version is fully published
#   * "already latest" is reported as such, not proposed as a no-op move
#   * a move that does not land (npm exits 0, the registry never changes) is caught
#     by the post-move re-read, and the packages already moved are rolled back
#   * an INTERRUPT (SIGTERM) during a promote write keeps the lock and records that write
#   * a signal during failure-path rollback does not abandon the restorations (O)
#   * a second TERM during the handler's rollback is ignored: the rollback
#     completes, the registry is restored and the lock is released (P)
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
#     promoted version, after all adds (T); failed adds and failed post-add
#     verification prevent dispatch (U, Y). The final registry read also covers
#     initially current tags that drift or become unreadable (Z, AA); M7 and M9
#     expose dispatch before verification finishes or without that final read.
#     `--no-docker` skips dispatch (V); a gh failure after a successful promote
#     exits 6 without rollback (W); a missing gh does the same (X)
#   * MUTATION CHECKS: break the existence check, the post-move re-read, the TERM
#     trap, the pre-add attempt flag, and the trap-clear branch, restore the
#     command substitution around `dist-tag add`, dispatch before the last
#     post-check, skip the final all-package read, roll back on a gh failure,
#     send KILL without the exit-code check, count sleeps instead of measuring
#     elapsed time, move the keep_lock assignment after the reason write, drop
#     rollback failures from the reason, release the lock on the delayed-commit
#     path, call an uncertain package restored, and drop `<&0` from the npm
#     launch; confirm a fixture catches each — a test that passes on both the
#     fixed and the broken script is not a test.
#   * a timed-out mutating call (`dist-tag add`) leaves the run UNCERTAIN: exit 7,
#     no "restored" line for that package, and the lock remains, with a reason
#     file when it can be written (AD, AE); a later run refuses and prints the
#     reason. A timed-out read keeps the ordinary failure path (AF). The lock
#     refusal says `unknown` when it sees the directory before the `pid` file
#     (AH). A reason file that cannot be written keeps the lock and prints one
#     error (AM). A delayed commit is still listed by a later refusal (AN). An
#     uncertain write and a rollback failure on different packages are both
#     listed (AO).
#   * npm exiting during the TERM grace ends the call without a KILL (AG); a
#     child that ignores TERM is KILLed after the grace (AL), timed from the
#     supervisor's own start/end lines. A supervisor log is read with strict
#     per-call framing, and a command that cannot start still logs one
#     start/end pair (AT).
#   * the real npm CLI against a local registry: the OTP challenge is answered by
#     the typed code on the `npm-otp` retry and the tag moves (AI); a PUT that
#     never answers makes the run uncertain (AJ); TERM during a pending PUT keeps
#     the lock (AS); a PUT the server applies after the client was killed is still
#     listed by a later refusal (AN).
#     TPS_TEST_REQUIRE_REAL_NPM=1 makes a missing npm, node or python3 a failure
#     instead of a skip.
#   * the fixtures run under bash 3.2 too (BASH_BIN; the macOS CI leg pins it),
#     and the workflow still invokes this harness
#
# The bash-4 denylist below is a cheap companion, NOT coverage: it catches only the
# constructs that have already bitten. The real control for the bash-3.2 class is
# the macOS CI leg, which runs this whole harness under /bin/bash and fails unless
# that bash reports version 3.2.
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
# Script mutants live beside a copy of the real supervisor, because the tool
# resolves npm-supervisor.mjs from its own directory.
cp "$here/npm-supervisor.mjs" "$work/npm-supervisor.mjs"
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
import signal
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
proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=err_fd,
                        preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL))
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

# ── supervisor log parser ────────────────────────────────────────────────────
# Applies strict per-call framing to a PROMOTE_SUPERVISOR_LOG: every line is a
# `start <ms>`, an `end <ms>`, or a signal name, matched whole, so an extra token
# or a blank line mid-file is an unknown line. A start while a call is open, an
# end or signal with no open call, an unknown line, or a call left open at the
# end of the log fails. On a valid log it prints the signalled call's own
# duration in seconds, so a log that loses that call's end cannot pass by pairing
# its start with the next call's end.
supervisor_log_parser="$work/supervisor-log.mjs"
cat >"$supervisor_log_parser" <<'LOG_PARSER'
import fs from 'node:fs';

function fail(why) {
  process.stderr.write('supervisor log: ' + why + '\n');
  process.exit(1);
}

const text = fs.readFileSync(process.argv[2], 'utf8');
const body = text.endsWith('\n') ? text.slice(0, -1) : text;
const lines = text === '' ? [] : body.split('\n');
const startLine = /^start (\d+)$/;
const endLine = /^end (\d+)$/;
const signalLine = /^(INT|TERM|HUP|KILL)$/;
const calls = [];
let open = null;
for (const line of lines) {
  let match;
  if ((match = startLine.exec(line)) !== null) {
    if (open !== null) fail('a start line while a call is open: ' + line);
    open = { start: Number(match[1]), signalled: false };
  } else if ((match = endLine.exec(line)) !== null) {
    if (open === null) fail('an end line with no open call: ' + line);
    open.end = Number(match[1]);
    calls.push(open);
    open = null;
  } else if (signalLine.test(line)) {
    if (open === null) fail('a signal line with no open call: ' + line);
    open.signalled = true;
  } else {
    fail('an unknown line: ' + line);
  }
}
if (open !== null) fail('a call left open at the end of the log');
const signalled = calls.filter((call) => call.signalled);
if (signalled.length === 0) fail('no signalled call');
process.stdout.write(((signalled[0].end - signalled[0].start) / 1000).toFixed(2));
LOG_PARSER

# ── real-npm seam helpers ────────────────────────────────────────────────────
# A small registry on 127.0.0.1, written at run time, with no dependency beyond
# node. It serves the packument and dist-tags reads that `npm view` makes, and the
# dist-tag PUT that `npm dist-tag add` makes. mode `otp` answers the first PUT
# with a one-time-password challenge; mode `hang-put` never answers a PUT.
registry_js="$work/registry.js"
cat >"$registry_js" <<'REGISTRY_JS'
'use strict';
const http = require('http');
const fs = require('fs');
const [portFile, stateFile, mode] = process.argv.slice(2);
const names = ['cli-darwin-arm64', 'cli-darwin-x64', 'cli-linux-arm64', 'cli-linux-x64', 'agent', 'cli'];
const latest = {};
for (const n of names) latest['@tpsdev-ai/' + n] = '0.5.3';
const requests = [];
const applied = [];
const disconnected = [];
let eventOrder = 0;
function persist() { fs.writeFileSync(stateFile, JSON.stringify({ latest, requests, applied, disconnected }, null, 2)); }
function manifest(pkg, version) {
  return { name: pkg, version, dist: { tarball: 'http://127.0.0.1/' + pkg.replace('/', '-') + '-' + version + '.tgz', shasum: '0' } };
}
function record(req, body) {
  requests.push({ method: req.method, url: req.url, otp: req.headers['npm-otp'] || null, body: body });
  persist();
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    record(req, body);
    const tag = req.url.match(/^\/-\/package\/@tpsdev-ai(?:%2f|\/)([^/]+)\/dist-tags(?:\/([^/]+))?$/);
    if (tag) {
      const pkg = '@tpsdev-ai/' + tag[1];
      if (req.method === 'GET' && !tag[2]) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ latest: latest[pkg] }));
        return;
      }
      if (req.method === 'PUT' && tag[2] === 'latest') {
        if (mode === 'hang-put') return; // never answer
        if (mode === 'delayed-put') {
          const received = Date.now();
          res.on('close', () => {
            if (res.writableEnded) return;
            const closed = Date.now();
            disconnected.push({ pkg, at: closed, order: ++eventOrder });
            latest[pkg] = JSON.parse(body);
            applied.push({ pkg, version: latest[pkg], received, closed, at: Date.now(), order: ++eventOrder });
            persist();
          });
          return;
        }
        if (!req.headers['npm-otp']) {
          res.writeHead(401, { 'www-authenticate': 'OTP', 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'one-time password required' }));
          return;
        }
        if (req.headers['npm-otp'] !== process.env.OTP_CODE) {
          res.writeHead(401, { 'www-authenticate': 'OTP', 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad one-time password' }));
          return;
        }
        latest[pkg] = JSON.parse(body);
        persist();
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }
    const doc = req.url.match(/^\/@tpsdev-ai(?:%2f|\/)([^/]+)(?:\/([^/]+))?$/);
    if (req.method === 'GET' && doc) {
      const pkg = '@tpsdev-ai/' + doc[1];
      if (latest[pkg] === undefined) { res.writeHead(404); res.end('{}'); return; }
      if (doc[2]) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(manifest(pkg, doc[2])));
        return;
      }
      const versions = {};
      for (const v of ['0.5.3', '0.5.4']) versions[v] = manifest(pkg, v);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: pkg, 'dist-tags': { latest: latest[pkg] }, versions }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
  persist();
});
process.on('SIGTERM', () => process.exit(0));
REGISTRY_JS

real_pty_runner="$work/real-npm-pty.py"
cat >"$real_pty_runner" <<'REAL_PTY'
"""Run a command on a pty with stderr merged in, typing OTP_CODE at npm's prompt.

argv: <command> [args...]. The prompt is npm's one-time-password prompt on the
merged terminal; the code is typed at each prompt. The command's whole output
is copied to this process's stdout. Exits with the command's status, or 124
after PTY_TIMEOUT seconds (default 60).
"""
import os
import pty
import re
import select
import signal
import subprocess
import sys
import termios
import time

argv = sys.argv[1:]
otp = os.environ.get('OTP_CODE', '')
master, slave = pty.openpty()
attrs = termios.tcgetattr(slave)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(slave, termios.TCSANOW, attrs)
proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave,
                        preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL))
if os.environ.get('PTY_PIDFILE'):
    with open(os.environ['PTY_PIDFILE'], 'w') as f:
        f.write(str(proc.pid))
os.close(slave)
deadline = time.monotonic() + float(os.environ.get('PTY_TIMEOUT', '60'))
out = sys.stdout.buffer
ansi = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]')
prompt = re.compile(rb'enter\s*otp')
typed = 0
buf = b''
while True:
    left = deadline - time.monotonic()
    if left <= 0:
        proc.kill()
        proc.wait()
        out.flush()
        sys.stderr.write('real-npm-pty: timed out; killed the command\n')
        sys.exit(124)
    ready, _, _ = select.select([master], [], [], left)
    if master in ready:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        out.write(chunk)
        out.flush()
        buf += chunk
        # Count prompts in the whole (ANSI-stripped) stream: npm prompts once per
        # invocation, and a prompt can be split across reads.
        want = len(prompt.findall(ansi.sub(b'', buf).lower()))
        if want > typed:
            typed = want
            time.sleep(0.2)
            os.write(master, otp.encode() + b'\n')
    if proc.poll() is not None:
        try:
            while True:
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                out.write(chunk)
        except OSError:
            pass
        break
out.flush()
sys.exit(proc.wait())
REAL_PTY

start_registry() { # <dir> <mode> -> sets REG_PID and REG_PORT
  local d="$1"
  local mode="$2"
  : >"$d/registry.state"
  OTP_CODE="${OTP_CODE:-}" node "$registry_js" "$d/port" "$d/registry.state" "$mode" >"$d/registry.log" 2>&1 &
  REG_PID=$!
  local n=0
  while [ "$n" -lt 100 ]; do
    if [ -s "$d/port" ]; then REG_PORT="$(cat "$d/port")"; return 0; fi
    sleep 0.1
    n=$((n + 1))
  done
  return 1
}

stop_registry() {
  if [ -n "${REG_PID:-}" ]; then
    kill "$REG_PID" 2>/dev/null || :
    wait "$REG_PID" 2>/dev/null || :
    REG_PID=""
  fi
}

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
    if (s.stallView === spec.pkg) {
      // One stalled READ. Clear it first so the rollback's re-read can answer.
      delete s.stallView;
      persist(s);
      if (process.env.FAKE_NPM_PIDFILE) fs.writeFileSync(process.env.FAKE_NPM_PIDFILE, String(process.pid));
      process.on('SIGTERM', () => {});
      setTimeout(() => { process.stdout.write(s.latest[spec.pkg] + '\n'); }, Number(process.env.FAKE_NPM_STALL_VIEW_MS || 10000));
      return;
    }
    if ((s.failViewLatest || []).includes(spec.pkg)) fail('npm error code E503\nnpm error fake registry read failed');
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
  if (s.rollbackFailPkg === spec.pkg && spec.ver === s.rollbackFailVersion) {
    fail('npm error code E401\nnpm error fake npm: rollback add refused');
  }
  const willStall = (s.stallAdd === spec.pkg && spec.ver !== s.stallRollbackVersion) ||
    (s.stallRollbackPkg === spec.pkg && spec.ver === s.stallRollbackVersion);
  // `noopAdd`: a command that exits 0 but never moves the tag. `stallNoCommit`:
  // the stalled add never applies its change.
  if (!((s.noopAdd || []).includes(spec.pkg)) && !(willStall && s.stallNoCommit)) s.latest[spec.pkg] = spec.ver;
  if (s.stallViewAfterAdd === spec.pkg) {
    // Stall the FIRST read after this add, then let later reads through so the
    // rollback's re-read can answer.
    s.stallView = spec.pkg;
    delete s.stallViewAfterAdd;
  }
  if (s.afterAdd && spec.pkg === s.afterAdd.trigger) {
    if (s.afterAdd.latest) s.latest[s.afterAdd.pkg] = s.afterAdd.latest;
    if (s.afterAdd.failView) s.failViewLatest = [s.afterAdd.pkg];
    delete s.afterAdd;
  }
  persist(s);
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
    if (process.env.FAKE_NPM_RELEASE_FILE) {
      while (!fs.existsSync(process.env.FAKE_NPM_RELEASE_FILE) && Date.now() - t0 < 15000) { /* hold */ }
    } else {
      while (Date.now() - t0 < 1200) { /* hold */ }
    }
  }
  if (willStall) {
    if (process.env.FAKE_NPM_PIDFILE) fs.writeFileSync(process.env.FAKE_NPM_PIDFILE, String(process.pid));
    const sigLog = process.env.FAKE_NPM_SIGNAL_LOG || '';
    const logSignal = (name) => { if (sigLog) fs.appendFileSync(sigLog, name + '\n'); };
    if (process.env.FAKE_NPM_TERM_GRACE_EXIT === '1') {
      // Exit cleanly on TERM, after a short pause the test can observe, so a
      // KILL sent without waiting for the grace leaves no TERM-EXIT line.
      process.on('SIGTERM', () => {
        logSignal('TERM');
        setTimeout(() => { logSignal('TERM-EXIT'); process.exit(0); }, 300);
      });
      setTimeout(() => { process.stdout.write('+latest: stalled add completed\n'); }, 10000);
    } else {
      process.on('SIGTERM', () => {});
      setTimeout(() => { process.stdout.write('+latest: stalled add completed\n'); }, 3500);
    }
    return;
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
#!/bin/bash
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
function withoutFinalRead(source) {
  const start = source.indexOf('# Re-read every package, including ones that were already at the target before');
  const end = source.indexOf('# ── 6. select the result branch', start);
  if (start < 0 || end < 0) { console.error('final-read mutation target not found'); process.exit(3); }
  return source.slice(0, start) + source.slice(end);
}
const targets = {
  existence: ['  } >&2\n  exit "$EXIT_REFUSED"\n', '  } >&2\n  : # MUTATED: existence check disabled\n'],
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
    '  in_flight_op=promote\n',
    '  in_flight_op=""\n',
  ],
  capture: [
    '  run_npm dist-tag add "${names[i]}@${version}" latest --registry "$NPM_REGISTRY"\n',
    '  out="$(run_npm dist-tag add "${names[i]}@${version}" latest --registry "$NPM_REGISTRY" 2>&1)"\n',
  ],
  dispatch_early: [
    '  if [ "$rc" -eq 124 ]; then\n',
    '  if [ "$i" -eq $((NPKG - 1)) ]; then dispatch_docker; fi\n  if [ "$rc" -eq 124 ]; then\n',
  ],
  dispatch_rollback: [
    '  exit "$EXIT_DISPATCH_FAILED"\n',
    '  rollback_moved\n  exit "$EXIT_DISPATCH_FAILED"\n',
  ],
  uncertain_restored: [
    '    elif [ "${uncertain[i]}" -eq 1 ]; then\n',
    '    elif false; then\n',
  ],
  drop_stdin: [
    '  "$NODE_BIN" "$supervisor" "$NPM_TIMEOUT_SECONDS" "$NPM_TERM_GRACE_SECONDS" -- "$NPM_BIN" "$@" <&0 &\n',
    '  "$NODE_BIN" "$supervisor" "$NPM_TIMEOUT_SECONDS" "$NPM_TERM_GRACE_SECONDS" -- "$NPM_BIN" "$@" &\n',
  ],
};
if (which === 'final_read') {
  fs.writeFileSync(dst, withoutFinalRead(s));
  process.exit(0);
}
if (which === 'release_uncertain_lock') {
  fs.writeFileSync(dst, s.replaceAll('keep_lock=1', 'keep_lock=0'));
  process.exit(0);
}
if (which === 'keep_lock_after_reason') {
  const onSig = '    keep_lock=1\n    write_reconciliation_reason || :\n';
  const main = '  keep_lock=1\n  write_reconciliation_reason || :\n';
  if (!s.includes(onSig) || !s.includes(main)) {
    console.error('keep_lock mutation target not found');
    process.exit(3);
  }
  let out = s.replace(onSig, '    write_reconciliation_reason\n    keep_lock=1\n');
  out = out.replace(main, '  write_reconciliation_reason\n  keep_lock=1\n');
  out = out.replace('mark_uncertain() {\n  keep_lock=1\n', 'mark_uncertain() {\n');
  fs.writeFileSync(dst, out);
  process.exit(0);
}
if (which === 'drop_rollback_failures') {
  const start = "  if [ \"${#rollback_failed_pkgs[@]}\" -gt 0 ]; then\n";
  const end = "  fi\n  printf '\\nReconcile by hand, after the registry has settled:\\n'\n";
  const a = s.indexOf(start);
  const b = s.indexOf(end, a);
  if (a < 0 || b < 0) {
    console.error('rollback-failure mutation target not found');
    process.exit(3);
  }
  fs.writeFileSync(dst, s.slice(0, a) + s.slice(b));
  process.exit(0);
}
const t = targets[which];
if (!t) { console.error('unknown mutation: ' + which); process.exit(2); }
if (!s.includes(t[0])) { console.error('mutation target not found: ' + which); process.exit(3); }
let out = s.replace(t[0], t[1]);
if (which === 'verify') out = withoutFinalRead(out);
if (which === 'dispatch_early') {
  const finalDispatch = '  dispatch_docker\n  exit 0\n';
  if (!out.includes(finalDispatch)) { console.error('final dispatch mutation target not found'); process.exit(3); }
  out = out.replace(finalDispatch, '  exit 0\n');
}
fs.writeFileSync(dst, out);
MUT

# mutate-supervisor.mjs — break npm-supervisor.mjs so the fixtures must catch it.
cat >"$work/mutate-supervisor.mjs" <<'MUTSUP'
import fs from 'fs';
const [src, dst, which] = process.argv.slice(2);
const s = fs.readFileSync(src, 'utf8');

if (which === 'kill_unchecked') {
  const sendOld = `function send(signal) {
  if (gone()) return false;
  try {`;
  const sendNew = `function send(signal) {
  try {`;
  const graceOld = `  graceTimer = setTimeout(() => {
    graceDone = true;
    if (!gone()) send('SIGKILL');`;
  const graceNew = `  graceTimer = setTimeout(() => {
    graceDone = true;
    send('SIGKILL');`;
  if (!s.includes(sendOld) || !s.includes(graceOld)) {
    console.error('supervisor kill mutation target not found');
    process.exit(3);
  }
  fs.writeFileSync(dst, s.replace(sendOld, sendNew).replace(graceOld, graceNew));
  process.exit(0);
}

if (which === 'count_sleeps') {
  const start = 'deadlineTimer = setTimeout(() => {';
  const end = '}, Math.round(deadlineSeconds * 1000));';
  const a = s.indexOf(start);
  const b = s.indexOf(end, a);
  if (a < 0 || b < 0) {
    console.error('supervisor sleeps mutation target not found');
    process.exit(3);
  }
  const replacement = `const startupMs = Number(process.env.PROMOTE_MUTANT_STARTUP_MS || 0);
// MUTANT: counts fixed 200 ms sleeps after an assumed startup delay instead of
// using the timer set after spawn.
setTimeout(() => {
  let counted = 0;
  const step = () => {
    if (gone()) return;
    if (counted * 200 >= Math.round(deadlineSeconds * 1000)) {
      timedOut = true;
      send('SIGTERM');
      graceTimer = setTimeout(() => {
        graceDone = true;
        if (gone()) return;
        send('SIGKILL');
      }, Math.round(graceSeconds * 1000));
      return;
    }
    counted += 1;
    setTimeout(step, 200);
  };
  step();
}, startupMs);`;
  fs.writeFileSync(dst, s.slice(0, a) + replacement + s.slice(b + end.length));
  process.exit(0);
}

if (which === 'drop_end_on_error') {
  const old = `child.on('error', (err) => {
  clearTimeout(deadlineTimer);
  logEnd();`;
  const neu = `child.on('error', (err) => {
  clearTimeout(deadlineTimer);`;
  if (!s.includes(old)) {
    console.error('supervisor error-path end mutation target not found');
    process.exit(3);
  }
  fs.writeFileSync(dst, s.replace(old, neu));
  process.exit(0);
}

if (which === 'skip_end_on_timeout') {
  const old = `function exitWithStatus() {
  if (!exitInfo) return;
  logEnd();`;
  const neu = `function exitWithStatus() {
  if (!exitInfo) return;
  if (!timedOut) logEnd();`;
  if (!s.includes(old)) {
    console.error('supervisor end-log mutation target not found');
    process.exit(3);
  }
  fs.writeFileSync(dst, s.replace(old, neu));
  process.exit(0);
}

console.error('unknown supervisor mutation: ' + which);
process.exit(2);
MUTSUP

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
  : >"$d/supervisor.log"
  raw="$(PROMOTE_SUPERVISOR_LOG="$d/supervisor.log" FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="${NPM_BIN_OVERRIDE:-$fake_npm}" \
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
  : >"$d/supervisor.log"
  raw="$(printf '%s\n' "$reply" | PROMOTE_SUPERVISOR_LOG="$d/supervisor.log" FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="${NPM_BIN_OVERRIDE:-$fake_npm}" \
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
  : >"$d/supervisor.log"
  # shellcheck disable=SC2016  # "$@" is expanded by the inner bash, not here
  raw="$(PROMOTE_SUPERVISOR_LOG="$d/supervisor.log" FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="${NPM_BIN_OVERRIDE:-$fake_npm}" \
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
  : >"$d/supervisor.log"
  local hv="$holdver"
  [ "$holdver" = "-" ] && hv=""
  PROMOTE_SUPERVISOR_LOG="$d/supervisor.log" FAKE_NPM_STATE="$d/state.json" FAKE_NPM_LOG="$LOG" PROMOTE_ROOT="$d/root" NPM_BIN="${NPM_BIN_OVERRIDE:-$fake_npm}" \
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
assert_eq "E move-all: lock released" no "$(if [ -e "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"
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
assert_eq "G noop-rollback: lock released" no "$(if [ -e "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"
assert_contains "G noop-rollback: reports the rollback" "$ERR" "attempting rollback"
assert_contains "G noop-rollback: final table flags NO" "$OUT" "NO"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "G noop-rollback: registry restored" "latest=0.5.3 for all six"; else bad "G noop-rollback: registry restored" "a partial promote was left behind"; fi

# ── J. no VERSION → default comes from packages/cli/package.json ──────────────
d="$(new_fixture default-version)"
write_state "$d/state.json" "0.5.4" "0.5.4"
invoke "$d" --dry-run
assert_eq "J default-version: exit" 0 "$RC"
assert_contains "J default-version: used package.json version" "$OUT" 'Promoting the "latest" dist-tag to 0.5.4'

# ── K. SIGTERM during an add keeps the lock and names the write ──────────────
d="$(new_fixture interrupt)"
write_state "$d/state.json" "0.5.4" "0.5.3"
run_interrupt "$d" "cli-linux-arm64" "0.5.4" TERM 0.5.4 --yes
assert_eq "K interrupt: exit" 7 "$IRC"
assert_contains "K interrupt: names the signal" "$ERR" "SIGTERM"
assert_eq "K interrupt: lock kept" yes "$(if [ -d "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"
assert_contains "K interrupt: reason names write" "$(cat "$d/root/.promote-latest.lock/reason" 2>/dev/null)" "promote to 0.5.4"
invoke "$d" 0.5.4 --yes --no-docker
assert_eq "K interrupt: second run refuses" 2 "$RC"
assert_contains "K interrupt: second refusal names write" "$ERR" "promote to 0.5.4"

# ── O. a signal DURING the failure-path rollback must not strand a partial ────
# Drive a failing move (a noop add for the CLI) so the failure branch is taken,
# and hold the rollback of the in-flight platform package. The signal lands while
# rollback_moved is running. A script that clears its traps before this branch is
# killed mid-rollback and strands a partial promote — this fixture is its control.
d="$(new_fixture interrupt-rollback)"
write_state "$d/state.json" "0.5.4" "0.5.3" "cli"
run_interrupt "$d" "cli-linux-arm64" "0.5.3" TERM 0.5.4 --yes
assert_eq "O interrupt-during-rollback: exit" 4 "$IRC"
assert_contains "O interrupt-during-rollback: reports rollback" "$ERR" "attempting rollback"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "O interrupt-during-rollback: restored" "latest=0.5.3 for all six"; else bad "O interrupt-during-rollback: restored" "a partial promote was stranded"; fi

# ── P. a second TERM during the handler's rollback is ignored ────────────────
# Signal #1 lands while NO write is in flight: the fake npm stalls the post-add
# read, and the tool waits for that `view`. The handler ignores further signals
# and starts the rollback; signal #2 lands while the rollback's `dist-tag add` is
# held. The rollback must finish, the registry must be restored and the lock
# released (exit 4), not abandoned or turned into an uncertain run (exit 7).
d="$(new_fixture interrupt-two-signals)"
write_state "$d/state.json" "0.5.4" "0.5.3"
node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallViewAfterAdd="@tpsdev-ai/cli-darwin-arm64"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
FAKE_NPM_STALL_VIEW_MS=2000 FAKE_NPM_PIDFILE="$d/view.pid" FAKE_NPM_RELEASE_FILE="$d/release" \
  start_held "$d" cli-darwin-arm64 0.5.3 0.5.4 --yes --no-docker
for ((tries = 0; tries < 200; tries++)); do
  [ -s "$d/view.pid" ] && break
  sleep 0.05
done
assert_eq "P two-signal: post-add read held" yes "$(if [ -s "$d/view.pid" ]; then echo yes; else echo no; fi)"
signal_tool "$d" TERM
if wait_count "$HCOUNTER" 1; then
  signal_tool "$d" TERM
else
  bad "P two-signal: rollback write held" "no hold marker before the timeout"
fi
: >"$d/release"
finish_held "$d"
assert_eq "P two-signal: exit" 4 "$IRC"
assert_contains "P two-signal: reports rollback" "$ERR" "attempting rollback"
if printf '%s' "$ERR" | grep -qF 'UNCERTAIN'; then
  bad "P two-signal: second signal ignored" "the second signal turned the rollback into an uncertain run"
else
  ok "P two-signal: second signal ignored" "the rollback ran to completion"
fi
assert_eq "P two-signal: lock released" no "$(if [ -e "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "P two-signal: registry restored" "latest=0.5.3 for all six"; else bad "P two-signal: registry restored" "a partial promote was left behind"; fi

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

d="$(new_fixture prerelease-build)"
write_state "$d/state.json" "1.2.3-rc.1+build-abc" "1.2.2"
invoke "$d" 1.2.3-rc.1+build-abc --yes
assert_eq "Q prerelease-build: acknowledgement" 3 "$RC"
assert_contains "Q prerelease-build: classified" "$ERR" "PRE-RELEASE"
assert_eq "Q prerelease-build: no adds" 0 "$(adds_count)"
invoke "$d" 1.2.3-rc.1+build-abc --yes --allow-downgrade
assert_eq "Q prerelease-build: exit" 0 "$RC"
assert_eq "Q prerelease-build: six adds" 6 "$(adds_count)"
if all_latest_eq "$d/state.json" "1.2.3-rc.1+build-abc"; then ok "Q prerelease-build: registry" ""; else bad "Q prerelease-build: registry" "wrong latest"; fi

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

# ── Y. the last add exits 0 without landing: no early dispatch ────────────────
d="$(new_fixture last-add-noop)"
write_state "$d/state.json" "0.5.4" "0.5.3" "cli"
invoke "$d" 0.5.4 --yes
assert_eq "Y last-add-noop: exit" 4 "$RC"
assert_eq "Y last-add-noop: gh never called" 0 "$(gh_calls "$d")"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "Y last-add-noop: rolled back" "latest=0.5.3 for all six"; else bad "Y last-add-noop: rolled back" "a partial promote was left behind"; fi

# ── Z. a tag initially at target drifts during the last add ───────────────────
d="$(new_fixture initially-current-drifts)"
write_state "$d/state.json" "0.5.4" "0.5.3"
node - "$d/state.json" <<'DRIFT'
const fs = require('fs');
const path = process.argv[2];
const s = JSON.parse(fs.readFileSync(path, 'utf8'));
s.latest['@tpsdev-ai/cli-darwin-arm64'] = '0.5.4';
s.afterAdd = { trigger: '@tpsdev-ai/cli', pkg: '@tpsdev-ai/cli-darwin-arm64', latest: '0.5.3' };
fs.writeFileSync(path, JSON.stringify(s));
DRIFT
invoke "$d" 0.5.4 --yes
assert_eq "Z initially-current-drift: exit" 4 "$RC"
assert_eq "Z initially-current-drift: gh never called" 0 "$(gh_calls "$d")"
assert_contains "Z initially-current-drift: named" "$ERR" "final registry check failed for @tpsdev-ai/cli-darwin-arm64"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "Z initially-current-drift: moved tags rolled back" "latest=0.5.3 for all six"; else bad "Z initially-current-drift: moved tags rolled back" "a partial promote was left behind"; fi

# ── AA. the final read of an initially current tag fails ──────────────────────
d="$(new_fixture initially-current-unreadable)"
write_state "$d/state.json" "0.5.4" "0.5.3"
node - "$d/state.json" <<'UNREADABLE'
const fs = require('fs');
const path = process.argv[2];
const s = JSON.parse(fs.readFileSync(path, 'utf8'));
s.latest['@tpsdev-ai/cli-darwin-arm64'] = '0.5.4';
s.afterAdd = { trigger: '@tpsdev-ai/cli', pkg: '@tpsdev-ai/cli-darwin-arm64', failView: true };
fs.writeFileSync(path, JSON.stringify(s));
UNREADABLE
invoke "$d" 0.5.4 --yes
assert_eq "AA final-read-unreadable: exit" 4 "$RC"
assert_eq "AA final-read-unreadable: gh never called" 0 "$(gh_calls "$d")"
assert_contains "AA final-read-unreadable: named" "$ERR" "final registry check failed for @tpsdev-ai/cli-darwin-arm64"
assert_eq "AA final-read-unreadable: moved tags rolled back" "0.5.3" "$(state_latest "$d/state.json" "@tpsdev-ai/cli")"

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
assert_contains "W dispatch-fail: status unconfirmed" "$ERR" "Docker image dispatch could not be confirmed"
assert_contains "W dispatch-fail: prints the command" "$ERR" "gh workflow run docker.yml --repo tpsdev-ai/cli -f version=0.5.4"
if all_latest_eq "$d/state.json" "0.5.4"; then ok "W dispatch-fail: no rollback" "latest=0.5.4 for all six"; else bad "W dispatch-fail: no rollback" "the promote was rolled back"; fi
GH_STUB_FAIL=""

# ── X. gh missing: same distinct exit and message, no rollback ────────────────
d="$(new_fixture gh-missing)"
write_state "$d/state.json" "0.5.4" "0.5.3"
GH_BIN_OVERRIDE="$work/no-such-gh" invoke "$d" 0.5.4 --yes
assert_eq "X gh-missing: exit" 6 "$RC"
assert_contains "X gh-missing: status unconfirmed" "$ERR" "Docker image dispatch could not be confirmed"
assert_contains "X gh-missing: names the missing binary" "$ERR" "gh not found"
if all_latest_eq "$d/state.json" "0.5.4"; then ok "X gh-missing: no rollback" "latest=0.5.4 for all six"; else bad "X gh-missing: no rollback" "the promote was rolled back"; fi
GH_BIN_OVERRIDE=""

d="$(new_fixture lock-held)"
write_state "$d/state.json" "0.5.4" "0.5.3"
FAKE_NPM_RELEASE_FILE="$d/release" start_held "$d" cli-linux-arm64 0.5.4 0.5.4 --yes --no-docker
wait_count "$HCOUNTER" 1 || bad "AB first run held" "no marker"
first_pid="$(cat "$d/tool.pid")"
second="$(new_fixture lock-second)"
rm -rf "$second/root"
ln -s "$d/root" "$second/root"
cp "$d/state.json" "$second/state.json"
invoke "$second" 0.5.4 --yes --no-docker
assert_eq "AB held lock: refuses" 2 "$RC"
assert_eq "AB held lock: no moves" 0 "$(adds_count)"
assert_contains "AB held lock: path" "$ERR" "$second/root/.promote-latest.lock"
assert_contains "AB held lock: PID" "$ERR" "PID $first_pid"
assert_contains "AB held lock: remedy" "$ERR" "if that PID is not running"
assert_eq "AB first lock retained" "$first_pid" "$(cat "$d/root/.promote-latest.lock/pid" 2>/dev/null)"
: >"$d/release"
finish_held "$d"
assert_eq "AB first run completes" 0 "$IRC"

d="$(new_fixture lock-int)"
write_state "$d/state.json" "0.5.4" "0.5.3"
run_interrupt "$d" cli-linux-arm64 0.5.4 INT 0.5.4 --yes --no-docker
assert_eq "AC INT: exit" 7 "$IRC"
assert_contains "AC INT: signal" "$ERR" "SIGINT"
assert_eq "AC INT: lock kept" yes "$(if [ -d "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"

# ── AD. a timed-out mutating call is UNCERTAIN: lock kept, no "restored" ──────
# The fake applies the new tag and then stalls past the bound. The registry may
# still apply such a write after the client is killed, so the run cannot print a
# restored value; it exits 7 and leaves the lock with a reason file.
d="$(new_fixture timeout-committed)"
write_state "$d/state.json" "0.5.4" "0.5.3"
node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
NPM_TIMEOUT_SECONDS=1 FAKE_NPM_PIDFILE="$d/npm.pid" invoke "$d" 0.5.4 --yes --no-docker
assert_eq "AD add-timeout (committed): exit" 7 "$RC"
assert_contains "AD add-timeout: command and bound" "$ERR" "timed out after 1 seconds: npm dist-tag add @tpsdev-ai/cli-linux-arm64@0.5.4"
assert_contains "AD add-timeout: reports uncertainty" "$ERR" "UNCERTAIN"
if printf '%s' "$ERR" | grep -qF 'rolled back @tpsdev-ai/cli-linux-arm64'; then
  bad "AD add-timeout: no restored line" "printed a rollback for the uncertain package"
else
  ok "AD add-timeout: no restored line" "the uncertain package is not called restored"
fi
assert_eq "AD add-timeout: lock kept" yes "$(if [ -d "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"
assert_eq "AD add-timeout: lock still has its pid" yes "$(if [ -f "$d/root/.promote-latest.lock/pid" ]; then echo yes; else echo no; fi)"
assert_contains "AD add-timeout: reason names the package" "$(cat "$d/root/.promote-latest.lock/reason" 2>/dev/null)" "@tpsdev-ai/cli-linux-arm64: target 0.5.4, previous latest 0.5.3"
assert_contains "AD add-timeout: reason has the reconciliation step" "$(cat "$d/root/.promote-latest.lock/reason" 2>/dev/null)" "npm view <package> dist-tags"
if [ -s "$d/npm.pid" ]; then
  if kill -0 "$(cat "$d/npm.pid")" 2>/dev/null; then bad "AD add-timeout: process gone" "npm still running"; else ok "AD add-timeout: process gone" "npm is gone"; fi
else
  bad "AD add-timeout: PID recorded" "$d/npm.pid is empty"
fi
# A later run must refuse and print the reason rather than move anything.
invoke "$d" 0.5.4 --yes --no-docker
assert_eq "AD add-timeout: second run refuses" 2 "$RC"
assert_contains "AD add-timeout: refusal prints the reason" "$ERR" "target 0.5.4, previous latest 0.5.3"
assert_eq "AD add-timeout: second run has no adds" 0 "$(adds_count)"

# ── AE. a stalled add that never applied the tag is uncertain too ────────────
d="$(new_fixture timeout-uncommitted)"
write_state "$d/state.json" "0.5.4" "0.5.3"
node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; s.stallNoCommit=true; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
NPM_TIMEOUT_SECONDS=1 invoke "$d" 0.5.4 --yes --no-docker
assert_eq "AE add-timeout (uncommitted): exit" 7 "$RC"
assert_contains "AE add-timeout: reports uncertainty" "$ERR" "UNCERTAIN"
if printf '%s' "$ERR" | grep -qF 'rolled back @tpsdev-ai/cli-linux-arm64'; then
  bad "AE add-timeout: no restored line" "printed a rollback for the uncertain package"
else
  ok "AE add-timeout: no restored line" "the uncertain package is not called restored"
fi
assert_eq "AE add-timeout: lock kept" yes "$(if [ -d "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"
assert_eq "AE add-timeout: lock still has its pid" yes "$(if [ -f "$d/root/.promote-latest.lock/pid" ]; then echo yes; else echo no; fi)"
assert_contains "AE add-timeout: reason present" "$(cat "$d/root/.promote-latest.lock/reason" 2>/dev/null)" "@tpsdev-ai/cli-linux-arm64: target 0.5.4, previous latest 0.5.3"

# ── AF. a timed-out READ stays on the ordinary failure path ──────────────────
d="$(new_fixture timeout-read)"
write_state "$d/state.json" "0.5.4" "0.5.3"
node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallViewAfterAdd="@tpsdev-ai/cli-linux-arm64"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
NPM_TIMEOUT_SECONDS=1 invoke "$d" 0.5.4 --yes --no-docker
assert_eq "AF read-timeout: exit" 4 "$RC"
# The timed-out read is captured into the failure report, whose whitespace trim
# removes the spaces; match that shape.
assert_contains "AF read-timeout: command and bound" "$ERR" "npmcommandtimedoutafter1seconds"
if printf '%s' "$ERR" | grep -qF 'UNCERTAIN'; then bad "AF read-timeout: not uncertain" "a read timeout was treated as uncertain"; else ok "AF read-timeout: not uncertain" "stayed on the failure path"; fi
assert_eq "AF read-timeout: lock released" no "$(if [ -e "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"
if all_latest_eq "$d/state.json" "0.5.3"; then ok "AF read-timeout: restored" ""; else bad "AF read-timeout: restored" "partial promote"; fi

# ── AG. npm exits during the TERM grace; no KILL is sent ─────────────────────
# The fake logs TERM and then TERM-EXIT from its own handler. A kill that does
# not wait for the grace leaves no TERM-EXIT line.
d="$(new_fixture term-grace)"
write_state "$d/state.json" "0.5.4" "0.5.3"
node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
NPM_TIMEOUT_SECONDS=1 FAKE_NPM_PIDFILE="$d/npm.pid" FAKE_NPM_SIGNAL_LOG="$d/signals" FAKE_NPM_TERM_GRACE_EXIT=1 invoke "$d" 0.5.4 --yes --no-docker
assert_eq "AG term-grace: exit" 7 "$RC"
assert_contains "AG term-grace: TERM received" "$(cat "$d/signals" 2>/dev/null)" "TERM"
assert_contains "AG term-grace: handler finished inside the grace" "$(cat "$d/signals" 2>/dev/null)" "TERM-EXIT"
# The supervisor's own log is what it sent: TERM at the deadline, no KILL once
# the child has exited during the grace.
assert_contains "AG term-grace: supervisor attempted TERM" "$(cat "$d/supervisor.log" 2>/dev/null)" "TERM"
assert_eq "AG term-grace: supervisor attempted no KILL" 0 "$(grep -c '^KILL$' "$d/supervisor.log" 2>/dev/null || true)"
if [ -s "$d/npm.pid" ]; then
  if kill -0 "$(cat "$d/npm.pid")" 2>/dev/null; then bad "AG term-grace: process gone" "npm still running"; else ok "AG term-grace: process gone" "npm is gone"; fi
else
  bad "AG term-grace: PID recorded" "$d/npm.pid is empty"
fi

# ── AH. the pid file is not written yet: the refusal says unknown ────────────
d="$(new_fixture lock-no-pid)"
write_state "$d/state.json" "0.5.4" "0.5.3"
mkdir -p "$d/root/.promote-latest.lock"
invoke "$d" 0.5.4 --yes --no-docker
assert_eq "AH lock-without-pid: exit" 2 "$RC"
assert_contains "AH lock-without-pid: says unknown" "$ERR" "(PID unknown)"
assert_eq "AH lock-without-pid: no adds" 0 "$(adds_count)"

# ── AI/AJ. the REAL npm CLI against a local registry (the 2FA seam) ──────────
real_ready=1
for real_bin in npm node python3; do
  command -v "$real_bin" >/dev/null 2>&1 || real_ready=0
done
if [ "$real_ready" -ne 1 ]; then
  if [ "${TPS_TEST_REQUIRE_REAL_NPM:-0}" = "1" ]; then
    bad "AI real npm: prerequisites" "TPS_TEST_REQUIRE_REAL_NPM=1 but npm, node or python3 is missing"
  else
    printf 'SKIP  %-42s npm, node or python3 not installed\n' "AI/AJ real npm seam"
  fi
else
  npm_bin="$(command -v npm)"

  # AI. The first PUT gets npm's one-time-password challenge; the retry must
  # carry the typed code in the npm-otp header, and the tag must move.
  d="$(new_fixture real-npm-otp)"
  if OTP_CODE=246813 start_registry "$d" otp; then
    mkdir -p "$d/home" "$d/npm-cache"
    raw="$(HOME="$d/home" npm_config_cache="$d/npm-cache" npm_config_userconfig="$d/home/npmrc" \
      npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm_config_progress=false \
      NPM_BIN="$npm_bin" NPM_REGISTRY="http://127.0.0.1:$REG_PORT" PROMOTE_ROOT="$d/root" OTP_CODE=246813 \
      python3 "$real_pty_runner" "$BASH_BIN" "$tool" 0.5.4 --yes --no-docker)"
    RC=$?
    OUT="$(printf '%s\n' "$raw" | strip_cr)"
    ERR="$OUT"
    assert_eq "AI real npm OTP: exit" 0 "$RC"
    assert_contains "AI real npm OTP: the tag moved" "$OUT" "+latest: @tpsdev-ai/cli@0.5.4"
    moved_real=1
    for p in "${six_dirs[@]}"; do
      if ! node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit(s.latest[process.argv[2]] === "0.5.4" ? 0 : 1)' "$d/registry.state" "@tpsdev-ai/$p"; then moved_real=0; fi
    done
    assert_eq "AI real npm OTP: server state moved for all six" 1 "$moved_real"
    assert_contains "AI real npm OTP: challenge was served" "$raw" "one-time password"
    assert_contains "AI real npm OTP: retry carried the typed code" "$(cat "$d/registry.state" 2>/dev/null)" '"otp": "246813"'
  else
    bad "AI real npm OTP: registry started" "no port file"
  fi
  stop_registry

  # AJ. The server never answers a PUT: the mutating call times out, so the run
  # is uncertain (7), not an ordinary failure.
  d="$(new_fixture real-npm-hang)"
  if start_registry "$d" hang-put; then
    mkdir -p "$d/home" "$d/npm-cache"
    raw="$(HOME="$d/home" npm_config_cache="$d/npm-cache" npm_config_userconfig="$d/home/npmrc" \
      npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm_config_progress=false \
      NPM_TIMEOUT_SECONDS=1 NPM_BIN="$npm_bin" NPM_REGISTRY="http://127.0.0.1:$REG_PORT" PROMOTE_ROOT="$d/root" \
      python3 "$real_pty_runner" "$BASH_BIN" "$tool" 0.5.4 --yes --no-docker)"
    RC=$?
    OUT="$(printf '%s\n' "$raw" | strip_cr)"
    ERR="$OUT"
    assert_eq "AJ real npm PUT hang: exit" 7 "$RC"
    assert_contains "AJ real npm PUT hang: timed out" "$ERR" "timed out after 1 seconds: npm dist-tag add @tpsdev-ai/cli-darwin-arm64@0.5.4"
    assert_contains "AJ real npm PUT hang: reports uncertainty" "$ERR" "UNCERTAIN"
    if printf '%s' "$ERR" | grep -qF 'rolled back @tpsdev-ai/cli-darwin-arm64'; then
      bad "AJ real npm PUT hang: no restored line" "printed a rollback for the uncertain package"
    else
      ok "AJ real npm PUT hang: no restored line" "the uncertain package is not called restored"
    fi
    assert_eq "AJ real npm PUT hang: lock kept" yes "$(if [ -d "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"
    assert_contains "AJ real npm PUT hang: reason present" "$(cat "$d/root/.promote-latest.lock/reason" 2>/dev/null)" "@tpsdev-ai/cli-darwin-arm64: target 0.5.4, previous latest 0.5.3"
  else
    bad "AJ real npm PUT hang: registry started" "no port file"
  fi
  stop_registry

  # AS. TERM while real npm has a PUT pending keeps the lock and records it.
  d="$(new_fixture real-npm-signal)"
  if start_registry "$d" delayed-put; then
    mkdir -p "$d/home" "$d/npm-cache"
    HOME="$d/home" npm_config_cache="$d/npm-cache" npm_config_userconfig="$d/home/npmrc" \
      npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm_config_progress=false \
      NPM_TIMEOUT_SECONDS=5 NPM_BIN="$npm_bin" NPM_REGISTRY="http://127.0.0.1:$REG_PORT" PROMOTE_ROOT="$d/root" \
      PTY_PIDFILE="$d/tool.pid" python3 "$real_pty_runner" "$BASH_BIN" "$tool" 0.5.4 --yes --no-docker >"$d/out.txt" 2>&1 &
    real_signal_pid=$!
    saw_put=0
    for ((tries = 0; tries < 200; tries++)); do
      if node -e 'const fs=require("fs"); try {const s=JSON.parse(fs.readFileSync(process.argv[1])); process.exit(s.requests.some((r)=>r.method==="PUT")?0:1)} catch {process.exit(1)}' "$d/registry.state"; then saw_put=1; break; fi
      sleep 0.05
    done
    assert_eq "AS real npm signal: PUT reached registry" 1 "$saw_put"
    if [ "$saw_put" -eq 1 ]; then signal_tool "$d" TERM || :; fi
    wait "$real_signal_pid" 2>/dev/null
    real_signal_rc=$?
    assert_eq "AS real npm signal: exit" 7 "$real_signal_rc"
    assert_eq "AS real npm signal: lock kept" yes "$(if [ -d "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"
    assert_contains "AS real npm signal: reason names write" "$(cat "$d/root/.promote-latest.lock/reason" 2>/dev/null)" "promote to 0.5.4"
    assert_contains "AS real npm signal: signal reported" "$(cat "$d/out.txt")" "SIGTERM"
    invoke "$d" 0.5.4 --yes --no-docker
    assert_eq "AS real npm signal: second run refuses" 2 "$RC"
    assert_contains "AS real npm signal: refusal includes reason" "$ERR" "promote to 0.5.4"
  else
    bad "AS real npm signal: registry started" "no port file"
  fi
  stop_registry
fi

# ── AL. the supervisor's bound: a TERM-ignoring child is KILLed after the grace ─
# The fake npm's default stalled add ignores TERM and would finish on its own
# after 3.5 s. The supervised call must end within the deadline (1 s) plus the
# grace (2 s); the margin below is 5 s. The supervisor's own log records TERM,
# KILL, and the start/end of each supervised call, so this bound times the
# stalled call itself; the other calls and the rollback in the same promotion
# do not count toward a bound that is about one call.
d="$(new_fixture supervisor-bound)"
write_state "$d/state.json" "0.5.4" "0.5.3"
node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
NPM_TIMEOUT_SECONDS=1 invoke "$d" 0.5.4 --yes --no-docker
assert_eq "AL bound: exit" 7 "$RC"
assert_contains "AL bound: supervisor attempted TERM" "$(cat "$d/supervisor.log" 2>/dev/null)" "TERM"
assert_contains "AL bound: supervisor attempted KILL" "$(cat "$d/supervisor.log" 2>/dev/null)" "KILL"
# Calls run one at a time, and the log is read with strict per-call framing, so
# the signalled call's own start and end bracket its duration.
elapsed="$(node "$supervisor_log_parser" "$d/supervisor.log" 2>"$d/parse.err" || true)"
if [ -z "$elapsed" ]; then
  bad "AL bound: at least deadline + grace" "no signalled call's start/end pair ($(head -n 1 "$d/parse.err" 2>/dev/null))"
  bad "AL bound: inside deadline + grace + 5s" "no signalled call's start/end pair"
elif node -e 'process.exit(Number(process.argv[1]) >= 2.5 ? 0 : 1)' "$elapsed"; then
  ok "AL bound: at least deadline + grace" "${elapsed}s"
else
  bad "AL bound: at least deadline + grace" "${elapsed}s — below the 1 s deadline + 2 s grace"
fi
if [ -n "$elapsed" ]; then
  if node -e 'process.exit(Number(process.argv[1]) < 8 ? 0 : 1)' "$elapsed"; then
    ok "AL bound: inside deadline + grace + 5s" "${elapsed}s"
  else
    bad "AL bound: inside deadline + grace + 5s" "${elapsed}s"
  fi
fi

# ── AM. an unwritable reason file: the lock is kept, exit 7, one error ───────
# The lock directory exists while the add is held; a directory placed at
# `<lock>/reason` makes the redirect fail for every uid, root included.
d="$(new_fixture reason-write-fails)"
write_state "$d/state.json" "0.5.4" "0.5.3"
node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
FAKE_NPM_RELEASE_FILE="$d/release" NPM_TIMEOUT_SECONDS=1 start_held "$d" cli-linux-arm64 0.5.4 0.5.4 --yes --no-docker
if wait_count "$HCOUNTER" 1; then
  mkdir "$d/root/.promote-latest.lock/reason"
  : >"$d/release"
  finish_held "$d"
  assert_eq "AM reason-write: exit" 7 "$IRC"
  assert_eq "AM reason-write: lock kept" yes "$(if [ -d "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"
  assert_contains "AM reason-write: names the lock path" "$ERR" "$d/root/.promote-latest.lock/reason"
  assert_eq "AM reason-write: one error line" 1 "$(printf '%s\n' "$ERR" | grep -Fc "$d/root/.promote-latest.lock/reason")"
else
  : >"$d/release"
  finish_held "$d"
  bad "AM reason-write: first add held" "no marker"
fi

# ── AN. a delayed commit lands after the client stopped; next run refuses ────
# The local registry applies the PUT only when the client's connection closes and
# never answers it. The deadline below is well above the ordinary calls in this
# promotion, so only the held PUT reaches it; the client is stopped there and the
# write lands after it. A 1 s deadline also applied to the earlier reads, whose
# own slowness could take the ordinary failure path first.
d="$(new_fixture delayed-commit)"
if [ "$real_ready" -ne 1 ]; then
  printf 'SKIP  %-42s npm, node or python3 not installed\n' "AN delayed-commit"
elif start_registry "$d" delayed-put; then
  mkdir -p "$d/home" "$d/npm-cache"
  raw="$(HOME="$d/home" npm_config_cache="$d/npm-cache" npm_config_userconfig="$d/home/npmrc" \
    npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm_config_progress=false \
    NPM_TIMEOUT_SECONDS=10 NPM_BIN="$npm_bin" NPM_REGISTRY="http://127.0.0.1:$REG_PORT" PROMOTE_ROOT="$d/root" \
    python3 "$real_pty_runner" "$BASH_BIN" "$tool" 0.5.4 --yes --no-docker)"
  RC=$?
  OUT="$(printf '%s\n' "$raw" | strip_cr)"
  ERR="$OUT"
  assert_eq "AN delayed-commit: exit" 7 "$RC"
  assert_eq "AN delayed-commit: lock still has its pid" yes "$(if [ -f "$d/root/.promote-latest.lock/pid" ]; then echo yes; else echo no; fi)"
  assert_contains "AN delayed-commit: reason names the package" "$(cat "$d/root/.promote-latest.lock/reason" 2>/dev/null)" "@tpsdev-ai/cli-darwin-arm64: target 0.5.4"
  sleep 2
  if node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit((s.applied||[]).some((a)=>a.pkg==="@tpsdev-ai/cli-darwin-arm64" && a.version==="0.5.4" && (s.disconnected||[]).some((d)=>d.pkg===a.pkg && d.order<a.order))?0:1)' "$d/registry.state"; then
    ok "AN delayed-commit: the write landed after the client stopped" "disconnect recorded before apply"
  else
    bad "AN delayed-commit: the write landed after the client stopped" "no apply after disconnect recorded"
  fi
  invoke "$d" 0.5.4 --yes --no-docker
  assert_eq "AN delayed-commit: second run refuses" 2 "$RC"
  assert_contains "AN delayed-commit: refusal prints the reason" "$ERR" "target 0.5.4, previous latest 0.5.3"
else
  bad "AN delayed-commit: registry started" "no port file"
fi
stop_registry

# ── AO. an uncertain write on one package and a rollback failure on another ──
d="$(new_fixture mixed-uncertain)"
write_state "$d/state.json" "0.5.4" "0.5.3"
node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; s.rollbackFailPkg="@tpsdev-ai/cli-darwin-arm64"; s.rollbackFailVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
NPM_TIMEOUT_SECONDS=1 invoke "$d" 0.5.4 --yes --no-docker
assert_eq "AO mixed: exit" 7 "$RC"
reason="$(cat "$d/root/.promote-latest.lock/reason" 2>/dev/null)"
assert_contains "AO mixed: reason lists the uncertain write" "$reason" "@tpsdev-ai/cli-linux-arm64: target 0.5.4"
assert_contains "AO mixed: reason lists the rollback failure" "$reason" "@tpsdev-ai/cli-darwin-arm64: rollback to 0.5.3 did not restore it"
assert_contains "AO mixed: printed steps list the uncertain write" "$ERR" "@tpsdev-ai/cli-linux-arm64: target 0.5.4"
assert_contains "AO mixed: printed steps list the rollback failure" "$ERR" "@tpsdev-ai/cli-darwin-arm64: rollback to 0.5.3 did not restore it"
assert_contains "AO mixed: steps say confirm after the registry settled" "$reason" "after the registry has settled"
assert_contains "AO mixed: steps say one read cannot prove the tag" "$reason" "A single read cannot prove"

# ── AP. timeout values are checked before the lock ───────────────────────────
d="$(new_fixture timeout-boundary)"
write_state "$d/state.json" "0.5.4" "0.5.4"
NPM_TIMEOUT_SECONDS=2147483 invoke "$d" 0.5.4 --dry-run
assert_eq "AP maximum timeout: accepted" 0 "$RC"
NPM_TIMEOUT_SECONDS=2147484 invoke "$d" 0.5.4 --dry-run
assert_eq "AP excessive timeout: refused" 1 "$RC"
assert_contains "AP excessive timeout: variable and range" "$ERR" "NPM_TIMEOUT_SECONDS must be in the range 1..2147483 seconds"
assert_eq "AP excessive timeout: no lock" no "$(if [ -e "$d/root/.promote-latest.lock" ]; then echo yes; else echo no; fi)"

# ── AQ. a rollback-only timeout records the version it attempted ────────────
d="$(new_fixture rollback-timeout)"
write_state "$d/state.json" "0.5.4" "0.5.3" "cli"
node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallRollbackPkg="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
NPM_TIMEOUT_SECONDS=1 invoke "$d" 0.5.4 --yes --no-docker
assert_eq "AQ rollback timeout: exit" 7 "$RC"
reason="$(cat "$d/root/.promote-latest.lock/reason" 2>/dev/null)"
assert_contains "AQ rollback timeout: previous version" "$reason" "@tpsdev-ai/cli-linux-arm64: target 0.5.4, previous latest 0.5.3 (rollback to 0.5.3"
assert_eq "AQ rollback timeout: one write" 1 "$(printf '%s\n' "$reason" | grep -c '^  - @tpsdev-ai/cli-linux-arm64:')"

# ── AR. promote and rollback timeouts on one package get separate entries ───
d="$(new_fixture both-timeouts)"
write_state "$d/state.json" "0.5.4" "0.5.3"
node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackPkg=s.stallAdd; s.stallRollbackVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
NPM_TIMEOUT_SECONDS=1 invoke "$d" 0.5.4 --yes --no-docker
assert_eq "AR two timeouts: exit" 7 "$RC"
reason="$(cat "$d/root/.promote-latest.lock/reason" 2>/dev/null)"
assert_contains "AR two timeouts: promote" "$reason" "(promote to 0.5.4"
assert_contains "AR two timeouts: rollback" "$reason" "(rollback to 0.5.3"
assert_eq "AR two timeouts: separate entries" 2 "$(printf '%s\n' "$reason" | grep -c '^  - @tpsdev-ai/cli-linux-arm64:')"

# ── AT. the supervisor logs one start/end pair when the command cannot start ──
# A spawn error ends the call before any exit event, so the end line has to come
# from the error handler; without it the log holds a start with no end.
d="$(new_fixture supervisor-start-failure)"
PROMOTE_SUPERVISOR_LOG="$d/supervisor.log" "${NODE_BIN:-node}" "$here/npm-supervisor.mjs" 5 1 -- "$work/no-such-command" \
  >"$d/out.txt" 2>"$d/err.txt"
rc=$?
assert_eq "AT start-failure: exit" 127 "$rc"
assert_contains "AT start-failure: names the command" "$(cat "$d/err.txt")" "could not start"
assert_eq "AT start-failure: one start line" 1 "$(grep -c '^start [0-9][0-9]*$' "$d/supervisor.log" 2>/dev/null || true)"
assert_eq "AT start-failure: one end line" 1 "$(grep -c '^end [0-9][0-9]*$' "$d/supervisor.log" 2>/dev/null || true)"
assert_eq "AT start-failure: the log holds only that pair" 2 "$(wc -l <"$d/supervisor.log" | tr -d ' ')"

# ── AU..BA. the log parser's rule table: one fixture per rule ────────────────
# One row per rule in supervisor-log.mjs: both anchors on each of its three line
# regexes, the single trailing newline it strips, the empty file, and each of its
# six refusals. Each refusal row carries its own defect in a log that is
# otherwise a complete signalled call, so the parser parses it only when it
# applies that rule; the empty file and the unsignalled call are the rows whose
# log is the defect. Each refusal asserts its own parse.err message, not only an
# exit code; the last row is BA, the valid twin.
parser_rows="$work/parser-rows.txt"
cat >"$parser_rows" <<'PARSER_ROWS'
parser start line: leading token|xstart 100\nTERM\nend 200\nstart 300\nTERM\nend 400\n|1|an unknown line: xstart 100|
parser start line: extra token|start 100 extra\nTERM\nend 200\nstart 300\nTERM\nend 400\n|1|an unknown line: start 100 extra|
parser end line: leading token|start 100\nTERM\nend 200\nstart 300\nTERM\nxend 400\n|1|an unknown line: xend 400|
parser end line: extra token|start 100\nTERM\nend 200\nstart 300\nTERM\nend 400 extra\n|1|an unknown line: end 400 extra|
parser signal line: leading token|start 100\nTERM\nxTERM\nend 200\n|1|an unknown line: xTERM|
parser signal line: extra token|start 100\nTERM\nTERM extra\nend 200\n|1|an unknown line: TERM extra|
parser trailing blank line|start 100\nTERM\nend 200\n\n|1|an unknown line: |
parser empty file||1|no signalled call|
parser no signalled call|start 100\nend 200\n|1|no signalled call|
parser start while a call is open|start 100\nstart 200\nTERM\nend 300\n|1|a start line while a call is open: start 200|
parser end with no open call|end 100\nstart 200\nTERM\nend 300\n|1|an end line with no open call: end 100|
parser signal with no open call|TERM\nstart 200\nTERM\nend 300\n|1|a signal line with no open call: TERM|
parser blank line mid-file|start 100\n\nTERM\nend 200\n|1|an unknown line: |
parser call left open|start 100\nTERM\nend 200\nstart 300\n|1|a call left open at the end of the log|
BA valid signalled call|start 200\nTERM\nend 300\n|0||0.10|
PARSER_ROWS

while IFS='|' read -r parser_label parser_log parser_rc parser_msg parser_elapsed; do
  [ -n "$parser_label" ] || continue
  d="$(new_fixture "parser-${parser_label//[^a-zA-Z0-9]/-}")"
  printf '%b' "$parser_log" >"$d/log.txt"
  rc=0
  node "$supervisor_log_parser" "$d/log.txt" >"$d/elapsed" 2>"$d/parse.err" || rc=$?
  assert_eq "$parser_label: exit" "$parser_rc" "$rc"
  if [ -n "$parser_msg" ]; then
    assert_contains "$parser_label: message" "$(cat "$d/parse.err")" "$parser_msg"
  fi
  if [ -n "$parser_elapsed" ]; then
    assert_eq "$parser_label: elapsed" "$parser_elapsed" "$(cat "$d/elapsed")"
  fi
done <"$parser_rows"

# ── AV. mutation: a timed-out call that logs no end turns AL red ─────────────
# The strict framing rejects the next call's start while the timed-out call is
# still open, so a supervisor that stops logging `end` on that path fails AL
# instead of passing on a duration that spans two calls.
av="$work/mut-skip-end"
mkdir -p "$av"
cp "$tool" "$av/promote-latest.sh"
if node "$work/mutate-supervisor.mjs" "$here/npm-supervisor.mjs" "$av/npm-supervisor.mjs" skip_end_on_timeout; then
  d="$(new_fixture mut-skip-end)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
  NPM_TIMEOUT_SECONDS=1 TOOL="$av/promote-latest.sh" invoke "$d" 0.5.4 --yes --no-docker
  if node "$supervisor_log_parser" "$d/supervisor.log" >"$d/elapsed" 2>"$d/parse.err"; then
    bad "AV mutation: missing end on timeout caught" "AL timed $(cat "$d/elapsed")s from a log with no end for the signalled call"
  else
    ok "AV mutation: missing end on timeout caught" "AL red: $(head -n 1 "$d/parse.err")"
    assert_contains "AV mutation: start while a call is open" "$(head -n 1 "$d/parse.err")" "a start line while a call is open"
  fi
  TOOL=""
else
  bad "AV mutation: missing end on timeout caught" "could not build the mutant supervisor"
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

# ── M2. mutation: ignore the per-add result and remove the final read ────────
mut="$work/tool-no-verify.sh"
if node "$work/mutate.mjs" "$tool" "$mut" verify; then
  d="$(new_fixture mut-verify)"
  write_state "$d/state.json" "0.5.4" "0.5.3" "cli-linux-arm64"
  TOOL="$mut" invoke "$d" 0.5.4 --yes
  if all_latest_eq "$d/state.json" "0.5.3"; then bad "M2 mutation: both checks broken caught" "mutant restored the registry — fixture G is blind to it"; else ok "M2 mutation: both checks broken caught" "mutant left a partial promote (fixture G catches it)"; fi
  TOOL=""
else
  bad "M2 mutation: both checks broken caught" "could not build the mutant"
fi

# ── M3. mutation: remove the TERM trap; fixture K must catch it ───────────────
mut="$work/tool-no-trap.sh"
if node "$work/mutate.mjs" "$tool" "$mut" interrupt; then
  d="$(new_fixture mut-trap)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  TOOL="$mut" run_interrupt "$d" "cli-linux-arm64" "0.5.4" TERM 0.5.4 --yes
  if [ -d "$d/root/.promote-latest.lock" ]; then bad "M3 mutation: missing TERM trap caught" "mutant kept the lock — fixture K is blind to it"; else ok "M3 mutation: missing TERM trap caught" "mutant released the lock (fixture K catches it)"; fi
  TOOL=""
else
  bad "M3 mutation: missing TERM trap caught" "could not build the mutant"
fi

# ── M4. mutation: ignore the in-flight write; fixture K must catch it ─────
mut="$work/tool-reorder.sh"
if node "$work/mutate.mjs" "$tool" "$mut" reorder; then
  d="$(new_fixture mut-reorder)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  TOOL="$mut" run_interrupt "$d" "cli-linux-arm64" "0.5.4" TERM 0.5.4 --yes
  if [ -d "$d/root/.promote-latest.lock" ]; then bad "M4 mutation: in-flight omission caught" "mutant kept the lock — fixture K is blind to it"; else ok "M4 mutation: in-flight omission caught" "mutant released the lock (fixture K catches it)"; fi
  TOOL=""
else
  bad "M4 mutation: in-flight omission caught" "could not build the mutant"
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
  bad "M5 mutation: early trap clear caught" "could not build the mutant"
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

# ── M7. mutation: exactly one dispatch before the last add's post-check ───────
# Fixture T's call count and add-count checks still pass on this mutant. Fixture
# Y must catch its premature dispatch when the last add did not land.
mut="$work/tool-dispatch-early.sh"
if node "$work/mutate.mjs" "$tool" "$mut" dispatch_early; then
  d="$(new_fixture mut-dispatch-early)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  TOOL="$mut" invoke "$d" 0.5.4 --yes
  if [ "$RC" -eq 0 ] && [ "$(gh_calls "$d")" -eq 1 ] && [ "$(grep -c '^adds_before=6$' "$d/gh.log" 2>/dev/null || true)" -eq 1 ]; then
    ok "M7 mutation: T remains green" "one dispatch after six adds"
  else
    bad "M7 mutation: T remains green" "mutant did not model T's blind spot"
  fi
  d="$(new_fixture mut-last-add-noop)"
  write_state "$d/state.json" "0.5.4" "0.5.3" "cli"
  TOOL="$mut" invoke "$d" 0.5.4 --yes
  if [ "$(gh_calls "$d")" -eq 0 ]; then bad "M7 mutation: early dispatch caught" "mutant made no gh call — fixture Y is blind"; else ok "M7 mutation: early dispatch caught" "fixture Y expects zero; mutant called gh $(gh_calls "$d") time(s)"; fi
  TOOL=""
else
  bad "M7 mutation: early dispatch caught" "could not build the mutant"
fi

# ── M9. mutation: remove the final all-package registry read ─────────────────
mut="$work/tool-no-final-read.sh"
if node "$work/mutate.mjs" "$tool" "$mut" final_read; then
  d="$(new_fixture mut-initially-current-drifts)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  node - "$d/state.json" <<'MUT_DRIFT'
const fs = require('fs');
const path = process.argv[2];
const s = JSON.parse(fs.readFileSync(path, 'utf8'));
s.latest['@tpsdev-ai/cli-darwin-arm64'] = '0.5.4';
s.afterAdd = { trigger: '@tpsdev-ai/cli', pkg: '@tpsdev-ai/cli-darwin-arm64', latest: '0.5.3' };
fs.writeFileSync(path, JSON.stringify(s));
MUT_DRIFT
  TOOL="$mut" invoke "$d" 0.5.4 --yes
  if [ "$RC" -eq 0 ] && [ "$(gh_calls "$d")" -eq 1 ]; then
    ok "M9 mutation: skipped final read caught" "mutant dispatched despite an off-target package"
  else
    bad "M9 mutation: skipped final read caught" "mutant did not expose fixture Z's missing check"
  fi
  TOOL=""
else
  bad "M9 mutation: skipped final read caught" "could not build the mutant"
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

# ── M10. mutation (a): supervisor KILLs without the exit-code check ──────────
# Fixture AG's child exits during the grace, so a checked supervisor sends no
# KILL; the mutant calls kill() and records the attempt in the supervisor log.
m10="$work/mut-kill-unchecked"
mkdir -p "$m10"
cp "$tool" "$m10/promote-latest.sh"
if node "$work/mutate-supervisor.mjs" "$here/npm-supervisor.mjs" "$m10/npm-supervisor.mjs" kill_unchecked; then
  d="$(new_fixture mut-kill-unchecked)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
  NPM_TIMEOUT_SECONDS=1 FAKE_NPM_PIDFILE="$d/npm.pid" FAKE_NPM_SIGNAL_LOG="$d/signals" FAKE_NPM_TERM_GRACE_EXIT=1 TOOL="$m10/promote-latest.sh" invoke "$d" 0.5.4 --yes --no-docker
  if [ "$(grep -c '^KILL$' "$d/supervisor.log" 2>/dev/null || true)" -eq 0 ]; then
    bad "M10 mutation (a): unchecked KILL caught" "mutant made no KILL attempt — fixture AG is blind"
  else
    ok "M10 mutation (a): unchecked KILL caught" "mutant attempted kill() after the child exited (fixture AG catches it)"
  fi
  TOOL=""
else
  bad "M10 mutation (a): unchecked KILL caught" "could not build the mutant supervisor"
fi

# ── M10b. mutation (b): count sleeps from an assumed startup, not elapsed ────
# A slow child-spawn stub sleeps 5 s before exec; the mutant starts its sleep
# counter after 5 s, so the call runs past deadline + grace + the 5 s margin.
slow_npm="$work/slow-npm"
cat >"$slow_npm" <<'SLOW_NPM'
#!/bin/bash
if [ "${1:-}" = "dist-tag" ] && [ "${2:-}" = "add" ]; then
  case "${3:-}" in *@0.5.4) sleep 5 ;; esac
fi
exec "$REAL_NPM" "$@"
SLOW_NPM
chmod +x "$slow_npm"
m10b="$work/mut-count-sleeps"
mkdir -p "$m10b"
cp "$tool" "$m10b/promote-latest.sh"
if node "$work/mutate-supervisor.mjs" "$here/npm-supervisor.mjs" "$m10b/npm-supervisor.mjs" count_sleeps; then
  d="$(new_fixture mut-count-sleeps)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-darwin-arm64"; s.stallRollbackVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
  t0="$(node -p 'Date.now()')"
  NPM_TIMEOUT_SECONDS=1 NPM_BIN_OVERRIDE="$slow_npm" REAL_NPM="$fake_npm" PROMOTE_MUTANT_STARTUP_MS=5000 TOOL="$m10b/promote-latest.sh" invoke "$d" 0.5.4 --yes --no-docker
  t1="$(node -p 'Date.now()')"
  elapsed="$(node -p '((Number(process.argv[2]) - Number(process.argv[1])) / 1000).toFixed(2)' "$t0" "$t1")"
  if node -e 'process.exit(Number(process.argv[1]) >= 8 ? 0 : 1)' "$elapsed"; then
    ok "M10b mutation (b): sleep counting caught" "mutant ran ${elapsed}s, past deadline + grace + 5s"
  else
    bad "M10b mutation (b): sleep counting caught" "mutant ran ${elapsed}s — fixture AL is blind"
  fi
  TOOL=""
else
  bad "M10b mutation (b): sleep counting caught" "could not build the mutant supervisor"
fi

# ── M11. mutation: call an uncertain package restored; AE must catch it ───────
mut="$work/tool-uncertain-restored.sh"
if node "$work/mutate.mjs" "$tool" "$mut" uncertain_restored; then
  d="$(new_fixture mut-uncertain-restored)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
  NPM_TIMEOUT_SECONDS=1 TOOL="$mut" invoke "$d" 0.5.4 --yes --no-docker
  if printf '%s' "$ERR" | grep -qF 'rolled back @tpsdev-ai/cli-linux-arm64'; then
    ok "M11 mutation: restored for an uncertain package caught" "mutant printed the restored line (AD/AE catch it)"
  else
    bad "M11 mutation: restored for an uncertain package caught" "mutant printed no restored line — AD/AE are blind"
  fi
  TOOL=""
else
  bad "M11 mutation: restored for an uncertain package caught" "could not build the mutant"
fi

# ── M12. mutation (e): release the lock on the delayed-commit path ──────────
# Fixture AN's delayed PUT lands after the client stopped. The mutant sets
# keep_lock=0, so the EXIT trap removes the lock's pid file. The directory stays
# only because the reason file is inside it, so the next run still refuses. AN
# asserts the pid file.
mut="$work/tool-release-uncertain-lock.sh"
if node "$work/mutate.mjs" "$tool" "$mut" release_uncertain_lock; then
  if [ "$real_ready" -eq 1 ]; then
    d="$(new_fixture mut-release-uncertain-lock)"
    if start_registry "$d" delayed-put; then
      mkdir -p "$d/home" "$d/npm-cache"
      raw="$(HOME="$d/home" npm_config_cache="$d/npm-cache" npm_config_userconfig="$d/home/npmrc" \
        npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm_config_progress=false \
        NPM_TIMEOUT_SECONDS=1 NPM_BIN="$npm_bin" NPM_REGISTRY="http://127.0.0.1:$REG_PORT" PROMOTE_ROOT="$d/root" \
        python3 "$real_pty_runner" "$BASH_BIN" "$mut" 0.5.4 --yes --no-docker)"
      RC=$?
      if [ -f "$d/root/.promote-latest.lock/pid" ]; then
        bad "M12 mutation (e): lock release on delayed commit caught" "mutant kept the lock — AN is blind"
      else
        ok "M12 mutation (e): lock release on delayed commit caught" "mutant removed the pid file (AN asserts the pid file)"
      fi
    else
      bad "M12 mutation (e): lock release on delayed commit caught" "registry did not start"
    fi
    stop_registry
  else
    printf 'SKIP  %-42s npm/node/python3 not installed\n' "M12 mutation (e): lock release on delayed commit caught"
  fi
  TOOL=""
else
  bad "M12 mutation (e): lock release on delayed commit caught" "could not build the mutant"
fi

# ── M13. mutation: drop <&0 from the npm launch; AI must catch it ─────────────
mut="$work/tool-drop-stdin.sh"
if node "$work/mutate.mjs" "$tool" "$mut" drop_stdin; then
  if [ "$real_ready" -eq 1 ]; then
    d="$(new_fixture mut-drop-stdin)"
    if OTP_CODE=246813 start_registry "$d" otp; then
      mkdir -p "$d/home" "$d/npm-cache"
      raw="$(HOME="$d/home" npm_config_cache="$d/npm-cache" npm_config_userconfig="$d/home/npmrc" \
        npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm_config_progress=false \
        NPM_BIN="$npm_bin" NPM_REGISTRY="http://127.0.0.1:$REG_PORT" PROMOTE_ROOT="$d/root" OTP_CODE=246813 \
        python3 "$real_pty_runner" "$BASH_BIN" "$mut" 0.5.4 --yes --no-docker)"
      RC=$?
      OUT="$(printf '%s\n' "$raw" | strip_cr)"
      moved_mut=0
      node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit(s.latest["@tpsdev-ai/cli"] === "0.5.4" ? 0 : 1)' "$d/registry.state" && moved_mut=1
      if [ "$RC" -eq 0 ] && [ "$moved_mut" -eq 1 ]; then
        bad "M13 mutation: dropped stdin caught" "mutant promoted through npm — AI is blind"
      else
        ok "M13 mutation: dropped stdin caught" "mutant exited $RC without moving the tag (AI catches it)"
      fi
    else
      bad "M13 mutation: dropped stdin caught" "registry did not start"
    fi
    stop_registry
  else
    printf 'SKIP  %-42s npm/node/python3 not installed\n' "M13 mutation: dropped stdin caught"
  fi
  TOOL=""
else
  bad "M13 mutation: dropped stdin caught" "could not build the mutant"
fi

# ── M14. mutation (c): set keep_lock AFTER the reason write ─────────────────
# Fixture AM makes the reason write fail. The mutant writes first and lets the
# failure abort under `set -e`, so keep_lock is still 0, the script exits 1 (not 7),
# and the EXIT trap removes the lock's pid file.
mut="$work/tool-keep-lock-after-reason.sh"
if node "$work/mutate.mjs" "$tool" "$mut" keep_lock_after_reason; then
  d="$(new_fixture mut-keep-lock-after-reason)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
  FAKE_NPM_RELEASE_FILE="$d/release" NPM_TIMEOUT_SECONDS=1 TOOL="$mut" start_held "$d" cli-linux-arm64 0.5.4 0.5.4 --yes --no-docker
  if wait_count "$HCOUNTER" 1; then
    mkdir "$d/root/.promote-latest.lock/reason"
    : >"$d/release"
    finish_held "$d"
    if [ -f "$d/root/.promote-latest.lock/pid" ]; then
      bad "M14 mutation (c): keep_lock after reason write caught" "mutant kept the lock — AM is blind"
    else
      ok "M14 mutation (c): keep_lock after reason write caught" "mutant removed the pid file when the reason write failed (AM catches it)"
    fi
  else
    : >"$d/release"
    finish_held "$d"
    bad "M14 mutation (c): keep_lock after reason write caught" "first add was not held"
  fi
  TOOL=""
else
  bad "M14 mutation (c): keep_lock after reason write caught" "could not build the mutant"
fi

# ── M15. mutation (d): drop rollback failures from the reason ───────────────
# Fixture AO has an uncertain write on one package and a rollback failure on
# another; the mutant lists only the uncertain write.
mut="$work/tool-drop-rollback-failures.sh"
if node "$work/mutate.mjs" "$tool" "$mut" drop_rollback_failures; then
  d="$(new_fixture mut-drop-rollback-failures)"
  write_state "$d/state.json" "0.5.4" "0.5.3"
  node -e 'const fs=require("fs"), p=process.argv[1], s=JSON.parse(fs.readFileSync(p)); s.stallAdd="@tpsdev-ai/cli-linux-arm64"; s.stallRollbackVersion="0.5.3"; s.rollbackFailPkg="@tpsdev-ai/cli-darwin-arm64"; s.rollbackFailVersion="0.5.3"; fs.writeFileSync(p,JSON.stringify(s))' "$d/state.json"
  NPM_TIMEOUT_SECONDS=1 TOOL="$mut" invoke "$d" 0.5.4 --yes --no-docker
  reason="$(cat "$d/root/.promote-latest.lock/reason" 2>/dev/null)"
  if printf '%s' "$reason" | grep -qF 'rollback to 0.5.3 did not restore it'; then
    bad "M15 mutation (d): dropped rollback failure caught" "mutant listed the rollback failure — AO is blind"
  else
    ok "M15 mutation (d): dropped rollback failure caught" "mutant omitted the rollback failure (AO catches it)"
  fi
  TOOL=""
else
  bad "M15 mutation (d): dropped rollback failure caught" "could not build the mutant"
fi

# ── M16. mutation: drop the end line from the spawn-error path ────────────────
# Fixture AT's command cannot start; a supervisor that logs no end there leaves
# one start and no end, which AT's pair count must catch.
m16="$work/mut-drop-end-on-error"
mkdir -p "$m16"
if node "$work/mutate-supervisor.mjs" "$here/npm-supervisor.mjs" "$m16/npm-supervisor.mjs" drop_end_on_error; then
  d="$(new_fixture mut-drop-end-on-error)"
  PROMOTE_SUPERVISOR_LOG="$d/supervisor.log" "${NODE_BIN:-node}" "$m16/npm-supervisor.mjs" 5 1 -- "$work/no-such-command" \
    >"$d/out.txt" 2>"$d/err.txt"
  got_ends="$(grep -c '^end [0-9][0-9]*$' "$d/supervisor.log" 2>/dev/null || true)"
  if [ "$got_ends" -eq 0 ]; then
    ok "M16 mutation (f): spawn-error end line caught" "mutant logged a start and no end (fixture AT expects one of each)"
  else
    bad "M16 mutation (f): spawn-error end line caught" "mutant logged $got_ends end line(s) — fixture AT is blind"
  fi
else
  bad "M16 mutation (f): spawn-error end line caught" "could not build the mutant supervisor"
fi

# ── regression guard: the tool must stay clear of known bash-4 syntax ─────────
# Companion only, NOT coverage — see the header. The real control is the macOS
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
