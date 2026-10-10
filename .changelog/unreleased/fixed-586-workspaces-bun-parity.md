- **The release-age exclusion audit reads workspace patterns in both shapes Bun accepts.**

  The root `package.json` `workspaces` field is an array of strings or an object
  with a `packages` array; when the bunfig has release-age exclusions, any other
  shape is refused with a named error, and so is a pattern whose class cannot
  compile (`packages/[z-a]`). Workspace patterns also support character classes (`packages/[ab]`) and brace alternatives
  (`packages/{a,b}`), and a directory named by a literal pattern stays applied when
  a later `!` pattern names it.
