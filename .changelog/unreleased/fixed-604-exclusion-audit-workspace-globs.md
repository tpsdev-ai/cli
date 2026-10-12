- **Release-age exclusion audit refuses workspace patterns it does not mirror.**
  A `workspaces` pattern carrying a backslash (`packages/\*`), or mixing a brace
  group with a character class (`{a,[bc]}`, `[a-c]{x,y}`), resolves differently in
  Bun 1.3.10 than in the audit's walk — measured against real Bun installs. The
  audit now refuses both shapes, naming the pattern, instead of crediting a pin
  from a manifest Bun does not apply. Real-Bun parity rows cover each shape.
