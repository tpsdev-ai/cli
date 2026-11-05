- **Commands that set a failure exit code now exit non-zero.** The entry point
  exits with the status the command set instead of replacing it with 0, so a
  failure path that sets `process.exitCode` reaches the caller.
