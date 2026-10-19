- **Sandboxed agent launch keeps `--config`, prepares the worktree with checkout deferred, and ignores flags inside a wrapped
  payload.** For a selected runtime whose workspace has a base repository, `tps
  agent start` reads `--config` once into a private snapshot used for parsing,
  the attested re-exec and its read-file grant; when a base repository exists and the workspace is absent,
  the parent creates the worktree with the checkout suppressed
  and the hook path and fsmonitor disabled. Relative workspaces use the source config
  pathname’s directory; the child uses the parent’s absolute workspace and refuses
  a pending-worktree mismatch with `WorktreeLifecycleError` before checkout.
  The sandbox-flag scan reads parsed arguments before a wrapped payload.
