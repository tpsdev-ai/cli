- **Cache the verified Socket Firewall binary so a download-host outage does not fail every CI job (Refs #898).**

  Jobs restore the verified binary with actions/cache before the pre-fetch and
  use it only when its sha256 still matches the pin; a cold cache downloads with
  a bounded exponential backoff. A binary that does not match the pin is never
  used.
