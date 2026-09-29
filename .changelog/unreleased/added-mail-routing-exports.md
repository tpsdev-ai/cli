- **The CLI package now exports `@tpsdev-ai/cli/utils/mail-routing` and `@tpsdev-ai/cli/utils/relay` for integrations.**

  `utils/mail-routing` is the outbound routing decision `tps mail send` makes,
  and `utils/relay` holds the remote-branch and branch-office bridge delivery
  it uses; the openclaw-tps-mail plugin imports both instead of keeping its own
  copies.

  (Refs #389)
