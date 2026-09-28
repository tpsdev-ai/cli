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
  regular-file or memfd stdin reads as 0 bytes once `process.stdin` exists). It
  is never echoed.

  **`--reply-to <messageId>`: threading covered by the signature.** The signed
  `messageId` being answered is carried inside the envelope, so the signature
  covers it. One id rule — letters, digits, dot, underscore or hyphen, 1-128
  characters — applies to `--reply-to` on send and to every envelope's
  `messageId` and `replyToId` on receipt; an envelope outside it is
  dead-lettered. The thread is shown by `mail check`, `mail list`, `mail read`
  and `mail log` for VERIFIED mail only: every unverified presentation (new/,
  dlq/, a cur/ record that does not re-verify) withholds the body and the
  thread fields (`replyToId`, `envelopeId`, the stored envelope).

  **Keys: one search path, strict formats.** A signer resolving a key by agent
  id looks at `~/.flair/keys/<id>.key`, then `~/.tps/identity/<id>.key` (where
  `tps init` and `tps agent create` put it); the first file that exists is the
  key, and one that cannot be read or parsed is an error naming its path, never
  a fall-through. Accepted formats: a raw 32-byte seed, one line of base64 PKCS8
  DER, raw PKCS8 DER, or exactly one unencrypted PEM `PRIVATE KEY` block — each
  parsed strictly (the whole input must be the one key; encrypted keys and other
  algorithms are refused by name; errors never contain key material).

  **A send that cannot sign FAILS.** With no usable key the command exits
  non-zero, names the key path(s) it looked at (or the path of the unusable key)
  and the remedy, and writes nothing to any maildir, outbox, sandbox or wire —
  on every route. There is no unsigned opt-in: `--unsigned` is refused by name.

  **openclaw-tps-mail: replies and nacks are signed and threaded the same way.**
  A dispatcher reply, and a nack, signs the inbound's verified envelope
  `messageId` as its `replyToId` inside the envelope; the inbound's local record
  id is kept only for the plugin's own obligation bookkeeping. A reply or nack
  that cannot be signed is not sent (the failure is logged by name, and an owed
  nack stays pending for the next start). The obligation receipt scan requires
  the signed thread.

  **pi-tps-mail: the watcher replies through `--stdin --reply-to`, and
  acknowledges an inbound only after its reply was sent.** A failed send (for
  example, no signing key yet) leaves the inbound in `new/` and re-sends the same
  reply after a backoff (60 s, doubling to 30 minutes) without re-running the
  launcher.

  (Refs #429)
