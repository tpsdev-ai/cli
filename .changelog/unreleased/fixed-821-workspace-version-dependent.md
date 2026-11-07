- **When release-age exclusions are configured, the gate refuses workspace patterns whose meaning differs between Bun versions.**

  When `minimumReleaseAgeExcludes` is non-empty, `scripts/check-dep-ages.mjs`
  reads the root `package.json` `workspaces` patterns and refuses three shapes
  instead of modelling which manifests Bun applies: a `!`-negated pattern, a
  pattern mixing a `{...}` brace group with a `[...]` character class, and a
  pattern using glob syntax the gate does not model (a `(`, `)` or `|`
  outside a `[...]` class, an extended glob such as `+(...)`, or a brace range
  such as `{1..3}`). Bun 1.3.10 and 1.4.4
  install different workspace sets for some of these shapes, so the gate fails
  closed (exit 2), naming the root `package.json` and the pattern.
