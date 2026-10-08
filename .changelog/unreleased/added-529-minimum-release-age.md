- **Add a 7-day release-age gate for dependency resolutions and locked external versions.**

  Bun refuses young versions at resolution time. `scripts/check-dep-ages.mjs` checks every
  external version in `bun.lock`; young versions require a dated exception in
  `docs/dep-age-exceptions.md`. Invalid exception lines fail the gate.
