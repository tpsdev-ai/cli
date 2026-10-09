- **cli test mock assignments require `patchShared`; inline restoration is refused.** The static
  scan rejects assignments of `mock(...)`, `spyOn(...)` results, `mock.module(...)`,
  and file-local aliases of those results to identifiers or members, including
  parentheses, casts, nested and computed members. Unclassified mock targets fail
  with `unclassified-assignment-target`. Members rooted at `globalThis`, `global`,
  `console`, `Date`, `process` (except plain `process.env` writes), or imports also
  require the helper. Runtime snapshots check `globalThis.fetch`,
  `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `setImmediate`,
  `clearImmediate`, `queueMicrotask`, `Date.now`, `process.exit`, `console.log`,
  `console.error`, and `console.warn` for changes left after a file.
