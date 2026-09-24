- **The receipts store is read by direct path only, and lives with the agent that owes it.**

  (cli#389 rounds 4-5.) The receipt scan takes its inputs in two kinds: the
  receipts store is read ONLY by its direct `<obligation-id>.json` path and never
  listed, while the route's posted-record directories (the maildir `new`/`cur`,
  the bridge sandbox, the outbox) remain the only ones walked. An unreadable file
  in the receipts store can therefore never be read as a failed delivery.

  The store is no longer host-wide. It now lives inside the REPLYING agent's own
  obligation store, so that agent's retention sweep sees only receipts belonging
  to obligations it can look up and keys each one on the obligation id: a live
  obligation keeps its receipt, a terminal obligation's receipt goes, and a
  receipt whose obligation is gone goes once it has aged past the window (an
  orphan). A receipt with no readable timestamp is never aged out.

  (Refs #389)
