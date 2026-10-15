- **A real-Flair CI lane: a scratch Harper-served Flair and the first tests across the Flair seam.**
  `scripts/real-flair-lane.ts` installs the published `@tpsdev-ai/flair`, boots a
  Harper on OS-chosen loopback ports with an isolated HOME and a short-root data
  dir, seeds one operator and two agents, and runs every test file carrying the
  `TPS_TEST_REAL_FLAIR=1` opt-in before tearing the instance down. The lane runs on
  `main` and, on pull requests, only when a Flair-facing file changes.
