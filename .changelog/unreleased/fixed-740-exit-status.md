- **Breaking: commands that set a failure exit code now exit non-zero.** The entry point
  exits with the status the command set instead of replacing it with 0, so a
  failure path that sets `process.exitCode` reaches the caller.

  **Upgrade:** scripts that ignored these failures (the entry point exited 0) will now see the non-zero status and must handle it.
