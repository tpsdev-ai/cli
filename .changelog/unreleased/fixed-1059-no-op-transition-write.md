- **An obligation transition that changes nothing no longer writes (#1059).**
  Re-arming the state and deadline a record already carries, when every patched
  field matches the record in both presence and value, leaves the record
  byte-identical: no revision bump and no `lastTransitionAt` stamp, so a re-arm
  cannot invalidate a revision-bound decision another check is running against
  the same record. A patch that adds a field (the missing-`cur/` re-arm adds
  `missingCurReason`), sets one where it was absent, or clears one that is
  present is still a write.
