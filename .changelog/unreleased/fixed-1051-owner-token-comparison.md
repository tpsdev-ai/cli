- **Host-state ownership and released-agent identity use the same start-token rule as the lock and pid-file checks.** A live
  process whose recorded token comes from another source, or is a differing `ps:` token, is unverifiable rather than a
  different process. A recorded token that differs from the live one but is not a `proc:` token with a value (a bare `proc`,
  an empty `proc:`) is unverifiable as well. A host-state refresh or removal that reaches the token comparison (the caller
  supplies no connection id, or the record's matches) reports the record as unverifiable and leaves it as it is; a record
  for another connection id is left alone before any token is compared. Teardown reports a released agent it cannot verify as a survivor and keeps the launch state.
