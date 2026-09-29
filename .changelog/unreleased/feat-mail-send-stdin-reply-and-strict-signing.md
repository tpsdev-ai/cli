- **`tps mail send` takes its body on stdin, threads replies inside the signature, reads the keys `bob onboard` and `tps init` write, and never sends unsigned (cli#429).**

  A program that answers mail could not drive `tps mail send` safely: the body
  had to be passed in argv (process listings, shell history, logs); there was no
  way to mark a reply against the signed `messageId` it answers; the CLI
  rejected the PEM PKCS8 Ed25519 keys `bob onboard` writes; and a send with no
  key shipped the body unsigned and exited 0 — a body a `promote()`-reading
  recipient dead-letters. What changed:

  **`--stdin`: the body is read from stdin, never from argv.** It is read from
  fd 0 as UTF-8 with `readSync` until EOF — retrying EAGAIN, capped at the
  64 KiB envelope body limit, with distinct errors for empty input and for a
  stdin that never delivers — and never through `process.stdin` (under bun a
  regular-file or memfd stdin reads as 0 bytes once `process.stdin` exists).
  The command never prints the body: `--json` prints delivery metadata only
  (`status`, `route`, `to`, `from`, the signed `messageId`, `replyToId`,
  `signedAt`, and on the local route the record `id` and `timestamp`) on every
  route, and no error carries it.

  **`--reply-to <messageId>`: threading covered by the signature.** The signed
  `messageId` being answered is carried inside the envelope, so the signature
  covers it. One id rule — letters, digits, dot, underscore or hyphen, 1-128
  characters — applies to `--reply-to` and `--message-id` on send and to every
  envelope's `messageId` and `replyToId` on receipt; an envelope outside it is
  dead-lettered. The thread is shown by `mail check`, `mail list`, `mail read`
  and `mail log` for VERIFIED mail only. Every unverified presentation (new/,
  dlq/, a cur/ record that does not re-verify) shows only the record's id,
  claimed sender and recipient, timestamp, location and lifecycle fields: the
  body, the thread fields (`replyToId`, `envelopeId`, the stored envelope), the
  headers (`X-TPS-InReplyTo`, `X-TPS-Obligation` and `X-TPS-Nack` among them)
  and every other field are withheld.

  **`--message-id <id>`: a re-send is the same message.** The envelope is
  signed with that `messageId` instead of a fresh UUID, so a sender that
  re-sends after an unknown outcome produces the same message, which a
  recipient's replay gate discards.

  **Keys: one search path, strict formats, no silent choice.** A signer
  resolving a key by agent id reads `~/.flair/keys/<id>.key` and
  `~/.tps/identity/<id>.key` (where `tps init` and `tps agent create` put it).
  When both exist they must hold the same key: two different keys are refused,
  naming both paths and the remedy, instead of one being chosen. A file that
  cannot be read or parsed is an error naming its path. Accepted formats: a raw
  32-byte seed, one line of base64 PKCS8 DER, raw PKCS8 DER, or exactly one
  unencrypted PEM `PRIVATE KEY` block — each parsed strictly (the whole input
  must be the one key; encrypted keys and other algorithms are refused by name;
  errors never contain key material).

  **A send that cannot sign FAILS.** With no usable key the command exits
  non-zero, names the key path(s) it looked at (or the path of the unusable
  key) and the remedy, and writes nothing to any maildir, outbox, sandbox or
  wire — on every route. There is no unsigned opt-in: `--unsigned` is refused
  by name.

  **openclaw-tps-mail: replies and nacks are signed and threaded, and a receipt
  must verify.** A dispatcher reply signs the inbound's verified envelope
  `messageId` as its `replyToId` inside the envelope, and so does the nack for
  every obligation this version opens (an obligation opened by an earlier
  version records no envelope id, so its nack is signed but unthreaded). A reply
  or nack that cannot be signed is not sent (the failure is logged by name, and
  an owed nack stays pending for the next start). The obligation receipt scan
  accepts a receipt — the posted record, the bridge sandbox record or the
  metadata receipt — only when the reply it carries is a signed envelope from
  the obligated agent whose signatures verify against the key Flair holds for
  it and whose signed `replyToId` is the inbound's verified envelope id; an
  unsigned, badly signed or foreign-signed record never acks an obligation. The
  metadata receipt now carries the signed reply it attests (`signedReply`),
  0600 in the replying agent's own obligation store.

  **pi-tps-mail: the watcher answers only verified mail, and a reply is sent as
  one message.** Each check runs `tps mail check <agent> --json` and acts only
  on the records it verified; an unsigned or forged inbound is dead-lettered by
  the CLI and never answered. The reply goes out on stdin with `--reply-to` the
  inbound's verified envelope id, and is journaled first with the envelope
  `messageId` it is signed with: a send whose outcome is unknown (a non-zero
  exit or a timeout) is re-sent later as the same message (a recipient
  dead-letters the copy as a replay), an ack that fails is retried without
  re-sending, and a restart finishes whatever the journal still owes. An
  inbound whose launcher run was interrupted is re-presented by the CLI when
  its lease expires, and answered then.

  **Not signed yet.** Only `tps mail send`, the plugin's dispatcher replies and
  nacks, and the codex/gemini runtimes' replies sign. Pulse, topic fan-out and
  catch-up, hire onboarding, roster invites, bootstrap, branch handler replies,
  the plugin's outbound adapter (`sendText`) and the channel bridge (all tracked
  in tpsdev-ai/cli#433), and the `@tpsdev-ai/agent` runtime's
  `MailClient.sendMail`, still write unsigned mail, which a verifying recipient
  dead-letters.

  (Refs #429)
