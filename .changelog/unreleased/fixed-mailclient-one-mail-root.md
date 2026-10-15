- **MailClient resolves its mail root and mailbox directory to canonical path strings once per operation, then derives subsequent paths without resolving again.**

  The mailbox lock, the maildir paths and the replay state derive from the
  canonical mailbox string. Bridge-principal trust, the relay acceptance
  stripe paths for promotion and dead-lettering, and the recipient inboxes
  that `deliverOutbox()` moves records into derive from the canonical mail-root string.
  No resolved canonical root is cached at construction. When the symlink at the
  configured mail path, or at the agent's mailbox directory, is repointed while
  a client is alive, the new target is selected at the start of the next operation. A
  plain rename of the configured directory is not followed: the next operation
  creates the configured path again and uses that, not the renamed directory.
  The relay stripe is a cooperative lock among MailClients that resolve the same
  canonical path. The OS follows same-user filesystem changes to that path during
  an operation; the stripe does not exclude them.
