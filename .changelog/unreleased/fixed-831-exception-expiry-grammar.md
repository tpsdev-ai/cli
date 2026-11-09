- **Malformed single-token expiry spellings now receive `invalid expiry date: <value>`.**

  They were already refused, as a generic malformed exception; impossible
  calendar dates already received the specific diagnostic. The expiry grammar
  (a four-digit year and a real calendar day, compared by UTC day) is now
  pinned by tests.
