- **The codex runtime's mail-task auto-commit keeps the pre-task baseline across a stale-rebase abort and resolves `autoCommit.repo` against the config file's directory.**

  The runtime resolves `autoCommit.repo ?? workspace` once and runs the mail auto-commit gate's Git
  probes and the rebase abort there. An interrupted rebase is detected with
  `git rev-parse --path-format=absolute --git-path`; a failed probe skips
  auto-commit and reports it. A successful abort keeps the pre-task baseline, so
  a restored HEAD different from the pre-task HEAD causes a commit attempt (for
  example a commit made on that branch before the rebase). A final HEAD
  different from the restored one skips as indeterminate. The clean message
  states that Git status is clean and HEAD matches its pre-task value. A
  relative `autoCommit.repo` resolves against the original config file's
  directory, with the same environment-variable expansion as `workspace`, and
  the launch snapshot carries the absolute value; a relative value with no
  config file to anchor it is refused. Sender notices are attempts: a failed
  signed send is logged and acknowledgement is attempted.

  **`autoCommit.repo` is resolved only by the Codex runtime.** A Gemini or Claude Code launch neither resolves nor expands it, so an unset variable there cannot stop the launch; an empty YAML entry reads as absent, and the runtime's workspace fallback applies.
  **An empty or blank `autoCommit.repo` string is refused.** After environment expansion, a blank value names the field and the remedy: omit it to use the workspace, or give a path.
  **A rebase-path probe that does not return an absolute path is indeterminate.** A Git that does not support `--path-format` echoes the flag; auto-commit skips and reports the probe and its output.
  **An empty final `git rev-parse HEAD` read is indeterminate.** The gate skips and reports the probe instead of reading the empty value as a change.
