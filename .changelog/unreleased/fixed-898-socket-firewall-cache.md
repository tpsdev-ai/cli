- **Cache the verified Socket Firewall binary so a cached CI job does not depend on the download host (Refs #898).**

  Jobs attempt to restore the verified binary with actions/cache before the
  pre-fetch and use it only when its sha256 still matches the pin; a cold cache
  downloads with a bounded exponential backoff. A binary that does not match
  the pin is never used.
