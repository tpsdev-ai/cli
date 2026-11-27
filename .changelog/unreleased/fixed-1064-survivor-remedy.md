- **A kept launch names the path it kept and the step that removes it.** When a
  stop leaves a survivor, the message now prints the absolute launch-state
  directory, and the worktree when one was kept, plus the removal command (every
  path shell-quoted) to run once the named pids have exited. [#1076](https://github.com/tpsdev-ai/cli/pull/1076).
