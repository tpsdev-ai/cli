- **The reviewer build planner records the node each step runs under: the default node before the job's first `setup-node`, its pinned version after (Closes #437).**

  A planned `run:` step carries `node` — the version the most recent preceding
  `setup-node` pins, or `default` for the node the job's environment provides. A
  later `setup-node` re-pins from that step.
