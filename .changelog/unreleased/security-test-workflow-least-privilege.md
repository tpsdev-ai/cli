- **Jobs in `.github/workflows/test.yml` declare explicit permissions and disable checkout credential persistence; CodeQL alone receives SARIF-upload write permission.**

  The workflow's top level grants nothing. `.github/workflows/smoke.yml` keeps
  its workflow-level `contents: read` and is recorded as not yet held to this
  shape.

  (Refs tpsdev-ai/cli#412)
