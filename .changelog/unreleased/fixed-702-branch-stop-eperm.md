- **`tps branch stop` keeps the pid file and fails when the signal is refused with EPERM (Closes #702).**

  A process this user may not signal is alive; the stop classifies the refusal
  with the shared `pidState` classifier and reports the pid instead of removing
  its pid file and saying the daemon is not running. A process the same
  classifier reports gone still has its stale pid file removed.
