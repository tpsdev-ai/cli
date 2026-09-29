- **Mail verification covers reply threads and message ids, unverified mail is shown as metadata only, and the mail runtimes sign their replies and answer only verified mail (cli#429).**

  **One id rule on receipt.** Every received envelope's `messageId` and
  `replyToId` must satisfy the id rule `tps mail send` applies (letters,
  digits, dot, underscore or hyphen, 1-128 characters); an envelope outside it
  is dead-lettered.

  **Unverified mail is metadata only.** Every unverified presentation (new/,
  dlq/, a cur/ record that does not re-verify) shows only the record's id,
  claimed sender and recipient, timestamp, location and lifecycle fields: the
  body, the thread fields (`replyToId`, `envelopeId`, the stored envelope), the
  headers (`X-TPS-InReplyTo`, `X-TPS-Obligation` and `X-TPS-Nack` among them)
  and every other field are withheld.

  **openclaw-tps-mail: replies and nacks are signed and threaded.** A
  dispatcher reply signs the inbound's verified envelope `messageId` as its
  `replyToId` inside the envelope, and so does the nack for every obligation
  this version opens (an obligation opened by an earlier version records no
  envelope id, so its nack is signed but unthreaded). A reply or nack that
  cannot be signed is not sent: the failure is logged by name, and an owed nack
  stays pending for a later start. A reply receipt counts only when the signed
  reply it carries verifies (see the reply-receipt entry).

  **pi-tps-mail: the watcher answers only verified mail.** Each check runs
  `tps mail check <agent> --json` and acts only on the records it verified; an
  unsigned or forged inbound is dead-lettered by the CLI and never answered.

  **Not signed yet.** Only `tps mail send`, the plugin's dispatcher replies and
  nacks, and the codex/gemini runtimes' replies sign. Pulse, topic fan-out and
  catch-up, hire onboarding, roster invites, bootstrap, branch handler replies,
  the plugin's outbound adapter (`sendText`) and the channel bridge (all tracked
  in tpsdev-ai/cli#433), and the `@tpsdev-ai/agent` runtime's
  `MailClient.sendMail` do not sign bodies themselves, and a verifying
  recipient dead-letters an unsigned body. (A writer that passes a supplied
  body through — a relay, a branch forward — can preserve an envelope that was
  already signed.)

  (Refs #429)
