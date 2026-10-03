- **Mail verification accepts the Flair hub's public-key encodings (unpadded base64url and standard base64), so hub-verified inbound mail is no longer dead-lettered (Closes #493).**

  Every hub-returned public key is decoded by one parser that accepts the
  encodings the hub stores and refuses anything that is not a 32-byte Ed25519
  key.
