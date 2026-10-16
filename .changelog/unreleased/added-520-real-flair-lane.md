- **A real-Flair CI lane.**
  Runs the named test files: memory and registration
  cases, the mail Agent-read guards and the Presence contract (a capped task
  served to a signed reader, and a refused Bearer token). A guard scans repository
  `*.test.ts` and `*.test.js` files outside `node_modules` and `dist`; any reference
  to `TPS_TEST_REAL_FLAIR` requires lane naming and workflow path coverage.
  Named files must have at least one expected case.
  The lane runs against `@tpsdev-ai/flair@0.58.0` on Harper.
  Its workflow is guarded: the permission inventory in `workflow-permissions.test.ts`
  records it and the four least-privilege rules run on it as on `test.yml`.
