- **The Docker Integration lane fails, instead of skipping, when the root-only set-runtime real-owner case loses a prerequisite (Closes #801).**

  The lane's `test` service sets `TPS_TEST_REQUIRE_REAL_OWNER=1`; a missing
  prerequisite then fails the case and names it. Other lanes keep the skip
  with the same reason.
