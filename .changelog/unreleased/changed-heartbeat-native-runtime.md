- **Heartbeat skips the gateway probe only for an explicit top-level `runtime: native`
  line as tps writes it; every other form is probed.** `tps init`
  and fresh `tps agent create` configs record heartbeat's `runtime` field in
  `agent.yaml`; set it with `tps agent set-runtime --id <id> --runtime <openclaw|native>`.
