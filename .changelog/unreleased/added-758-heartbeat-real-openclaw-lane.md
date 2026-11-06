- **A CI lane runs `tps heartbeat` against a real, pinned OpenClaw release.**
  The dead-gateway case asserts the persisted error and exit 1; the live case
  starts the real gateway on an ephemeral port and asserts an online record and
  exit 0. The lane installs an exact OpenClaw version into a temp prefix with
  install scripts disabled and leaves the lockfile unchanged.
