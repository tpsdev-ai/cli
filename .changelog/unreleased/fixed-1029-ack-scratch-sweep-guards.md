- **The ack-scratch sweep collects only old scratch in the cur/ its mailbox
  lock guards.** A scratch reached through a shared directory, or one younger
  than a minute, is left in place and reported; a failed listing names the
  directory and error code and retries on the next ack.
