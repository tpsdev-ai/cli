- **The TUI approve and merge actions are removed**. Pulse notification mail uses
  the `pulse` principal. `pulse start` requires `mergeAuthority`, `ghAgent`, and
  `author`; transitions require their notification recipient before changing
  state. Agent-id lists come from the credentials manifest's `agents` list.
