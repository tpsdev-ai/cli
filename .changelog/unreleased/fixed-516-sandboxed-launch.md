- **Sandboxed agent launch keeps `--config`, prepares the worktree with checkout deferred, and ignores flags inside a wrapped
  payload.** For a selected runtime whose workspace has a base repository, `tps
  agent start` now resolves `--config` to an absolute path in the parent and passes the
  attested re-exec child that file's canonical target path, the path its read
  grant names; when a base repository exists and the workspace is absent,
  the parent creates the worktree with the checkout suppressed
  and the hook path and fsmonitor disabled. Relative workspaces use the config
  pathname’s directory; the child uses the parent’s absolute workspace and refuses
  a pending-worktree mismatch with `WorktreeLifecycleError` before checkout.
  The sandbox-flag scan reads parsed arguments before a wrapped payload.
