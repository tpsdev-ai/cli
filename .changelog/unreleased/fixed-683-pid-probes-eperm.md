- **`pidState` now backs the remaining CLI pid probes, so an unsignalable process is running and its pid file is kept (Closes #683).**

  `tps agent list`, `tps agent status`, `tps agent healthcheck`, the branch
  daemon status and stop wait, connection state, the mail bridge, the LLM proxy,
  the mail relay and the launch attestation use the one rule. The mail relay
  keeps a pid file naming a process this user cannot signal (EPERM) and reports
  it running; an invalid pid is handled as a missing process.
