- **`agent set-runtime` orders ownership before mode, verifies the temporary file before the rename, and warns when it keeps only the group.**

  `agent create` validates `--runtime` before refusing an existing config, so
  an invalid value gets the accepted-values refusal either way.
