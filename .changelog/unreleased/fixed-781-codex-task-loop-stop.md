- **The Codex runtime shares a bounded loop-stop drain between signal shutdown
  and rejection cleanup.** Stopped loops discard late reads. Mail awaiting dispatch at shutdown stays unacknowledged.
