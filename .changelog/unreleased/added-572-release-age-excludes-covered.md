- **Release-age exclusions need unexpired dated exceptions.**
  CI reads `minimumReleaseAge` and `minimumReleaseAgeExcludes` with Bun's TOML parser. It fails when Bun cannot
  be run or rejects bunfig.toml, and when the threshold is missing, not a non-negative number, or below 7 days.
  Each excluded name needs an unexpired dated entry and an exact declaration. Its declarations in dependencies,
  devDependencies, optionalDependencies, peerDependencies and the root package.json's overrides must be exact
  pins; its override in a nested package.json, and a `resolutions` key of its name or `**/` and its name, are
  refused. Outside node_modules and .git, it follows in-root manifest and directory symlinks and refuses outside-root links.
  Real-Bun tests cover install-time refusal, the exclusion that admits a young version, and overrides and
  resolutions of an excluded transitive dependency.
