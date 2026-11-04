- **`tps office kill` checks each record's start token immediately before signalling it.** Host
  state records written by the relay carry the process start token when it is available, and the
  branch pid file is read at the path its writer uses. A record classified as unverified is not
  signalled: it is kept and named, and the command exits non-zero. A pid reused
  after the check and before the signal is not detected, and the `ps` fallback token has one-second
  precision.
