- **A remote-branch send keeps the reply's identity on the wire.**

  `tps mail send`'s remote path (and the openclaw-tps-mail plugin's) now pass the
  message `id` and `timestamp` to `deliverToRemoteBranch`, so the wire payload
  and the branch's ACK correlation use the SAME id the caller reports — not a
  UUID the relay invents.

  (Refs #389)
