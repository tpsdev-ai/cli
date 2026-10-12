- **The cli restore guard uses shared test discovery and refuses patches after cleanup.**
  Discovery uses `discoverTestFiles` over the cli package root. The loaded-set
  assertion checks files recorded by the preload when the assertion runs.
  Guarded-root aliases preserve selected properties in object bindings with
  identifier or string-literal keys, including nested bindings; computed keys
  and array bindings are out of scope. Values extracted from `process.env`
  are not guarded-root aliases. Aliases resolve through lexical scopes,
  including hoisted `var` bindings. Files parse according to their extension.
  The patch factory throws `PatchAfterCleanupError` after cleanup ran.
