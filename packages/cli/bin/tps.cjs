#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const platform = process.platform;
const arch = process.arch;
const pkg = `@tpsdev-ai/cli-${platform}-${arch}`;
const FALLBACK_VERSION = process.env.TPS_CLI_VERSION || process.env.npm_package_version || 'dev';

function getCliVersion() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  // Fast-path version output even when native binary package is missing.
  console.log(getCliVersion());
  process.exit(0);
}

// Search for the platform binary relative to this package, not the cwd.
// npm nests optionalDependencies inside the parent's node_modules.
const searchPaths = [path.join(__dirname, '..'), path.join(__dirname, '..', '..')];

// Signals map to the shell convention 128 + signal number; an unknown signal
// still yields a non-zero status.
const SIGNAL_NUMBERS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
  SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
  SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
};

// The exit status a child's thrown error stands for, or null when the process
// could not be started. execFileSync distinguishes the two: a process that ran
// and exited non-zero carries a numeric `status`, one killed by a signal
// carries `signal`, and a spawn failure (ENOENT, EACCES, …) carries neither.
function exitStatusFor(thrown) {
  if (typeof thrown.status === 'number') return thrown.status;
  if (thrown.signal) return 128 + (SIGNAL_NUMBERS[thrown.signal] || 0);
  return null;
}

function reportLoadFailure() {
  console.error(`Failed to load native binding`);
  console.error(`TPS: no binary package available for ${platform}-${arch}.`);
  const version = getCliVersion();
  console.error(`Try reinstalling main package: npm install -g @tpsdev-ai/cli@${version}`);
  console.error(`Or install platform binary directly: npm install -g ${pkg}@${version}`);
}

// Fallback for source/dev installs where dist JS exists. Returns the exit
// status to use.
function runJsFallback() {
  const jsCli = path.join(__dirname, '..', 'dist', 'bin', 'tps.js');
  try {
    execFileSync(process.execPath, [jsCli, ...process.argv.slice(2)], { stdio: 'inherit' });
    return 0;
  } catch (err) {
    const status = exitStatusFor(err);
    if (status !== null) return status;
    reportLoadFailure();
    return 1;
  }
}

function runBinary() {
  let binPath;
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`, { paths: searchPaths });
    binPath = path.join(path.dirname(pkgJson), 'tps');
  } catch (_err) {
    // The platform package itself is missing — fall back to the JS entry.
    process.exitCode = runJsFallback();
    return;
  }

  try {
    execFileSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
  } catch (err) {
    const status = exitStatusFor(err);
    if (status !== null) {
      // The binary ran and did not exit cleanly — propagate its status and
      // never run the fallback.
      process.exit(status);
    }
    // The binary could not be started — fall back to the JS entry.
    process.exitCode = runJsFallback();
  }
}

runBinary();
