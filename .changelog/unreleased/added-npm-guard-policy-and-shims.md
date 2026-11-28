- **Adds an npm/npx guard policy and shims, not yet wired into any CI job.** The
  policy allows only job-keyed argv shapes read from the current callers, plus
  the global `--version` and `-v` probes in any job; npx and every install shape
  it does not name are refused before spawning the recorded npm or starting an
  installation.
