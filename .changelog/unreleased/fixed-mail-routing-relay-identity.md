- **A remote-branch REPLY keeps its identity on the wire.**

  The openclaw-tps-mail plugin's dispatcher reply path passes the reply `id` and
  `timestamp` to `deliverToRemoteBranch`, so the wire payload and the branch's
  ACK correlation use the SAME id the plugin reports as the reply id — not a
  UUID the relay invents. `tps mail send` carries no message id of its own, so
  its remote path is unchanged and the relay still mints one there.

  (Refs #389)
