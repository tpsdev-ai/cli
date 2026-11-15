- **The root-imports check reports packages loaded through `createRequire`, `module.require` or `process.mainModule.require`, and no longer flags `file:` or `data:` specifiers.**

  A literal argument in those forms is checked; a non-literal argument is not.
