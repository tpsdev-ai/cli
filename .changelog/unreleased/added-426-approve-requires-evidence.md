- **`github_review` refuses `APPROVE` without an authenticated, passing evidence record for the same repository, PR, dispatch, reviewer, session, commit and configured CI job (#426).**

  `scripts/reviewer/run-review-jobs.mjs` writes the record when given the
  evidence arguments: each job's planned `run:` scripts and its launcher's exit
  status as `docker exec` returned it. `APPROVE` is also refused unless the store
  and its key resolve outside every `sandboxMountRoots` path. `REQUEST_CHANGES`
  and `COMMENT` are unaffected. Its digest is recorded in the audit draft and in
  an acknowledged signed audit record when that write succeeds.
