- **A `--version`/`-v` in a wrapped command's arguments reaches the child instead of printing tps's version (Closes #550).**

  The global-flag scan stops at the wrapped command, so a `--version`/`-v` before it
  still prints tps's own version.
