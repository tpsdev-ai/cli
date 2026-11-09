- **Cache the verified Socket Firewall binary so a cached CI job does not depend on the download host (Refs #898).**

  Jobs attempt to restore the verified binary with actions/cache before the
  pre-fetch and use it only when the checksum tool found on the job's PATH
  reports the pinned sha256; a cold cache downloads with a bounded exponential
  backoff. A binary whose checksum does not match is discarded.
