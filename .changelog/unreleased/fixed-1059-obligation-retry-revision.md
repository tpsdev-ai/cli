- **The deadline check's own failures are retried in-process, and same-state decision writes no longer overwrite each other (#1059).**
  A deadline whose cur/ lookup errors, a retryable re-arm failure while the
  record is still live and no deadline timer is already armed, and a retry
  whose record read fails recheck at 1 s, 4 s and 16 s on one shared schedule
  per obligation. One owner at a time: a scheduled attempt keeps its due
  time, and while an attempt (including the
  fired deadline) runs, an event or arm request for a live record records a
  re-check instead of starting a decision, and the running check considers it
  when it completes, after re-checking that it still
  owns the entry. An exhausted budget stays exhausted until shutdown, until a
  later check finds the record gone or terminal (which releases it), or until a
  verified LIVE state move (never an unverified baseline) opens a fresh one. A
  check re-reads the record; when its deadline has passed it also re-reads the
  receipt evidence and the cur/ lookup before any settlement. The cap cancels
  when the record is gone or terminal, logs one `obligation-retry-exhausted`
  warning otherwise (calling an unverified read unresolved, and naming the error
  that led to the attempt), leaves the record unchanged and sends no nack.
  Obligation records carry a revision that
  every write that lands increments under the store lock; a decision write names
  the state and revision, the deadline where the deadline decides, and the reply
  identity for a verdict gathered from one reply's evidence; a same-state update
  is refused and re-evaluated from fresh evidence. Only a nonnegative safe integer
  is a valid revision: a record carrying anything else is unverified and is
  never written. A pre-revision record reads as 0 and becomes 1 on its first
  write.
