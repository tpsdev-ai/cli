- **The root manifest declares `js-yaml`, `@noble/ed25519` and the workspace
  agent package that root tests and scripts import.** A root `bun install`
  now provides them directly instead of relying on the hoisted workspace
  tree, and `test/root-imports-declared.test.ts` fails when a `.ts`, `.tsx`, `.js`,
  `.jsx`, `.mjs` or `.cjs` file under `test/` or `scripts/` imports an
  undeclared package by a literal specifier, or loads one by a literal argument
  through a `createRequire(...)` result held in a variable or called directly,
  `module.require` or `process.mainModule.require`. `require` and `mainModule`
  may be written as a property access or as an element access with a
  string-literal name (`module["require"]`), and a `createRequire(...)`
  initializer may be parenthesised.

  These forms are not checked with a non-literal argument. A type-only import
  (`import type`) is removed before the scan and is not checked. A
  `createRequire` result is not followed outside a variable declaration or
  assignment, through a renamed import (`import { createRequire as cr }`),
  through another expression (`require("node:module").createRequire(...)`) or
  through `.call`/`.apply`; a `module` or `process.mainModule` reached through
  another binding is not followed. `require.resolve` and a non-literal
  `import(name)` are not checked either.
