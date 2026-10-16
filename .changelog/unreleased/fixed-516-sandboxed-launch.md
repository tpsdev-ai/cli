- **Sandboxed agent launch keeps `--config`, manages the worktree outside the
  sandbox, and ignores flags inside a wrapped payload.** `tps agent start
  --config <file>` now resolves the path once and carries it through the
  attested re-exec, worktree setup and cleanup run in the parent where the base
  repository's metadata is writable instead of silently doing nothing, and the
  sandbox-flag scan stops at the `--` before a message or wrapped command, so a
  `--sandbox <word>` inside one is no longer refused as a flag.
