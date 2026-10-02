- **`github_review` refuses `APPROVE` without a host-recorded passing build/test record for the same reviewer, session and commit (Closes #426).**

  The record is written host-side to `approvalEvidenceFile`, which the sandbox
  cannot write or read-modify; `REQUEST_CHANGES` and `COMMENT` are unaffected.
  Its digest is recorded in the signed audit record. The evidence proves the
  repository's own build and tests ran and passed on that commit, not that they
  are adequate.
