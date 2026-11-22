- **The deadline check's own failures are retried in-process, and same-state decision writes no longer overwrite each other (#1059).**
  A deadline whose cur/ lookup errors, or a re-arm that does not land, rechecks
  at 1 s, 4 s and 16 s on one shared schedule per obligation: a pending attempt
  keeps its due time, and an exhausted budget stays exhausted until shutdown or
  the record's state moves. A check re-reads the record; when its deadline has
  passed it also re-reads the receipt evidence and the cur/ lookup before any
  settlement. The cap logs one `obligation-retry-exhausted` warning, leaves the
  record unchanged and sends no nack. Obligation records carry a revision that
  every write that lands increments under the store lock; a decision write names
  the state, revision and deadline it examined, and a same-state update is
  refused and re-evaluated from fresh evidence. Only a nonnegative safe integer
  is a valid revision: a record carrying anything else is unverified and is
  never written. A pre-revision record reads as 0 and becomes 1 on its first
  write.
