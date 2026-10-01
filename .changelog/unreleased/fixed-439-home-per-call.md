- **Paths that 12 modules built from the home directory at import are now
  resolved per call (cli#439).** `office-health`, `status`, `bootstrap`,
  `auth-proxy` and the agent package's `llm/provider` built them from
  `process.env.HOME || homedir()`, and `flair`, `flair-sync`, `pat-rotate`,
  `pulse`, `flair-task-loop`, `llm-proxy` and `mail-relay` from `homedir()`, so
  a test or a long-lived process that changed `HOME` afterwards kept the path
  from the import. These modules now ask the shared `homeDir()` helper — `HOME`
  when set and non-empty, else `os.homedir()` — where they use a path, and no
  longer call `homedir()` or read `HOME` themselves: `flair-sync`, `llm-proxy`
  and `mail-relay` now create a directory under the same home as the file they
  write into it.
