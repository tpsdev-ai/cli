- **A real-Flair CI lane.**
  Adds memory and registration cases alongside the existing real-Flair tests.
  The lane runs against `@tpsdev-ai/flair@0.58.0` on Harper.
  Its workflow is guarded: the permission inventory in `workflow-permissions.test.ts`
  records it and the four least-privilege rules run on it as on `test.yml`.
