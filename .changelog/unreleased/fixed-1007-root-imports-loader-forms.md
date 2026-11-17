- **The root-imports check reports packages loaded through `createRequire`, `module.require` or `process.mainModule.require`, and no longer flags `file:` or `data:` specifiers.**

  A literal argument in the forms listed in the header of `scripts/lib/root-imports-declared.mjs` is checked; any other form, including a non-literal argument, is not.
