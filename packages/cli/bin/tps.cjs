#!/usr/bin/env node

const { execFileSync } = require('child_process');
const path = require('path');

const platform = process.platform;
const arch = process.arch;
const pkg = `@tpsdev-ai/cli-${platform}-${arch}`;

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

  console.error(`Failed to load native binding`);
  console.error(`TPS: no binary package available for ${platform}-${arch}.`);
  console.error(`Run npm install -g ${pkg} to install the platform binary package.`);
  console.error('Or run from source inside the repository via `bun run tps` in packages/cli.');
  process.exitCode = 1;
}

runBinary();
