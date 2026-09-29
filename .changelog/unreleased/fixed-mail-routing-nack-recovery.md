- **Failures persist pending nack notifications for startup retries; retries can duplicate a notification, and aged debt is subject to the configured abandonment policy (cli#389).**

  **The nack is owed on the record.** The write that sets `failed` also sets
  `nackPending`. The verb awaits the send, and a nack that reaches a route
  records `nackSentAt` and clears `nackPending` in one further write. When that
  write fails it is logged `obligation-write-failed`, naming the inbound; the
  record keeps `nackPending`, and a later start may send the nack again. The
  `nackedAt` stamp on the inbound is written before the send and is not
  evidence that the sender was told.

  **Startup retries owed nacks in the background.** Startup schedules bounded
  background nack retries before running retention; pending debt inside the
  hold window is retained regardless of retry completion order. Each retry is
  bounded by one overall timeout spanning the connection and the ACK wait; on
  expiry the transport is closed and `nack-retry-timeout` is logged by name.
  A retry may duplicate a nack. Delivery is not guaranteed: debt still owed
  after the configured hold may be abandoned.

  **The hold is bounded by age.** While a record owes its nack and is inside
  the hold window, the retention sweep keeps it and reports how many it held.
  The window is a configurable multiple of `obligationRetentionDays` (key
  `obligationNackHoldMultiple`, in the plugin or channel config; default 4,
  i.e. 28 days on the default 7-day window). A multiple below 1 is rejected
  with a named log (`obligation-nack-hold-multiple-invalid`) and the default is
  used. Past the bound, retention attempts to clear the debt and logs
  `nack-abandoned`; unsuccessful persistence can cause that attempt and log to
  repeat. A successful abandonment write clears `nackPending` and records
  `nackAbandonedAt`, preventing subsequent startup retries for that debt, and
  normal retention then applies to the record.

  (Refs #389)
