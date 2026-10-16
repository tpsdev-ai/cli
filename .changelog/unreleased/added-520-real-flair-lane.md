- **A real-Flair CI lane.**
  Runs the test files gated on `TPS_TEST_REAL_FLAIR=1`: memory and registration
  cases, the mail Agent-read guards and the Presence contract (a capped task, a
  lowercase signed header and a refused Bearer token). A guard test refuses a
  gated file the lane does not name or the workflow paths do not cover.
  The lane runs against `@tpsdev-ai/flair@0.58.0` on Harper.
  Its workflow is guarded: the permission inventory in `workflow-permissions.test.ts`
  records it and the four least-privilege rules run on it as on `test.yml`.
