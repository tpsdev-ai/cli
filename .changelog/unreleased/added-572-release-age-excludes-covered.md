- **Release-age exclusions need unexpired dated exceptions.**
  Their declarations in dependencies, devDependencies, optionalDependencies,
  peerDependencies and overrides must be exact pins. Outside node_modules and .git, it follows in-root manifest and
  directory symlinks and refuses outside-root links. Excludes use `Bun.TOML.parse` under Bun;
  Node refuses unsupported forms.
  A real-Bun test covers install-time refusal and the exclusion that admits a young version.
