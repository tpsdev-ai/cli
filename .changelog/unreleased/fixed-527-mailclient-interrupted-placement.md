- **MailClient completes its own interrupted new/→cur/ placement instead of refusing the record (Closes #527).**

  When a check made the `cur/` link but stopped before removing the `new/`
  entry, the next check read the `cur/` record as consumed history and
  dead-lettered it. The placement is now recognised as this client's own by
  device and inode — the two paths are one file — so the next check removes the
  `new/` entry and completes the delivery. A `cur/` entry of the same name
  that is a different file is refused as before.
