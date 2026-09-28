- **`tps mail send` takes its body on stdin, threads replies, reads the keys `bob onboard` writes, and refuses to send unsigned (cli#429).**

  A program that answers mail could not drive `tps mail send` safely. The body
  had to be passed in argv (process listings, shell history, logs); there was no
  way to mark a reply against the signed `messageId` it answers, so the
  recipient could not correlate a reply with its request; the CLI rejected the
  PEM PKCS8 Ed25519 keys `bob onboard` writes with "Unrecognized Ed25519 private
  key format"; and a send with no key shipped the body UNSIGNED and exited 0 — a
  body a `promote()`-reading recipient dead-letters terminal. Four changes:

  **`--stdin`: the body is read from stdin, never from argv.** The body is read
  from fd 0 as UTF-8, size-capped at the 64 KiB envelope body limit, and never
  echoed. It is read with `readSync` on fd 0 — retrying EAGAIN, with an explicit
  cap and a distinct error for empty input — and NOT through `process.stdin`:
  under bun, once `process.stdin` exists a regular-file/memfd stdin reads as 0
  bytes, and on Linux `spawnSync({ input })` hands the child a memfd, so a
  stream-based reader works on macOS and silently loses the body on Linux.

  **`--reply-to <messageId>`: threading that is covered by the signature.** The
  signed `messageId` being answered is carried at the top of the envelope, so
  JCS canonicalization binds it with the envelope signature: altering or
  stripping it in transit fails verification. Its shape is validated before use,
  and it is surfaced on receipt by `mail check`, `mail list`, `mail read` and
  `mail log`.

  **PEM PKCS8 Ed25519 keys.** The key loader now accepts PEM PKCS8 (the
  `-----BEGIN PRIVATE KEY-----` text form) alongside the raw 32-byte seed and
  base64 PKCS8 DER, wherever a signing key is loaded — so a key written by
  `bob onboard` at `~/.flair/keys/<id>.key` signs.

  **A send that cannot sign FAILS.** With no usable key the command exits
  non-zero, names the key path it looked at and the remedy, and writes NOTHING
  to any outbox or maildir. `--unsigned` remains an explicit, warned,
  local-testing-only opt-in; it is never the default. A caller that relied on
  the old silent-unsigned fallback must provision a key or pass `--unsigned`
  (in this repo: the branch-outbox `mail send` test, and the `pi-tps-mail`
  watcher, which invokes `tps mail send` as the agent id).

  (Refs #429)
