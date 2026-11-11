- **Breaking: `tps mail relay stop` and `tps bridge stop` exit non-zero when the pre-signal re-read no longer shows the record they verified.** A stale record for the same pid they verified still exits 0.

  **Upgrade:** a script that treated these stops as successful now sees a non-zero exit when the pre-signal re-read finds the record missing, invalid, or stale under a different pid. Each message names the pid to check.
