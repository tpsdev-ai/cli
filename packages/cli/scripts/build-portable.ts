#!/usr/bin/env bun
/**
 * build-portable.ts — Build a standalone tps binary with sodium-javascript (pure JS)
 * instead of sodium-native (native addon).  This keeps the binary portable across
 * machines — no baked-in CI paths, no missing .node addons.
 *
 * Usage:
 *   bun run scripts/build-portable.ts <target> [outfile]
 *
 * Targets: bun-linux-x64, bun-linux-arm64, bun-darwin-x64, bun-darwin-arm64
 *
 * Two-phase build:
 *   1. Bun.build() with a plugin that aliases sodium-native → sodium-javascript
 *   2. bun build --compile on the bundled output to produce the standalone binary
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

const target = (process.argv[2] as string) || "bun-linux-x64";
const outfile =
  process.argv[3] || resolve(pkgRoot, "dist", `tps-${target.replace("bun-", "")}`);

// Read version from package.json
const pkgJson = JSON.parse(
  await Bun.file(resolve(pkgRoot, "package.json")).text()
);
const version = pkgJson.version || "0.0.0";

// Phase 1: bundle with sodium-native → sodium-javascript alias
const sjPath = resolve(repoRoot, "node_modules", "sodium-javascript", "index.js");

const result = await Bun.build({
  entrypoints: [resolve(pkgRoot, "bin", "tps.ts")],
  target: "bun",
  outdir: resolve(pkgRoot, "dist"),
  define: {
    INJECTED_VERSION: JSON.stringify(version),
  },
  external: ["require-addon"],
  plugins: [
    {
      name: "alias-sodium-native",
      setup(build) {
        build.onResolve({ filter: /^sodium-native$/ }, () => {
          return { path: sjPath };
        });
      },
    },
  ],
  naming: "[dir]/tps-bundle.[ext]",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const bundlePath = result.outputs[0].path;

// Phase 2: compile the bundle to a standalone binary
const proc = Bun.spawnSync(
  ["bun", "build", "--compile", bundlePath, "--target", target, "--outfile", outfile],
  {
    cwd: repoRoot,
    stdio: ["inherit", "inherit", "inherit"],
  }
);

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode ?? 1);
}

console.log(`Portable binary: ${outfile}`);
