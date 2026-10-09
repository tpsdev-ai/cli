- **A signer inventory test maps each Flair signer to a stub-backed test.** A
  production call site that builds the `TPS-Ed25519` request header — the cli's
  signed Flair client and the hand-rolled builders in `init`, `office-status`
  and the roster dashboard, plus the agent's Flair context provider — must be
  named by a test that drives it against the shared verifying Flair stub. A new
  signing site the scan finds fails the inventory until it is mapped, and the
  stub refuses an unsigned caller through the real request path.
