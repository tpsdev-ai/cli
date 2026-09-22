- **A raw `NO_REPLY` final is an immediate empty-final failure, not a 60-minute yield.**

  On a host that delivers the silent token verbatim (`2026.5.7` with
  `surfaces["tps-mail"].silentReplyRewrite.direct = false`), `deliver` returned
  on a non-postable final without recording it, so a turn whose only final was
  `NO_REPLY` armed the 60-minute deadline and failed as
  `yielded-without-resumption` instead of `empty-final-text`. `deliver` now
  records the silent final, and the `empty-final-text` branch also requires that
  no real final was seen, so a turn that POSTED a real final whose receipt is
  absent still follows the posted-without-receipt path.

  (Refs #398)
