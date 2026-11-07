- **The release-age gate refuses workspace patterns whose meaning differs between Bun versions.**

  `scripts/check-dep-ages.mjs` refuses a `!`-negated `workspaces` pattern, and
  patterns mixing a brace group with a character class, instead of modelling
  which manifests Bun applies. Bun 1.3.10 and 1.4.4 install different workspace
  sets for some of these shapes, so the gate fails closed (exit 2), naming the
  root `package.json` and the pattern.
