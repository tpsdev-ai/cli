- **The release-age exclusion audit reads workspace patterns in both shapes Bun accepts.**

  The root `package.json` `workspaces` field is an array of strings or an object
  with a `packages` array; any other shape is refused with a named error. Workspace
  patterns also support character classes (`packages/[ab]`) and brace alternatives
  (`packages/{a,b}`), and a directory named by a literal pattern stays applied when
  a later `!` pattern names it.
