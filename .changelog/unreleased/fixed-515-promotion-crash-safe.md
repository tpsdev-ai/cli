- **An interrupted first delivery no longer dead-letters verified mail as a replay (Closes #515).**

  `promote()` reconciles a first delivery a prior process left unfinished — a
  `cur/` copy linked but never committed — before the replay gate reads it, and
  the native `MailClient` resolves the sender's trust tier before it moves a
  record into `cur/`.
