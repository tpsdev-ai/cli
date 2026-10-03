- **No local tool approves, merges, or signs as a fixed maintainer** — the TUI
  approve and merge actions are removed. `tps pulse` runs as its own `pulse`
  principal, takes its merge authority and gh identity from configuration
  (refusing with a named error when unset), and never signs mail as another
  agent. Agent-id lists (keyring PATs, local agents, known agents) come from
  the credentials manifest's `agents` list instead of source.
