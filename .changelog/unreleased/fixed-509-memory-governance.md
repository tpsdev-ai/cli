- **`tps memory archive`/`unarchive` fail closed and PATCH only the governance fields; `search` signs as `TPS_AGENT_ID`; `approve`/`reject` are unsupported.**

  Archive and unarchive read the record first and refuse, without writing, when
  that read fails or returns an incomplete record; the update is a server-side
  PATCH carrying only `archived`, `archivedBy`, and `archivedAt`. Search signs as
  the operator and passes the target agent as the search's `agentId` parameter.
  `approve` and `reject` exit non-zero: Flair has no operation that promotes or
  rejects a memory by id.
