- **The cli test guard scans every cli test file bun discovers, and its patch
  factory refuses a patch made after cleanup ran.**
  The mock-restore scan discovers the cli package's test files by bun's own
  rule — `.test`/`_test`/`.spec`/`_spec` before a js-ish extension, with bun's
  skip rules — rather than a hand-kept `*.test.ts` glob, so a file in another
  discovered form is scanned instead of escaping; a run also fails when a file
  bun loaded is not in the scanned set. A name destructured out of a guarded
  global root (`const { process } = globalThis`) is treated as that root, while
  a name destructured out of `process.env` is not. Module-object and guarded-root
  aliases are resolved by lexical scope, so a local that shadows a name is not
  the guarded target. `createPatchShared`'s factory throws
  `PatchAfterCleanupError` for a patch requested after its cleanup hook ran,
  instead of leaving it unrestored.
