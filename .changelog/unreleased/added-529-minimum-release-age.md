- **Add a 7-day release-age gate: bun's `minimumReleaseAge` skips fresh versions, and CI fails when `bun.lock` resolves one without a dated exception.**

  Bun's `minimumReleaseAge` skips a freshly-published version when it resolves a
  range; `scripts/check-dep-ages.mjs` reads the versions `bun.lock` resolved and
  fails when one is younger than that same gate. A version is let through only
  by a dated entry in `docs/dep-age-exceptions.md`; an undated or expired entry
  fails the gate instead of exempting.
