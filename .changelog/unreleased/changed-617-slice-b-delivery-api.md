- **MailClient gains a per-message delivery API; a committed message stays re-presentable until completed (Refs #617, slice b).**

  Nothing in the agent runtime calls the new API yet, so delivery is
  unchanged until slice (c) wires it. The API commits one message and leaves
  its placement intent in the `in_progress` phase, removed by an explicit
  completion. A committed message is re-presented until then, with a liveness
  bound: after five presentations without completion, or 24 hours after the
  first, the intent goes terminal `failed`, the payload is kept and one log
  line names the mailbox, message ID and presentation count.

  `recoverPromoted` now reads the placement intent's phase and withholds a
  record that resolves to anything but `placing` with a retryable `busy`
  refusal, so `tps mail ack` and `nack` and the bridge and plugin startup
  sweeps do not present another consumer's in-flight delivery.
