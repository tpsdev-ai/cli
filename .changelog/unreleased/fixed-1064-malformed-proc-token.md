- **A recorded `proc:` start token that differs from the live one and is malformed is unverifiable, not pid reuse.** A `proc:` token counts
  only when its value is an unsigned decimal integer, the shape
  `processStartToken` writes, so a live owner is not reclaimed because of a
  differing malformed recorded value.
