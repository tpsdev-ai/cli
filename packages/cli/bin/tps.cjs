#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { parseCliArgs } = require('./cli-args.cjs');
const { existsSync } = require('node:fs');
const { constants: { signals } } = require('node:os');

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

let versionRequested = false;
try {
  versionRequested = parseCliArgs(process.argv.slice(2)).versionRequested;
} catch (err) {
  // The shared scan refuses a guard-mode flag placed before the subcommand
  // (cli#563). Report the named error the way the CLI does, rather than letting
  // the throw escape as a stack trace before the fast path below.
  console.error(err.message);
  process.exit(1);
}

if (versionRequested) {
  // Fast-path version output even when native binary package is missing.
  console.log(getCliVersion());
  process.exit(0);
}

// Search for the platform binary relative to this package, not the cwd.
// npm nests optionalDependencies inside the parent's node_modules.
const searchPaths = [path.join(__dirname, '..'), path.join(__dirname, '..', '..')];

// The exit status a child's thrown error stands for, or null when the process
// could not be started. execFileSync distinguishes the two: a process that ran
// and exited non-zero carries a numeric `status`, one killed by a signal
// carries `signal`, and a spawn failure (ENOENT, EACCES, …) carries neither.
function exitStatusFor(thrown) {
  if (thrown.signal) return 128 + (signals[thrown.signal] || 0);
  if (typeof thrown.status === 'number') return thrown.status;
  return null;
}

function reportLoadFailure(message) {
  console.error(message);
  const version = getCliVersion();
  console.error(`Try reinstalling main package: npm install -g @tpsdev-ai/cli@${version}`);
  console.error(`Or install platform binary directly: npm install -g ${pkg}@${version}`);
}

// Fallback for source/dev installs where dist JS exists. Returns the exit
// status to use.
function runJsFallback(failureMessage) {
  const jsCli = path.join(__dirname, '..', 'dist', 'bin', 'tps.js');
  if (!existsSync(jsCli)) {
    reportLoadFailure(failureMessage);
    return 1;
  }
  try {
    execFileSync(process.execPath, [jsCli, ...process.argv.slice(2)], { stdio: 'inherit' });
    return 0;
  } catch (err) {
    const status = exitStatusFor(err);
    if (status !== null) return status;
    reportLoadFailure(`TPS: JS entry could not be started.`);
    return 1;
  }
}

function runBinary() {
  let binPath;
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`, { paths: searchPaths });
    binPath = path.join(path.dirname(pkgJson), 'tps');
  } catch (_err) {
    // The platform package could not be resolved — fall back to the JS entry.
    process.exitCode = runJsFallback(`Failed to load native binding\nTPS: no binary package available for ${platform}-${arch}.`);
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
    process.exitCode = runJsFallback(`TPS: platform binary could not be started.`);
  }
}

runBinary();
