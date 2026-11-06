- **`agent set-runtime` keeps the config's permission bits and group.** The
  replacement file no longer copies setuid, setgid or sticky bits, and it keeps
  the original group and owner where the process may. Group-only retry is limited
  to EPERM/EACCES; any other ownership error, a failed retry or a chmod failure
  refuses the write, leaving the original config in place.
  `agent create --runtime` with no value is refused, naming the accepted
  values.
