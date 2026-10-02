- **`agent start --runtime claude-code|codex|gemini` with `--sandbox-required` is refused before dispatch; that path does not run attested (Refs #363).**

  Those three runtimes branch in the CLI before the attested launch and spawn
  the runtime directly, so they are not confined by nono. The launch gate keys
  "an agent launch must assert `--sandbox-required`" on the command name, so the
  flag passed there and the process then ran unconfined — an isolation asserted
  that the path could not deliver. The gate now refuses such an invocation before
  anything is spawned, with a runtime-specific message unless an earlier launch
  control has already refused it. Routing those runtimes through the attested launch
  is slice B of the same issue.
