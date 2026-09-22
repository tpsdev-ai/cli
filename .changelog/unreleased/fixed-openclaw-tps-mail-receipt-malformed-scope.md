- **An unrelated quarantined record no longer fails every later non-posting turn.**

  The receipt scan reports `malformed` for ANY `.malformed-*` in the scanned
  dirs, and its marker cannot be read, so it cannot be tied to this obligation.
  The plugin took that branch BEFORE the post-failure / silent-final / yield
  branches and without checking whether THIS turn had posted, so one quarantined
  record made every later turn that posted nothing fail at once as
  `receipt-malformed` — yields never armed and the real reason was overwritten.
  The branch now fires only when this turn posted.

  (Refs #398)
