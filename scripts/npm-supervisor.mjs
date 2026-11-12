#!/usr/bin/env node
// npm-supervisor.mjs — run one command under an elapsed deadline.
//
// Usage: node npm-supervisor.mjs <deadline-seconds> <grace-seconds> -- <command> [args...]
//
// The child inherits this process's stdin, stdout and stderr, so an npm
// one-time-password prompt still reaches the terminal. The deadline is measured
// from the timer set just after spawn (not counted sleeps). On the deadline
// the supervisor sends TERM through the ChildProcess handle; after the grace it
// sends KILL only while the child has neither an exit code nor a signal code.
// INT, TERM and HUP received by the supervisor are forwarded to the child the
// same way. Exit status: the child's code (128+n if a signal killed it), 124 on a
// deadline timeout, 127 if the command cannot start, 2 on a usage error.
//
// PROMOTE_SUPERVISOR_LOG, when set, names the log file. The path is opened once,
// before the spawn, with O_NONBLOCK; the descriptor is kept only when fstat says
// it is a regular file (otherwise logging is off and closing it is attempted). If the open
// fails, or fstat cannot inspect the descriptor it returned, logging is off too.
// Every later line is written to that descriptor,
// never by path, so a path replaced during the call is never opened. The
// descriptor stays open for the life of the process; process exit closes it.
// Each supervised call appends `start <ms>` before the spawn, `end <ms>` when the
// call ends, and a signal name for each kill attempt.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const argv = process.argv.slice(2);
if (argv.length < 4 || argv[2] !== '--') {
  process.stderr.write(
    'npm-supervisor: usage: npm-supervisor.mjs <deadline-seconds> <grace-seconds> -- <command> [args...]\n',
  );
  process.exit(2);
}
const deadlineSeconds = Number(argv[0]);
const graceSeconds = Number(argv[1]);
if (
  !Number.isFinite(deadlineSeconds) ||
  deadlineSeconds <= 0 ||
  !Number.isFinite(graceSeconds) ||
  graceSeconds < 0
) {
  process.stderr.write('npm-supervisor: deadline must be a positive number and grace a non-negative number\n');
  process.exit(2);
}
const [command, ...args] = argv.slice(3);

const requestedLogPath = process.env.PROMOTE_SUPERVISOR_LOG || '';
let logFd = -1;
if (requestedLogPath !== '') {
  let fd = -1;
  try {
    fd = fs.openSync(
      requestedLogPath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NONBLOCK,
    );
    if (fs.fstatSync(fd).isFile()) {
      logFd = fd;
      fd = -1;
    }
  } catch {
    // Covers an open that failed and an fstat that could not inspect the
    // descriptor the open returned. Either way logging is off: a diagnostic
    // line is not worth failing the call. The finally below attempts to close a
    // descriptor that did not become the log.
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed or not closeable; logging is off either way.
      }
    }
  }
}
function logLine(line) {
  if (logFd < 0) return;
  try {
    fs.writeSync(logFd, line + '\n');
  } catch {
    // The log is diagnostic only; never fail the call for it.
  }
}
function logSignal(name) {
  logLine(name);
}

// One supervisor owns one call, so a start/end pair brackets this call's own
// duration even though the promotion makes other calls before and after it.
logLine('start ' + Date.now());

const child = spawn(command, args, { stdio: 'inherit' });

let timedOut = false;
let exitInfo = null;
let graceDone = false;
let deadlineTimer = null;
let graceTimer = null;

// A child that has exited reports an exit code or a signal code; do not signal it.
function gone() {
  return child.exitCode !== null || child.signalCode !== null;
}

function send(signal) {
  if (gone()) return false;
  try {
    child.kill(signal);
  } catch {
    return false;
  }
  logSignal(signal.replace(/^SIG/, ''));
  return true;
}

let endLogged = false;
function logEnd() {
  if (endLogged) return;
  endLogged = true;
  logLine('end ' + Date.now());
}

function exitWithStatus() {
  if (!exitInfo) return;
  logEnd();
  if (timedOut) process.exit(124);
  if (exitInfo.signal) process.exit(128 + (os.constants.signals[exitInfo.signal] || 0));
  process.exit(typeof exitInfo.code === 'number' ? exitInfo.code : 1);
}

deadlineTimer = setTimeout(() => {
  if (gone()) return;
  timedOut = true;
  send('SIGTERM');
  graceTimer = setTimeout(() => {
    graceDone = true;
    if (!gone()) send('SIGKILL');
    exitWithStatus();
  }, Math.round(graceSeconds * 1000));
}, Math.round(deadlineSeconds * 1000));

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    send(signal);
  });
}

child.on('error', (err) => {
  clearTimeout(deadlineTimer);
  logEnd();
  process.stderr.write('npm-supervisor: could not start ' + command + ': ' + err.message + '\n');
  process.exit(127);
});

child.on('exit', (code, signal) => {
  exitInfo = { code, signal };
  clearTimeout(deadlineTimer);
  // A timed-out call ends at the grace timer, which rules out a KILL for a child
  // that has already exited. Any other exit is final now.
  if (!timedOut || graceDone) exitWithStatus();
});
