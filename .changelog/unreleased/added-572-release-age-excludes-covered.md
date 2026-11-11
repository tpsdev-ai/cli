- **Release-age exclusions need unexpired dated exceptions.**
  CI reads `minimumReleaseAge` and `minimumReleaseAgeExcludes` with Bun's TOML parser. It fails when Bun cannot
  be run or rejects bunfig.toml, and when the threshold is missing, not a non-negative number, or below 7 days.
  Each excluded name needs an unexpired dated entry and an exact declaration. Its declarations in dependencies,
  devDependencies, optionalDependencies, peerDependencies and the root package.json's overrides must be exact
  pins; its override in a nested package.json, and a `resolutions` key of its name or `**/` and its name, are
  refused. Outside node_modules and .git, it follows in-root manifest and directory symlinks and refuses outside-root links.
  When `minimumReleaseAgeExcludes` is non-empty, the gate also refuses root `workspaces` patterns it cannot model
  (`!` negation, extended globs, `..` or empty alternatives in a brace group, brace/class mixes); it exits 2 naming
  the pattern. `docs/dep-age-exceptions.md` lists the refused shapes.
