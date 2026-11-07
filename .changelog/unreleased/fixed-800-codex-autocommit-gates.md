- **The codex runtime's mail-task auto-commit keeps the pre-task baseline across a stale-rebase abort and resolves `autoCommit.repo` like `workspace`.**

  The runtime resolves `autoCommit.repo ?? workspace` once and runs the mail auto-commit gate's Git
  probes and the rebase abort there. An interrupted rebase is detected with
  `git rev-parse --path-format=absolute --git-path`; a failed probe skips
  auto-commit and reports it. A successful abort keeps the pre-task baseline, so
  a restored HEAD that differs from it is evidence of the task's commits and
  auto-commit runs. The clean message states that Git status is clean and HEAD
  matches its pre-task value. A relative `autoCommit.repo` resolves against the
  config file's directory, the same base as `workspace`; a relative value with
  no config file to anchor it is refused. Sender notices are attempts: a failed
  signed send is logged and acknowledgement is attempted.
