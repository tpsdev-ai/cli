- **`tps office connect` runs its checked shutdown on SIGTERM as well as SIGINT (#762).**

  `tps office kill` stops the connector with SIGTERM, so the relay now stops and
  the host connection record is cleared under the record lock. A failed clear
  prints `Disconnect failed: ...` and exits non-zero; a second signal while the
  shutdown runs starts no second shutdown.
