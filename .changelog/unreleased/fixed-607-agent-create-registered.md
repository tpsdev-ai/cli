- **`tps agent create` prints "registered" only when the key pair is
  consistent and Flair accepts a request signed with the private key.** Before
  any Flair request it signs a probe with the private key and refuses when the
  `.pub` file does not verify that signature, instead of using the `.pub` bytes
  unchecked; a private key file that is not a raw 32-byte Ed25519 seed is
  refused there too. After Flair reads back the registered key, `create` sends
  one request signed with the private key and requires Flair to accept it and
  its response to carry the registered key. A refusal names the agent, what it
  found and the remedy, and exits non-zero.
