- **The release-age exclusion audit counts the declarations Bun applies.**

  An excluded name needs its exact pin in the root `package.json` (a dependency
  section or `overrides`) or in a dependency section of a manifest the root
  `workspaces` patterns name. A name pinned only in a manifest Bun does not apply
  is refused, naming that manifest.
