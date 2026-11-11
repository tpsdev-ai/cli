- **`tps branch init` prints the join token only after the listener binds.** On a bind failure it names the port and exits non-zero without a token.

  On both the `ws` and `tcp` transports, a failure to bind (for example, the
  port is already in use) reports the address and exits non-zero; it prints no
  token for a listener that was never running.
