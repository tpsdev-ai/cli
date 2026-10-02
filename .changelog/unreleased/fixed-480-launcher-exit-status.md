- **The `tps` launcher propagates the platform binary's real exit status instead of rerunning the command and reporting a missing binding.**

  A command that runs and exits non-zero now keeps that status and prints nothing
  extra. The JS fallback and the reinstall banner are reached only when the
  platform binary could not be started (Closes #480).
