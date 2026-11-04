- **`tps branch stop` checks the recorded token immediately before signalling.**
  `ps` tokens have one-second precision; PID reuse between the check and signal
  remains possible. Unverified live records are refused; stale and invalid
  records are removed if unlink succeeds. Invalid records leave daemon state unknown.
