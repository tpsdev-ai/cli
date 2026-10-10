- **`tps agent create` names both remedy branches when a failed key read-back leaves the Agent row's existence unknown (Refs #593).**

  With the row's existence unknown, the remedy now names `flair agent remove <id>`
  (which also deletes that agent's Memory and Soul rows) as well as
  `flair agent add <id> --keys-dir <dir>`; the definite no-row remedy is unchanged.
