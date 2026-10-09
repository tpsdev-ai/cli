- **A release-age exclusion now requires an unexpired dated exception and an exact pin.**
  `scripts/check-dep-ages.mjs` fails when a name in bunfig's `minimumReleaseAgeExcludes` has no
  unexpired entry in `docs/dep-age-exceptions.md`, or is declared with a range instead of a bare
  version in a `package.json` that lists it. A real-Bun test covers the install-time refusal of a
  too-young version and the exclusion that admits it.
