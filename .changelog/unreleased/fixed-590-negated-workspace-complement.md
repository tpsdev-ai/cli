- **The release-age exclusion audit applies Bun's negation of a workspace pattern.**
  Bun negates only a `!` pattern's first path segment, so `["!packages/*"]` and
  `["packages/*", "!packages/*"]` install the workspaces outside `packages/*` at that
  pattern's depth. The audit contributed none of them, so an exact pin there could only be
  over-reported as `unused-manifest`; it now applies them. Real-Bun parity rows cover both
  shapes and a negated literal, which is unchanged.
