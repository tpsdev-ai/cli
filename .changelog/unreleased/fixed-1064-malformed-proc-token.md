- **A malformed recorded `proc:` start token is unverifiable, not pid reuse.** A `proc:` token counts
  only when its value is an unsigned decimal integer, the shape
  `processStartToken` writes, so a live owner is not reclaimed on a
  corrupt recorded value.
