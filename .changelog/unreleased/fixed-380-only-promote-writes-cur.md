- **Breaking: updates touch only existing records, and `MailClient` requires a verifier (Closes #380).**

  The deploy bot (`scripts/deploy-bot.ts` and its copy under
  `packages/cli/scripts/`) and the channel bridge's outbound consumer
  (`BridgeCore.watchOutbox`) moved `new/` records into `cur/` themselves.
  Failed verification refuses delivery and attempts dead-lettering. Each also re-drives retryable `dlq/`
  entries: the deploy bot on every poll, the bridge at a configurable
  interval, defaulting to 30 seconds.

  `@tpsdev-ai/agent`'s `MailClient` throws when constructed without a verifier;
  embedders must pass one. It also shares the envelope policy and locked consumed-ID replay store with `promote()`,
  which now live in `@tpsdev-ai/agent`.

  **Upgrade:** pass a verifier (a `FlairClient`) when constructing `MailClient`.

  The writer scan allows promotion, the locked existing-only `updateExistingRecord()`
  helper, `MailClient`, the container outbox/cur archive (`relay.ts`) and the
  office internal-mail store (`internal-mail.ts`). The delegation check covers
  `checkMessages`, `setBridgeSentAtPath`, `ackMessageAtPath`, `nackMessage` and `patchMailFile`.
