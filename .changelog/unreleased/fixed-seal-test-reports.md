- **A suite's JUnit report is checked against a checksum saved when the suite ends, to detect accidental changes after completion (cli#414).**

  Each launcher saves a checksum when its suite produces a JUnit report. The
  coverage guard fails if a required report or checksum is missing, or if the
  report does not match its saved checksum.

  (Refs #414)
