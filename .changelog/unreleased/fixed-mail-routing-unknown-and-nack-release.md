- **An unknown recipient is refused by `tps mail send` too, and an abandoned owed nack is released (cli#389 round 13).**

  Three follow-ups on the durable nack and the one locality rule.

  **An unknown recipient is a named failure on BOTH importers.** The shared rule already treated an `unknown` recipient (no GAL, no binding, no maildir, no branch-office bridge) as a named failure, but `tps mail send` guarded only `failed` and fell through to a local write — creating `~/.tps/mail/<to>/new/` for a name nothing reads, exiting 0, and (because directory existence is a local signal on the office) reclassifying that typo as local on the next decision. The CLI now refuses `unknown` with a named error naming the fix, exits non-zero, and writes nothing (and creates no directory).

  **The owed-nack hold multiple must be at least 1.** A multiple in (0,1) made the hold shorter than the retention window, so an owed record was abandoned, kept by retention, and abandoned (and logged) again on every sweep while the startup retry kept firing for a debt nobody would pay. A value below 1 is now rejected with a named log and the default is used.

  **Abandoning an owed nack releases the debt.** The abandonment write now clears `nackPending` and records `nackAbandonedAt` in the same write, so an owed nack past its hold is abandoned exactly once and the startup retry stops for that record.

  **The verb checks the transition's refusal.** The `unconfirmed` and `failed` writes now check `transitionObligation`'s null refusal, exactly as the ack path does: a refused transition stamps nothing and sends no nack mail.
