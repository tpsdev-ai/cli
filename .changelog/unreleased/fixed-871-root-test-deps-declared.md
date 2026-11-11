- **The root manifest declares `js-yaml`, `@noble/ed25519` and the workspace
  agent package that root tests and scripts import.** A root `bun install`
  now provides them directly instead of relying on the hoisted workspace
  tree, and `test/root-imports-declared.test.ts` fails when a root test or
  script imports an undeclared package by a literal specifier.
