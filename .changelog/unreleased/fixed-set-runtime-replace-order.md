- **`agent set-runtime` orders ownership before mode, verifies the temporary file before the rename, and warns after the rename when the owner could not be preserved.**

  `agent create` validates `--runtime` before refusing an existing config, so
  an invalid value gets the accepted-values refusal either way.
