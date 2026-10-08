- **cli test files: a guard checks spy and module-mock teardown, and a test preload checks process.env.** A test
  file that contains `spyOn`, `mock`, `jest` or `vi` as an identifier fails the
  guard unless a top-level statement registers `afterEach(() => { mock.restore(); })`
  or `afterEach(() => mock.restore())`, with `afterEach` and `mock` imported from
  `bun:test`; a test file that calls `mock.module()` fails it. The preload
  appends an `afterAll` hook to each `.test`/`.spec` file bun loads, which fails
  the file when `process.env` differs from when bun loaded it, naming the names
  added, removed or changed.
