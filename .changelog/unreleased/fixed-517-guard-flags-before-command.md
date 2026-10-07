- **`tps secrets-guard` reads its own mode flags only up to the wrapped command (Closes #517).**

  A `--check` or `--no-guard` inside the wrapped command's arguments reaches the
  child as data and leaves the guard's mode unchanged.
