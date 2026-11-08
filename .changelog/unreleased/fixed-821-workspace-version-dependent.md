- **With release-age exclusions, the gate refuses workspace patterns it cannot model: `!` negation, brace/class mixes, extglobs, `..` inside a brace group, and empty-alternative brace groups.**

  When `minimumReleaseAgeExcludes` is non-empty, `scripts/check-dep-ages.mjs`
  reads the root `package.json` `workspaces` patterns and refuses: a
  `!`-negated pattern, a
  pattern mixing a `{...}` brace group with a `[...]` character class, a
  pattern using glob syntax the gate does not model (a `(`, `)` or `|`
  outside a `[...]` class, an extended glob such as `+(...)`, or `..` inside a
  brace group such as `{1..3}`), and a brace group with an empty or `.`
  alternative at any nesting level (for example `packages/{a,}`). The gate
  fails closed (exit 2), naming the root `package.json` and the pattern.
