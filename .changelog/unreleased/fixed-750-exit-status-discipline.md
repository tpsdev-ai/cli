- **Heartbeat and office join exit statuses.** `tps heartbeat` exits 1 for workspace write failures or failed gateway RPC
  probes, and `tps office join --tunnel-via` exits 1 when Flair spoke or
  supervision provisioning fails. A guard test checks approved AST contexts
  for no-argument and explicit-zero direct `process.exit(...)` calls.
