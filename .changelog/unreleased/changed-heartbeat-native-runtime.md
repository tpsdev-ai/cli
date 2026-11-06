- **Heartbeat skips the gateway probe for agents recorded as native.** `tps init`
  and `tps agent create` record the runtime in `agent.yaml`; existing agents can
  set it with `tps agent set-runtime --id <id> --runtime <openclaw|native>`.
