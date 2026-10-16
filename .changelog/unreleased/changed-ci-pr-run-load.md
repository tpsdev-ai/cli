- **Superseded pull-request runs are cancelled once a replacement starts, and smoke runs linux-x64 only on a pull request.**

  A newer push cancels a pull request's pending or in-progress run of these
  workflows, once that push starts a run. Smoke starts a pull-request run only
  when its path filter matches; a push to main keeps all four targets.

  A pull request's runs of either workflow share that workflow's group, so
  cancellation follows the order in which runs enter it: a manual re-run of an
  older run enters the group again and cancels the current head's run, which then
  needs re-running, and a stale run's results appear only on its own commit,
  never on the PR head.
