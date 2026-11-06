- **Heartbeat skips the gateway probe for agents recorded as native.** `tps init`
  and fresh `tps agent create` configs record heartbeat's `runtime` field in
  `agent.yaml`; set it with `tps agent set-runtime --id <id> --runtime <openclaw|native>`.
