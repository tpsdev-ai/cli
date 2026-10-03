- **For CLI signed-inbox delivery, promote() is the only first-delivery writer of cur/; updates to existing records are enumerated, with presentation separately gated (Closes #380).**

  The deploy bot (`scripts/deploy-bot.ts` and its copy under
  `packages/cli/scripts/`) and the channel bridge's outbound consumer
  (`BridgeCore.watchOutbox`) moved `new/` records into `cur/` themselves.
  Failed verification refuses delivery and attempts dead-lettering. Each also re-drives retryable `dlq/`
  entries: the deploy bot on every poll, the bridge at a configurable
  interval, defaulting to 30 seconds.
  `@tpsdev-ai/agent`'s `MailClient` throws when constructed without a verifier,
  and runs the same mailbox policy and consumed-id replay store as `promote()`,
  which now live in `@tpsdev-ai/agent`.

  The source scan enumerates eleven sites, including MailClient's shared-policy
  delivery, staging, updates, and the separate outbox and internal-mail stores.
