- **The Codex runtime uses a bounded loop-stop drain for signal shutdown
  and rejection cleanup.** Stopped loops discard late reads. Mail awaiting dispatch at shutdown stays unacknowledged.
