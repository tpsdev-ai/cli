- **cli test files: the guard also checks that a direct assignment to a shared object is restored.** A cli
  test file that assigns to a global other than a `globalThis` name the runtime preload
  checks, or to a property of an imported module object, fails the guard unless it uses
  the `patchShared` helper, which saves the original and restores it in a top-level
  `afterAll`. `mock.restore()` does not undo such an assignment (measured on bun 1.3.10).
  The preload now also snapshots the well-known globals per file — `globalThis.fetch`,
  the timer family, `Date.now`, `process.exit` and the `console.log`/`console.error`/`console.warn`
  methods — and fails a file that left one changed, naming it.
