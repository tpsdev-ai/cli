- **The deploy bot and the channel bridge promote mail through `promote()` instead of writing `cur/` directly (Closes #380).**

  The deploy bot (`scripts/deploy-bot.ts` and its copy under
  `packages/cli/scripts/`) and the channel bridge's outbound consumer
  (`BridgeCore.watchOutbox`) moved `new/` records into `cur/` themselves. They
  now run every record through `promote()`, so a record that fails verification
  is dead-lettered instead of delivered, and a verifier outage leaves it
  re-driveable. `@tpsdev-ai/agent`'s `MailClient` no longer accepts an optional
  verifier: a client cannot be constructed without one, so there is no path that
  promotes unverified mail.

  A test reads the source tree for writes whose destination is a `cur`
  directory and fails on any that is not on an explicit list, so a new bypass is
  red rather than conventional.
