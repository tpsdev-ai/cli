- **The nono profile gate resolves the workspace agent package.** The gate job
  installs the workspace and builds the agent package before running, so its
  launch-args checks use the local package rather than a published one.
