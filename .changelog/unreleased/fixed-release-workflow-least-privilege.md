- **Each job in the release workflow is granted only what its steps use, and only the publishing job can mint an OIDC token.**

  `.github/workflows/release.yml` declared `contents: write` and
  `id-token: write` at the top level, so EVERY job in a release — including the
  binary build and the compiled-binary smoke test — could write to the
  repository and mint an OIDC token for the npm trusted publisher. The top level
  now grants nothing, and each job declares its own block, read from its steps:
  `contents: read` for the preflight, the binary build, the smoke test and the
  publishing job; `id-token: write` ONLY on the publishing job, whose
  `npm stage publish` step is the one call that trades an OIDC token for an npm
  credential; and `contents: write` ONLY on the job whose
  `softprops/action-gh-release` step creates the release. Artifact upload and
  download transfer within the run, so they need no scope of their own. A test
  reads the workflow and fails if the top level grants anything, if a job other
  than the publishing one holds `id-token`, if a job's grants widen, or if a job
  appears with no permissions block of its own.

  (Refs tpsdev-ai/flair#1890)
