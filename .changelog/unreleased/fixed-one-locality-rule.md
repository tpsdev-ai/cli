- **One routing decision for outbound mail, shared by `tps mail send` and the openclaw-tps-mail plugin (cli#389).**

  Outbound mail uses a shared resolver that applies branch routing and office
  GAL precedence before local-maildir fallback. It lives in
  `packages/cli/src/utils/mail-routing.ts`, and `tps mail send` and both plugin
  paths (the dispatcher reply and the outbound adapter) import it rather than
  keep their own rules:

  - On a BRANCH, a recipient bound to this gateway is local and every other
    recipient is relayed through `~/.tps/outbox/new/`; directory existence never
    matters there.
  - On the OFFICE, the GAL is consulted first. A GAL-listed recipient whose
    branch is registered remotely (a GAL entry plus
    `~/.tps/branch-office/<branch>/remote.json`) is sent over the wire with
    `deliverToRemoteBranch`; one whose branch has no remote registration is the
    named failure `gal-without-remote`, whatever maildirs exist.
  - Only a recipient with no GAL entry reaches the rest, in this order:
    `remote.json` under the recipient's own name goes over the wire; a
    branch-office inbox (`~/.tps/branch-office/<to>/mail/inbox`) takes the
    `bridge` route, delivered through the CLI's own `deliverToSandbox`; a binding
    or an existing local maildir is written locally; anything else is the named
    failure `unknown`.

  A named failure is never a silent write. `tps mail send` exits non-zero with
  an error naming the fix and writes nothing (and creates no directory). The
  plugin's dispatcher reply records the failure in its log and in the
  obligation record as a definitive non-delivery; its outbound adapter throws a
  named error.

  A plugin reply sent over the wire keeps its identity: the dispatcher passes
  the reply `id` and `timestamp` to `deliverToRemoteBranch`, so the wire payload
  and the branch's ACK correlation use the id the plugin reports as the reply
  id. CLI sends carry a signed envelope message ID, optionally supplied with
  `--message-id`; the remote relay independently generates their transport
  record ID.

  (Refs #389)
