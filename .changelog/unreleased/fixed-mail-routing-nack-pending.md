- **A settled failure's nack mail is durable and at-least-once, so a crash can no longer lose it (cli#389 round 10).**

  Four defects in what the plugin records about telling the sender. The merge
  standard for this PR is correct outcomes and no false sentence.

  **The nack is persisted with the failure, sent with the turn, and retried on
  a later start if it never landed.** The verb wrote `failed`, stamped the
  inbound and then started an UNAWAITED send: a crash between those steps, or a
  send that failed, left the sender never told, and restart recovery skipped
  terminal records entirely. Now the SAME write that sets `failed` also sets
  `nackPending`, the send is awaited, and a mail that reaches a route records
  `nackSentAt` and clears `nackPending` in one further write — when that write
  succeeds; when it does not, the debt stays and the nack may repeat. Restart
  recovery retries delivery for any `failed` record carrying `nackPending` with
  no `nackSentAt`, but only INSIDE the hold window — a configurable multiple of
  `retentionDays` (at least 1; the default is 4). Past that window the debt is
  abandoned ONCE, logged `nack-abandoned`, and normal retention then applies to
  the record. AT-LEAST-ONCE, not exactly-once: a crash after the hand-off
  but before the record is written retries delivery, so the sender may see the
  nack twice; `nackSentAt` is recorded when that write succeeds, and when it
  does not the record keeps `nackPending` and the nack may repeat. The
  `nackedAt` stamp is no longer evidence that the sender was told: it is written
  before the send, so it never was.

  **A store that cannot be written is one attempt, logged by name, not a loop.**
  If the `delivering` write fails and the write that records the failure fails
  with it, nothing can be recorded — the plugin makes ONE attempt, logs
  `obligation-write-failed`, does not retry in a loop, and the obligation
  resolves on a later start, once the store can be written. The README now states
  that instead of claiming the
  obligation "fails and nacks" unconditionally.

  **A late final is refused because the obligation is CLOSED.** The README and
  this changelog said the refusal was because the sender had been told the reply
  failed. An obligation also closes as `unconfirmed`, which tells the sender
  nothing at all, so the reason is that the obligation is closed.

  **A committed delivery fails only on a definitive non-delivery verdict.** The
  README claimed a committed delivery is "never reported failed", which its own
  next sentence contradicted: attributable quarantine after `posted` does fail
  it.

  (Refs #389)
