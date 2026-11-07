- **Host and branch connection state writes are atomic, and a branch state write failure is logged best-effort without stopping message handling (Closes #808).**

  A write or rename failure leaves the previous record intact, and the
  temporary file is synced before the rename. The parent directory sync after
  the rename is best-effort. The logger attempts to append a branch state
  write failure report to the branch log. Failed appends are counted; the count
  appears on the next successful append by the same running daemon and is lost
  if the daemon exits or restarts. Nothing is written to stderr, and handling
  continues.
