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
