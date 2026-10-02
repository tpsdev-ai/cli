- **`agent start --runtime claude-code|codex|gemini` now runs through the attested launch and is confined by nono (Closes #363).**

  Those three runtimes branched in the CLI before the attested launch and
  spawned the runtime directly, so they ran outside nono and a
  `--sandbox-required` launch asserted an isolation the path could not deliver.
  They now reach the same attested launch as every other agent start: a launch
  that asserts `--sandbox-required` is confined, or refused before anything is
  spawned when confinement is unavailable.
