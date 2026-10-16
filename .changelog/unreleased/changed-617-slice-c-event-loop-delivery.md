- **The agent event loop delivers mail one message at a time and finalizes it only after its handler completes (Refs #617, slice c).**

  Delivery moves from the batch `checkNewMail()` path to the per-message
  delivery API. A check commits a single message with a live `in_progress`
  intent; the loop processes it and finalizes it on a completed outcome. A
  turn-limit return or a thrown handler is not completion: the hand-over is
  released and the message is presented again on the next check. A graceful
  stop breaks before the next commit, so only the message in flight is
  committed. A kill at any point before completion re-presents that message on
  the next check, and messages not yet reached stay in `new/`.

  The guarantee: every committed message is presented until it completes or is
  quarantined by the liveness bound (five presentations or 24 hours). A
  completed message is never presented again, and the delivery key
  `mailbox/messageId` lets handlers make repeats idempotent.
