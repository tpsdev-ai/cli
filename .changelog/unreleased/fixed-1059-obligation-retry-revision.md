- **The deadline check's own failures are retried in-process, and same-state decision writes no longer overwrite each other (#1059).**
  A deadline whose cur/ lookup errors, or a re-arm that errors or is refused
  while the record is still live, rechecks at 1 s, 4 s and 16 s on one shared
  schedule per obligation. One owner at a time: a scheduled attempt keeps its
  due time, and while an attempt runs every event or arm request only records a
  re-check that the running check considers when it completes. An exhausted
  budget stays exhausted until shutdown or a verified LIVE state move (never an
  unverified baseline) opens a fresh one. A check re-reads the record; when its
  deadline has passed it also re-reads the receipt evidence and the cur/ lookup
  before any settlement. The cap cancels when the record is gone or terminal,
  logs one `obligation-retry-exhausted` warning otherwise (calling an unverified
  read unresolved), leaves the record unchanged and sends no nack. Obligation records carry a revision that
  every write that lands increments under the store lock; a decision write names
  the state and revision (and the reply identity where it applies; the deadline
  path also names the deadline), and a same-state update is
  refused and re-evaluated from fresh evidence. Only a nonnegative safe integer
  is a valid revision: a record carrying anything else is unverified and is
  never written. A pre-revision record reads as 0 and becomes 1 on its first
  write.
