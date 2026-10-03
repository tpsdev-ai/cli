- **`tps branch` and `tps memory` refuse by name when no identity is configured, instead of falling back to the hostname or `admin`.**

  `tps branch` takes `TPS_AGENT_ID`, then the id persisted by `tps branch init --agent`; `tps memory` takes `TPS_AGENT_ID` or its agent-id argument.
