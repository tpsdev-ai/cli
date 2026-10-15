- **Sandboxed agent launch keeps `--config`, manages the worktree outside the
  sandbox, and scans only tps's own arguments.** `tps agent start --config <file>`
  now uses that file when nono is installed, worktree setup and cleanup run
  where they can reach the base repository instead of silently doing nothing,
  and a `--sandbox <word>` inside a message or a wrapped command is no longer
  refused as a flag.
