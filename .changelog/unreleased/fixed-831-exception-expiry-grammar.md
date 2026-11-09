- **A dep-age exception with a malformed expiry is refused as `invalid expiry date: <value>`.**

  Such a line was already refused, as a generic malformed exception. The expiry
  grammar (a four-digit year and a real calendar day, compared by UTC day) is
  now pinned by tests.
