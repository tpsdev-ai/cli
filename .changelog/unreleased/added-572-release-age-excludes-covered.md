- **Release-age exclusions need unexpired dated exceptions.**
  CI reads `minimumReleaseAgeExcludes` with Bun's TOML parser, and fails when Bun cannot be run or rejects
  bunfig.toml. Each excluded name needs an unexpired dated entry and an exact declaration. Its declarations in
  dependencies, devDependencies, optionalDependencies, peerDependencies and the root package.json's overrides must
  be exact pins, and its override in a nested package.json is refused. Outside node_modules and .git, it follows
  in-root manifest and directory symlinks and refuses outside-root links.
  Real-Bun tests cover install-time refusal, the exclusion that admits a young version, and an override in the root
  and in a workspace package.json.
