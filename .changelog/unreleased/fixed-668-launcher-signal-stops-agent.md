- **A signal to the sandboxed launcher is passed on to the nono supervisor, and the released agent is then checked.**

  A SIGINT, SIGTERM or SIGHUP is forwarded as received; the supervisor gets SIGKILL if it has not exited within the bound. The launcher never signals the agent's pid; it reads the identity captured before the release.
