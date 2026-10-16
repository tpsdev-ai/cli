- **Sandboxed agent launch keeps `--config`, prepares the worktree without
  running repository-configured code, and ignores flags inside a wrapped
  payload.** For a selected runtime whose workspace has a base repository, `tps
  agent start` now resolves `--config` once and carries the path through the
  attested re-exec; the parent creates the worktree with the checkout suppressed
  and the hook path and fsmonitor disabled, and the sandboxed child checks it out
  inside the sandbox, so no repository-configured filter or hook runs outside it;
  and the sandbox-flag scan reads parsed arguments before a wrapped payload.
