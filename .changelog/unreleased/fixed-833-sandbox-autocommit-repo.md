- **A sandboxed Codex launch refuses an `autoCommit.repo` outside the launch-option
  paths checked** (workdir, cwd, `--allow` directories and exact `--allow-file`
  files). Profile-only `filesystem.allow` / `filesystem.write` grants are not
  consulted. The refusal names the repository, the launch-option paths checked
  and the remedy (put the repository under the workspace, or run that agent
  without the sandbox).
