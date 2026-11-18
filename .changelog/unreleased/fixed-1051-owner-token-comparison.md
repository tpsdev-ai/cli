- **Host-state ownership and released-agent identity use the same start-token rule as the lock and pid-file checks.** A live
  process whose recorded token comes from another source, or is a differing `ps:` token, is unverifiable rather than a
  different process. A host-state refresh or removal reports the record as unverifiable and leaves it as it is. Teardown
  reports a released agent it cannot verify as a survivor and keeps the launch state.
