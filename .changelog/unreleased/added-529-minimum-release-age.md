- **Add a 7-day release-age gate for fresh range resolutions and locked non-workspace versions.**

  Bun filters fresh range resolutions. `scripts/check-dep-ages.mjs` checks locked
  non-workspace versions; young versions require a dated exception in
  `docs/dep-age-exceptions.md`. Invalid exception lines fail the gate.
