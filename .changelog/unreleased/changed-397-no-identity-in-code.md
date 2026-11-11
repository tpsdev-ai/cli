- **Breaking: the TUI approve and merge actions are removed**. Pulse notification mail uses
  the `pulse` principal. `pulse start` requires `mergeAuthority`, `ghAgent`, and
  `author`; transitions require their notification recipient before changing
  state. The keyring-PAT, office-health and owner-inference agent lists come from
  the credentials manifest's `agents` list; pulse's reviewer list stays in pulse
  configuration.

  **Upgrade:** a Pulse config that relied on the defaults must set `mergeAuthority`, `ghAgent` and `author` in `~/.tps/pulse/config.json`.
