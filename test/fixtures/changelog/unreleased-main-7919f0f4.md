### Removed

- **The unused root CLI tree (root `src/`, `bin/tps.ts`, `scripts/stall-monitor.ts`) is deleted; the CLI lives in `packages/cli` (Closes #379).**

### Fixed

- **`bun run audit` invokes `bun audit`, the command CI's Dependency Audit runs; the root `ws` dependency now equals its override (Closes #390).**

- **`tps skill show <name>` and `tps skill revoke <name>` read the skill name from the positional argument; `--name` still wins (Closes #360).**
