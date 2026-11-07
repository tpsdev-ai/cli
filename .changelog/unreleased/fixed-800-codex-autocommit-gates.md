- **The codex runtime's mail-task auto-commit probes the configured commit repository, resets after a rebase abort, and says what it established.**

  The runtime resolves `autoCommit.repo ?? workspace` once and runs every Git
  probe and the rebase abort there. An interrupted rebase is detected with
  `git rev-parse --path-format=absolute --git-path`; a failed probe skips
  auto-commit and reports it. A successful abort resets the comparison to the
  restored HEAD. Skip and clean messages state that Git status is clean and HEAD
  matches its pre-task value (or the restored value), and sender notices are
  attempts: a failed signed send is logged and the mail is still acknowledged.
