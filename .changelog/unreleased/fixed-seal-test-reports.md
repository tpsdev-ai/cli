- **A suite's JUnit report is checked against a checksum saved when the suite ends, to detect accidental changes after completion (cli#414).**

  Every launcher writes `test-reports/<suite>.xml.sha256` when its suite exits
  — the SHA-256 of the report's bytes and the suite's own name — and reads it
  back once to confirm the write. The coverage guard checks each report against
  its suite's saved checksum to detect accidental changes after completion; the
  checksum is a consistency check within the job's shared filesystem. A report
  changed after its suite ended, a report with no checksum file, or a checksum
  file naming another suite fails the build, naming the suite and which
  condition failed.

  (Refs #414)
