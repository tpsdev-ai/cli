- **The cli test guard resolves a module-object alias by its binding.** A
  parameter or local that shadows an imported namespace is no longer reported,
  and a guarded-global or module-object alias ends at the assignment that
  rebinds it to a local value.
