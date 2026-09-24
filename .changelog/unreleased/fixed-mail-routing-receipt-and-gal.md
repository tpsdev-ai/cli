- **Remote and misconfigured mail routes are now named, and a wire delivery leaves a local receipt.**

  Four follow-ups to the one-locality-rule change (cli#389). (1) A reply
  delivered over the wire to a remote branch now persists a local receipt
  (`~/.tps/receipts/<reply-id>.json`, 0600, carrying `route: "remote-branch"`
  and the branch) that the reply-obligation scan finds, so a delivered remote
  reply is acked instead of later marked failed and nacked. (2) A GAL entry that
  names a branch with no remote registration is a misconfiguration: the shared
  resolver returns a named `failed` route (`gal-without-remote`) and
  `tps mail send` exits non-zero with that message, whatever maildirs exist —
  never a fall-through to a local write. (3) A recipient addressed by its OWN
  branch id (`remote.json` under the recipient name, no GAL entry) routes remote,
  as `tps mail send` has always done; this is documented on the resolver. (4) A
  local branch-office inbox with no `remote.json` is a named `bridge` route,
  delivered through the CLI's own `deliverToSandbox` by both callers.

  (Refs #389)
