- **The cli test guard flags a patch to a guarded target, whatever the value.**
  The mock-restore scan decides by the assignment's target, not only by tracking
  a mock value: an assignment to a member of an imported module object, or to a
  guarded global (`globalThis.*`, `Date.*`, `process.*` except `process.env`,
  `console.*`, `Bun.*`, and the bare snapshot names such as `fetch`), must go
  through `patchShared` however the value was computed. A destructured or
  property-derived alias no longer hides such a patch, and a name that an
  enclosing scope declares is not treated as the global. An alias of a guarded
  global root is treated as that root.
  An assignment whose member target cannot be resolved to a root (for example
  `getG().fetch = ...`) is reported as `unclassified-assignment-target` whatever
  the right-hand side. A module object bound by a dynamic `import()` is treated
  like an imported one.
