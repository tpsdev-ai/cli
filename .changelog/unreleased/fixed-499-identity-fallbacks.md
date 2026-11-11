- **Breaking: `tps branch start` and memory governance actions refuse by name without an identity.**

  Branch start takes `TPS_AGENT_ID` or the id persisted by `tps branch init --agent`. Memory `review`, `approve`, `reject`, `archive`, `unarchive`, `purge`, `list`, `show`, and `search` take `TPS_AGENT_ID`; `review` and `list` can use their agent-id argument.

  **Upgrade:** a branch initialized without `--agent` and a memory command run without an identity (they used the host name and `admin`) must now get `TPS_AGENT_ID`.
