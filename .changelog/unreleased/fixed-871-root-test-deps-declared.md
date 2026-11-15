- **The root manifest declares `js-yaml`, `@noble/ed25519` and the workspace
  agent package that root tests and scripts import.** A root `bun install`
  now provides them directly instead of relying on the hoisted workspace
  tree, and `test/root-imports-declared.test.ts` fails when a `.ts`, `.tsx`, `.js`,
  `.jsx`, `.mjs` or `.cjs` file under `test/` or `scripts/` imports an
  undeclared package by a literal specifier, or loads one by a literal argument
  through `require`, a `createRequire(...)` result, `module.require` or
  `process.mainModule.require`. The header of
  `scripts/lib/root-imports-declared.mjs` states the exact rule: the loader
  forms the check reads, and that any other form is not checked.
