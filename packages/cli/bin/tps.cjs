#!/usr/bin/env node

const { execFileSync } = require('child_process');

const platform = process.platform;
const arch = process.arch;
const pkg = `@tpsdev-ai/cli-${platform}-${arch}`;

function runBinary() {
  try {
    const binPath = require.resolve(`${pkg}/tps`);
    execFileSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
    return;
  } catch (err) {
    console.error(`TPS: no binary package available for ${platform}-${arch}.`);
    console.error(`Run npm install -g ${pkg} to install the platform binary package.`);
    console.error('Or run from source inside the repository via `bun run tps` in packages/cli.');
    process.exitCode = 1;
  }
}

runBinary();
