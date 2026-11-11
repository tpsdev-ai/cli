- **Breaking: the bridge, roster dashboard and `tps agent commit` require a configured
  agent identity**. Each refuses by name when none is set rather than falling
  back to the literal `anvil`.

  **Upgrade:** anything that relied on the implicit `anvil` identity must set `TPS_AGENT_ID`.
