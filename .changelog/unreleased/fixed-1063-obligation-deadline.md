- **A pending reply obligation gets its deadline at creation, and a periodic
  sweep arms a pending obligation that has none.** A turn whose end the plugin
  did not observe settles at its deadline; a record the store cannot read or
  write is reported, not settled.
