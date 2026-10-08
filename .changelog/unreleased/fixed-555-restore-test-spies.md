- **A guard fails a cli test file that does not restore the shared state it registers.** A
  `mock.module` call is rejected — a teardown restore cannot undo one — and a
  `spyOn` or a `process.env` name set in a `before*` hook must be covered by a
  reachable restore.
