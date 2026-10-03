- **A selected runtime's custom directory and every directory grant a launch passes are refused when they overlap a TPS credential root (Closes #483).**

  `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and the gemini directory under
  `XDG_CONFIG_HOME` are compared as canonical paths, symlinks resolved, against
  `~/.tps/auth`, `~/.tps/identity` and `~/.tps/secrets`; a directory that equals,
  contains or sits inside one refuses the sandboxed launch before any runner
  starts, naming the variable and the overlapping root. The workdir, the
  current-directory grant and the read and writable directory grants are checked
  the same way, so a runtime profile does not reach another runtime's
  credentials.
