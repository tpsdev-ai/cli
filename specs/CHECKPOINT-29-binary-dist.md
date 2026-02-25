# CHECKPOINT-29 — Binary Distribution (bun build --compile)

## Context
TPS CLI is published on npm as `@tpsdev-ai/cli@0.2.0` but **crashes on Node.js** due to a `bun:sqlite` import in `packages/cli/src/utils/archive.ts`. Since we develop with Bun and use Bun-specific APIs, we should ship as a compiled native binary — the same approach Anthropic uses for Claude Code.

Currently: `npm install -g @tpsdev-ai/cli` → user runs `tps hire` → `ERR_UNSUPPORTED_ESM_URL_SCHEME` crash.

## Objective
Compile TPS CLI into standalone platform-specific binaries using `bun build --compile` and distribute via npm with platform-specific packages.

## Requirements

### 1. Build Pipeline
- Add `bun build --compile packages/cli/src/bin/tps.ts --outfile dist/tps` to the build process
- Target platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`
- Cross-compile using `--target=bun-linux-x64` etc.
- Output: one native binary per platform, no runtime dependency on Node or Bun

### 2. npm Distribution Strategy
Follow the pattern used by Claude Code, esbuild, and other binary-shipping npm packages:

```
@tpsdev-ai/cli                    # Meta-package, detects platform, installs correct binary
@tpsdev-ai/cli-darwin-arm64       # macOS Apple Silicon binary
@tpsdev-ai/cli-darwin-x64         # macOS Intel binary
@tpsdev-ai/cli-linux-arm64        # Linux ARM64 binary
@tpsdev-ai/cli-linux-x64          # Linux x86_64 binary
```

The root `@tpsdev-ai/cli` package uses `optionalDependencies` to pull the right platform binary:

```json
{
  "optionalDependencies": {
    "@tpsdev-ai/cli-darwin-arm64": "0.3.0",
    "@tpsdev-ai/cli-darwin-x64": "0.3.0",
    "@tpsdev-ai/cli-linux-arm64": "0.3.0",
    "@tpsdev-ai/cli-linux-x64": "0.3.0"
  }
}
```

Each platform package declares its `os` and `cpu` fields so npm only downloads the correct one:

```json
{
  "name": "@tpsdev-ai/cli-darwin-arm64",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "bin": { "tps": "./tps" }
}
```

### 3. Root Package Bin Wrapper
The root `@tpsdev-ai/cli` package provides a thin `bin/tps` script that:
1. Checks which platform package is installed
2. Executes the correct binary
3. Falls back to a helpful error if no platform binary found

```js
#!/usr/bin/env node
const { execFileSync } = require("child_process");
const path = require("path");
const pkg = `@tpsdev-ai/cli-${process.platform}-${process.arch}`;
try {
  const binPath = require.resolve(`${pkg}/tps`);
  execFileSync(binPath, process.argv.slice(2), { stdio: "inherit" });
} catch {
  console.error(`TPS: No binary available for ${process.platform}-${process.arch}`);
  console.error(`Install: npm install -g @tpsdev-ai/cli`);
  process.exit(1);
}
```

### 4. CI Integration
- Add a `release` workflow to `.github/workflows/release.yml`
- Triggered on git tags (`v*`)
- Matrix build: compile for all 4 platform targets
- Publish all 5 packages to npm (root + 4 platform)
- Upload binaries as GitHub Release assets too
- **[S29-A]** Checksums: generate SHA-256 checksums for each binary, publish in release notes

### 5. @tpsdev-ai/agent Package
- The agent runtime package has **no bun-specific imports** — it stays as a normal npm package (TypeScript compiled to ESM)
- No binary distribution needed for agent

### 6. Version Bump
- Bump to `0.3.0` for this release (new distribution model is a breaking change in packaging)

## Security Constraints

| ID | Severity | Description |
|---|---|---|
| S29-A | HIGH | SHA-256 checksums for all platform binaries in release notes |
| S29-B | MEDIUM | Compiled binary must not embed any environment variables or secrets from build host |
| S29-C | MEDIUM | CI must build from clean checkout — no local artifacts in binary |
| S29-D | LOW | Platform packages should have `"files"` array in package.json to limit published content |

## Non-Goals
- Windows support (no demand yet, easy to add later)
- Homebrew formula (post-launch)
- Direct binary download without npm (GitHub Releases covers this)

## Success Criteria
- `npm install -g @tpsdev-ai/cli` works on Node.js (no bun runtime needed)
- `tps --version` returns correct version
- `tps hire developer --name Test --dry-run` succeeds
- All existing tests still pass (`bun test`)
- Binary size < 100MB per platform
- CI release workflow publishes all packages on tag push

## Output Contract
DONE 29: `<commit-hash>` @Flint — or BLOCKED: `<error + file + cmd>` @Flint
