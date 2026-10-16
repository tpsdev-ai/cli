- **Superseded pull-request runs are cancelled once a replacement starts, and smoke runs linux-x64 only on a pull request.**

  A newer push cancels a pull request's pending or in-progress run of these
  workflows, once that push starts a run. Smoke starts a pull-request run only
  when its path filter matches; a push to main keeps all four targets.

  A manual re-run of an older PR run cancels the current head's run only while
  that run is pending or in progress; a replacement head run may then be needed.
  A stale run does not supply a completed check for the current head.
