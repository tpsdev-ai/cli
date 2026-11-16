- **The ack-scratch sweep checks the directory's real path and scratch age.**
  The directory must resolve to a direct child of the locked mailbox root.
  Scratch younger than a minute is left in place and reported; a failed listing
  names the directory and error code and retries on the next ack.
