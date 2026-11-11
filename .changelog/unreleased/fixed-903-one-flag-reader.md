- **Breaking: one flag reader for the CLI subcommand blocks:** `agent`, `mail`, `memory`, `bridge` and `skill` now share one `--flag` reader that stops at the first `--` after the subcommand (a `--` before it is passed), accepts `--name value` and `--name=value`, and refuses a repeated flag with a usage error naming it; a conflicting repeat that meow rejects is reported as a usage error instead of an uncaught stack. `tps agent run --message` is still read directly and takes only the `--name value` form.

  **Upgrade:** a command line that repeats a flag the shared reader handles is refused; pass each flag once.

  `tps flair sync` does not use this reader: give its interval as `--interval <seconds>`, because `--interval=<seconds>` is not recognised as a request for a daemon and runs one sync.
