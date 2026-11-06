- **Heartbeat skips the gateway probe only when `runtime` parses as `native` and
  has a single top-level plain `runtime: native` line,** with optional trailing spaces,
  tabs or a `#` comment; every other form is probed. Set it with
  `tps agent set-runtime --id <id> --runtime <openclaw|native>`.
