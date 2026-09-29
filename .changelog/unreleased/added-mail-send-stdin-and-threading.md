- **`tps mail send` takes its body on stdin, threads replies inside the signature, can re-send a message under the same id, and reads the keys `bob onboard` and `tps init` write (cli#429).**

  Mail send supports stdin input and signed reply threading, accepts the
  documented Ed25519 key formats, and requires successful signing before
  delivery. What signing now requires of existing callers is in the Breaking
  entry for `tps mail send`.

  **`--stdin`: the body is read from stdin, never from argv.** The reader uses
  fd 0 directly, caps input at 64 KiB, distinguishes empty input, and bounds
  consecutive EAGAIN retries on nonblocking stdin. It never goes through
  `process.stdin`, so a regular-file, memfd or pipe stdin yields the same bytes
  under bun. The 64 KiB limit is enforced on the SIGNED message (the body plus
  its signature and envelope fields) before any route: a body just under the
  limit whose signed envelope is over it is refused by name, and nothing is
  written. The command never prints the body, and no error carries it.

  **`--reply-to <messageId>`: threading covered by the signature.** The signed
  `messageId` being answered is carried inside the envelope, so the signature
  covers it. One id rule — letters, digits, dot, underscore or hyphen, 1-128
  characters — applies to `--reply-to` and `--message-id`. The thread is shown
  by `mail check`, `mail list`, `mail read` and `mail log` for verified mail
  only.

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

  **pi-tps-mail: the watcher sends each reply as one message.** The reply goes
  out on stdin with `--reply-to` the inbound's verified envelope id, and is
  journaled first with the envelope `messageId` it is signed with. A send whose
  outcome is unknown (a non-zero exit or a timeout) is re-sent later as the
  same message, which a recipient dead-letters as a replay. Recovery retries
  acknowledgement without resending when the journal records `sent`; if that
  write did not persist, it may resend using the same envelope message ID. If
  the watcher stops before journaling a reply, the unacknowledged inbound can be
  re-presented after lease expiry. A launcher timeout produces a diagnostic
  reply.

  (Refs #429)
