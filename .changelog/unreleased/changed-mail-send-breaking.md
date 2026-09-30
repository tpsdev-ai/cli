- **Breaking: `tps mail send` requires a usable sender signing key, refuses a recipient it has no route for, and prints only delivery metadata with `--json` (cli#429, cli#389).**

  **Breaking:** `tps mail send` requires a usable sender signing key; provision
  it before upgrading callers. `--unsigned` is unsupported. With no usable key
  the command exits non-zero, names the key path(s) it looked at (or the path
  of the unusable key) and the remedy, and writes nothing to any maildir,
  outbox, sandbox or wire, on every route; `--unsigned` is refused by name.
  To upgrade: give each agent id that sends mail an Ed25519 key at
  `~/.flair/keys/<id>.key` or `~/.tps/identity/<id>.key` in one of the accepted
  formats, make sure Flair holds its public key (recipients verify against it),
  and remove `--unsigned` from any caller.

  **Breaking: a recipient with no route is refused.** On an office host, a
  recipient with no GAL entry, no branch-office registration and no local
  maildir is refused with an error naming the fix, and a GAL entry whose branch
  has no `remote.json` is refused as `gal-without-remote`, whatever maildirs or
  branch-office inboxes exist. Either refusal exits non-zero, writes nothing and
  creates no directory. To upgrade: create the recipient agent, or add it to the
  GAL with a registered branch, before sending to it.

  **Breaking: `--json` prints delivery metadata only.** On every route the
  output is one line of JSON: `status`, `route`, `to`, `from`, the signed
  `messageId`, `replyToId` when the message is a reply, `signedAt`, and the
  route's own details (on the local route, the record `id` and `timestamp`).
  The body and the rest of the stored record are not printed. To upgrade: read
  only those fields from the output.

  (Refs #429, #389)
