- **The deploy bot and the channel bridge promote mail through `promote()` instead of writing `cur/` directly (Closes #380).**

  The deploy bot (`scripts/deploy-bot.ts` and its copy under
  `packages/cli/scripts/`) and the channel bridge's outbound consumer
  (`BridgeCore.watchOutbox`) moved `new/` records into `cur/` themselves. They
  now run every record through `promote()`, so a record that fails verification
  is dead-lettered instead of delivered. Each also re-drives retryable `dlq/`
  entries: the deploy bot on every poll, the bridge every 30 seconds.
  `@tpsdev-ai/agent`'s `MailClient` throws when constructed without a verifier,
  and runs the same mailbox policy and consumed-id replay store as `promote()`,
  which now live in `@tpsdev-ai/agent`.

  A test scans the source tree for writes into a `cur` directory (its header
  states what the scan sees) and fails on any that is not on an explicit list.
