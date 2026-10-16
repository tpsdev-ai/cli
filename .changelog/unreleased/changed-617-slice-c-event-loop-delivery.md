- **The agent event loop processes one mail delivery at a time (Refs #617, slice c).**

  Handler completion requests finalization; a turn-limit return or thrown
  handler requests release. Deferred finalization and release are retried on
  the same delivery. Deadline quarantine requires the mailbox lock and storage
  to become available; until then the claim stays pending. A stop prevents
  the next `deliverNext()` call; a check already waiting can return a delivery,
  which is processed and settled before shutdown removes the PID file, except
  that a `completeDelivery()` refusal with `identity` after `cur/` changes during
  the handler is logged and leaves the intent pending, blocking further delivery
  of that message until resolved.

  A handler that never returns cannot reach the presentation or deadline checks.

  A committed unfinished hand-over can be re-presented after a kill when
  recovery can verify it. A durably finalized delivery is not presented again.
  Delivery API consumers receive a JSON-encoded
  `[canonical mailbox path, messageId]` key, stable across presentations at that path.
