- **Home-relative paths are resolved per call, not once when a module loads
  (cli#439).** Modules that keep state under `~/.tps` (`office-health`, `status`,
  `bootstrap`, `auth-proxy`, and the agent package's `llm/provider`), or under
  `homedir()` alone (`flair`, `flair-sync`, `pat-rotate`, `pulse`,
  `flair-task-loop`, `llm-proxy`, `mail-relay`), built those paths at import
  time, so a test or a long-lived process that changed `HOME` afterwards kept the
  path from the import. Each now asks the shared `homeDir()` helper — `HOME` when
  set and non-empty, else `os.homedir()` — at the point of use.
