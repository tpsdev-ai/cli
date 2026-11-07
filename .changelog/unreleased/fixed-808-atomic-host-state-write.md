- **Host and branch connection state writes are atomic, and a branch state write failure is logged best-effort without stopping message handling (Closes #808).**

  A write or rename failure leaves the previous record intact, and the
  temporary file is synced before the rename. The parent directory sync after
  the rename is best-effort. A branch state write failure is appended to the
  branch log; if that append fails, the fallback attempts one escaped line on
  stderr, bounded and non-blocking (lines dropped when stderr is not being
  drained), and every logging failure is swallowed, so handling continues.
