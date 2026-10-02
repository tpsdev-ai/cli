- **`github_review` refuses `APPROVE` without a host-recorded, host-authenticated passing build/test record for the same repository, PR, dispatch, reviewer, session and commit (Closes #426).**

  The record is written host-side to `approvalEvidenceFile` from what the host
  observed, and authenticated with a host-held key the sandbox cannot read;
  `REQUEST_CHANGES` and `COMMENT` are unaffected. Its digest is recorded in the
  audit draft and in an acknowledged signed audit record when that write
  succeeds. The evidence records the commands the host ran for the job, and their
  exit statuses, not that they are adequate.
