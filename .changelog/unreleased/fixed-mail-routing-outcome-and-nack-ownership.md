- **A delivery call that throws is uncertain, not a verdict; the verb owns the nack mail; a terminal obligation refuses a late final (cli#389 round 9).**

  Four outcome defects in one area — what the plugin is entitled to conclude when
  a delivery call goes wrong, and who tells the sender.

  **A throw after `delivering` is not a non-delivery.** `delivering` is persisted
  BEFORE the delivery call (round 8), so a call that throws may have thrown after
  the bytes left: a timeout after send, or a failure writing the local record
  after a remote accept. Such a throw is now logged by name
  (`delivery-uncertain:`) and resolves by EVIDENCE OR DEADLINE — or, if the
  obligation store cannot be written at that point, on a later start once it can
  — never `failed`, never nacked. The definitive verdicts stay what they were: refusals decided
  BEFORE the call (no route at all, a named route failure such as
  `gal-without-remote`) and the drain's attributable quarantine.

  **Every transition to `failed` announces the sender, from the verb, and the
  announcement is durable and at-least-once.** An attributable quarantine found
  during the turn used to fail and stamp the obligation silently, because only
  the deadline caller mailed. The verb now sends the nack mail, so every path
  hands its verdict to that one nack path and the same verdict gives the same
  sender-visible outcome wherever it is found, and no caller mails on its own;
  with no working route the nack stays owed only inside a bounded hold — a
  configurable multiple of `retentionDays` (at least 1): past it the debt is
  abandoned once, logged `nack-abandoned`, and normal retention applies.
  The nack is owed ON
  THE RECORD, not proven by the cur/ stamp, and a terminal record refuses later
  transitions outright.

  **Recovery decides from evidence, not from an old stamp.** A `nackedAt` left by
  earlier behaviour no longer promotes to a verdict for a record whose own
  persisted state says the delivery committed (`delivering`/`posted`): those
  decide by evidence and deadline like any other path, with the stamp kept on the
  record and never treated as a verdict.

  **A terminal obligation refuses `delivering`.** The one-way transition now
  returns null for a refusal instead of the old record, so `markDelivering` can
  tell a landed write-ahead from a refused one: a final arriving after the
  obligation CLOSED is logged `late-final-refused` and NOT delivered. The
  obligation may have closed as `acked`, `failed` or `unconfirmed` — and
  `unconfirmed` tells the sender nothing — so the reason is closure, not "after
  the sender was told it failed".

  README: `posted` means the reply was handed to its route — sent over the wire
  to a remote branch, delivered into a local maildir, or queued in the outbox for
  the branch drain — not "on the wire".

  (Refs #389)
