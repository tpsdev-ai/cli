- **`tps agent start` removes `config-*` launch snapshots whose recorded launcher is no longer running (Closes #667).**

  A forced termination leaves the private config snapshot under `~/.tps/launch`
  behind. Each snapshot now records the launching pid and process start token;
  the next launch removes entries whose owner is gone and keeps a live
  launcher's snapshot.
