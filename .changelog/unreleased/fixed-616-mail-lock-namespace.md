- **MailClient promotion and dead-letter moves take the relay acceptance stripe from the configured mail directory, so CLI acceptance holding that stripe defers them (Closes #616).**

  MailClient took the stripe from its process `TPS_MAIL_DIR`, so a MailClient
  whose environment named a different root than its configured `mailDir` locked
  a stripe under that other root. Acceptance, promotion and dead-letter moves now
  derive their lock roots from resolved real paths in one shared module;
  placement recovery and the other mailbox lock sites still lock the mailbox
  root path as given.
