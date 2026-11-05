- **The branch test-pause seam requires the launcher's root marker token and a pause directory inside that root.**
  A stray `TPS_BRANCH_TEST_PAUSE_DIR` with a hand-set `TPS_TEST_ROOT` no longer pauses a
  branch daemon, and a pause directory outside `TPS_TEST_ROOT` is ignored.
