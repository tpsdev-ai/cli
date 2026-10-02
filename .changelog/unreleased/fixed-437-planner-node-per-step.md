- **The reviewer launcher refuses a build with a step planned on the default node when any planned `setup-node` pins node (Closes #437).**

  A planned `run:` step carries `node`: `default`, or the version the most
  recent preceding `setup-node` pins. The refusal (`node-mismatch`) names the
  job, the step, its planned node and the image's node.
