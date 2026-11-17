- **The ack-scratch sweep checks the directory's real path and scratch age.**
  Before listing, it checks that the directory's real path is a direct child of
  the locked mailbox root; replacement or retargeting during the sweep is not detected.
  The sweep removes regular scratch files at least a minute old, reports skipped
  non-regular or recent entries, and retries a failed listing on the next ack.
