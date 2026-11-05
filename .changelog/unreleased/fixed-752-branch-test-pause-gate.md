- **The branch test-pause seam requires a marker token matching the test root's marker file and a pause directory inside that root.**
  A stray `TPS_BRANCH_TEST_PAUSE_DIR` with a hand-set `TPS_TEST_ROOT` and no matching token
  no longer pauses a branch daemon, and a pause directory outside `TPS_TEST_ROOT` is ignored.
