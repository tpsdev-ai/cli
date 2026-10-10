- **A signer inventory test classifies every `TPS-Ed25519` site in the packages'
  src trees.** The scan lists each occurrence of the literal (string, template
  or concatenation operand) and each reference to a binding that holds it. Every
  site must be either a signer mapped to a test that drives it against the
  shared verifying Flair stub, or an explicit non-signer with a reason. An
  unclassified site, a stale entry, or a reference the scan cannot resolve fails
  the inventory, and the stub refuses an unsigned caller through the real
  request path.
