- **`tps agent create` prints "registered" only after the private key's own
  signature is accepted.** It derives the public key from the private key and
  refuses a `.pub` file that the private key does not derive, instead of
  registering the stored bytes. After the registration it sends one request
  signed with the private key and requires Flair to accept it and confirm the
  registered key. A refusal names the agent, what it found and the remedy, and
  exits non-zero.
