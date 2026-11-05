- **These failures now exit non-zero.** `tps heartbeat` exits 1 when a health
  check fails, and `tps office join --tunnel-via` exits 1 when Flair spoke or
  supervision provisioning fails. A guard test checks approved AST contexts
  for no-argument and explicit-zero direct `process.exit(...)` calls.
