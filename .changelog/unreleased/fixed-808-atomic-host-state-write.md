- **Host and branch connection state writes are atomic, and a failed branch state write no longer stops message handling (Closes #808).**

  A write or rename failure leaves the previous record intact, and the
  temporary file is synced before the rename. The parent directory sync after
  the rename is best-effort. A branch state write failure is reported in the
  branch log when the log is writable; message handling continues either way.
