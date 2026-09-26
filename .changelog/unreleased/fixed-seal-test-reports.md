- **A suite's JUnit report is sealed the moment the suite ends, so a later step cannot replace it (cli#414).**

  Every launcher now writes `test-reports/<suite>.xml.sha256` when its suite
  exits — the SHA-256 of the report's bytes and the suite's own name — and reads
  it back once to confirm the write; the coverage guard verifies each required
  suite's seal before it reads that suite's report, so a report changed after
  the suite ended, a report with no seal, or a seal naming another suite fails
  the build, naming the suite and which condition failed.

  (Refs #414)
