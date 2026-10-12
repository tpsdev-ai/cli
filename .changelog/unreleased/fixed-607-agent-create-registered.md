- **`tps agent create` prints "registered" only when the key pair is
  consistent and Flair accepts a request signed with the private key.** Before
  any Flair request it signs a probe with the private key and refuses when the
  `.pub` file does not verify that signature, instead of using the `.pub` bytes
  unchecked. A partial identity (an entry, a dangling symlink included, at any
  identity path, without both `.key` and `.pub`) is refused before any file is
  written; `create` used to generate a new pair over it, or through the link.
  An identity file `create` reads (`.key` and `.pub`, and `.meta.json`, `.seed`
  and `.x25519.pub` when present) that cannot be read, and a `.meta.json` that
  is not JSON, are refused by name. The probe loads the private key as the
  Flair client signs with it (an unencrypted PEM key, a raw 32-byte seed or
  base64 PKCS8 DER): an encrypted PEM key is refused as encrypted, and any
  other readable key file the client cannot load is refused too. After Flair
  reads back the registered key, `create` sends one request signed with the
  private key and requires Flair to accept it and its response to carry the
  registered key. A refusal names the agent, what it found and the remedy, and
  exits non-zero.
