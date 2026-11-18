- **A stuck reply obligation is retried in-process, and same-state decision writes no longer overwrite each other (#1059).**
  A deadline that hits a lookup error, or a re-arm that does not land, now
  rechecks at 1 s, 4 s and 16 s; each check re-reads the record and the receipt
  evidence, and the cap logs one `obligation-retry-exhausted` warning, leaves
  the record unchanged and sends no nack. Obligation records now carry a
  revision that every write increments under the store lock; a decision write
  that names a stale revision is refused and re-evaluated, and a pre-revision
  record reads as 0 and becomes 1 on its first write.
