- **These failures now exit non-zero.** `tps heartbeat` exits 1 when a health
  check fails, and `tps office join --tunnel-via` exits 1 when Flair spoke or
  supervision provisioning fails. A guard test rejects a new `process.exit(0)`
  in a command outside its pinned allowlist.
