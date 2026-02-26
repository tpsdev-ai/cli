#!/usr/bin/env node

const { execFileSync } = require('child_process');
const path = require('path');

const platform = process.platform;
const arch = process.arch;
const pkg = `@tpsdev-ai/cli-${platform}-${arch}`;

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  // Fast-path version output even when native binary package is missing.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const version = require('../package.json').version;
  console.log(version);
  process.exit(0);
}

// Search for the platform binary relative to this package, not the cwd.
// npm nests optionalDependencies inside the parent's node_modules.
const searchPaths = [path.join(__dirname, '..'), path.join(__dirname, '..', '..')];

function runBinary() {
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`, { paths: searchPaths });
    const binPath = path.join(path.dirname(pkgJson), 'tps');
    execFileSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
    return;
  } catch (err) {
    // Fall through to error message
  }

  // Fallback for source/dev installs where dist JS exists.
  try {
    const jsCli = path.join(__dirname, '..', 'dist', 'bin', 'tps.js');
    execFileSync(process.execPath, [jsCli, ...process.argv.slice(2)], { stdio: 'inherit' });
    return;
  } catch (_) {
    // continue to error output
  }

  console.error(`Failed to load native binding`);
  console.error(`TPS: no binary package available for ${platform}-${arch}.`);
  console.error(`Try reinstalling main package: npm install -g @tpsdev-ai/cli@${require('../package.json').version}`);
  console.error(`Or install platform binary directly: npm install -g ${pkg}@${require('../package.json').version}`);
  process.exitCode = 1;
}

runBinary();
