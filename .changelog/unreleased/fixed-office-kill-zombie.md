- **`tps office kill` treats a Linux zombie as stopped.** A process that has exited but whose parent has not
  reaped it still answers `kill(pid, 0)`; `office kill` now reads `/proc/<pid>/stat` and removes the record
  instead of reporting a failed stop.
