- **A sandboxed launch refuses an `autoCommit.repo` outside the sandbox's
  write grants.** The refusal names the repository, the granted paths and the
  remedy (put the repository under the workspace, or run that agent without
  the sandbox); the launch never adds or widens a grant.
