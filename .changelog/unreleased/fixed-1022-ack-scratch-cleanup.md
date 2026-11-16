- **A leftover ack scratch is reported and removed.** A failed ack scratch
  removal now warns with the scratch path and error code, and the next ack in
  that directory removes a scratch left by a writer that died before its rename.
