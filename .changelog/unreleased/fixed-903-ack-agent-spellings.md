- **Breaking: refuse a value-less `--agent` in `mail ack`/`nack`/`gc`:** an `--agent` with no value is refused, so it does not fall back to the default agent; `ack`/`nack` also refuse a trailing positional agent and honour `--agent=<id>`, `gc` refuses a positional agent, and the `ack` and `nack` usage lines and both mail help texts name `--agent <id>` instead of a positional `[agent]`.

  **Upgrade:** pass the agent as `--agent <id>`; a trailing positional agent on `ack` or `nack`, which the parser never read, and a positional agent on `gc` are now refused.
