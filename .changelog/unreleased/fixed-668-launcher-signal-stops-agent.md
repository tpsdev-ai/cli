- **A signal to the sandboxed launcher stops the nono supervisor through its child handle and never signals the agent's pid.**

  It then reads the released agent's identity read-only; when the agent is still present or its identity cannot be read it keeps the worktree and exits non-zero.
