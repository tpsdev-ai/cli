- **Sandboxed agent launch keeps `--config`, prepares the worktree with checkout deferred, and ignores flags inside a wrapped
  payload.** For a selected runtime whose workspace has a base repository, `tps
  agent start` now resolves `--config` once and carries the path through the
  attested re-exec; when a base repository exists and the workspace is absent,
  the parent creates the worktree with the checkout suppressed
  and the hook path and fsmonitor disabled, and the sandboxed child checks it out
  inside the sandbox;
  and the sandbox-flag scan reads parsed arguments before a wrapped payload.
