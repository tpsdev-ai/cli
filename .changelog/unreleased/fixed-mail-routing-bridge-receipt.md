- **A bridge or wire delivery is receipted the same way, and a receipt stays small.**

  Every non-local delivery that leaves no locally readable mail file — the
  remote-branch wire send and the branch-office bridge — now persists the same
  metadata-only receipt at `~/.tps/receipts/<obligation-id>.json`, so a bridge
  reply's obligation is discharged too (it previously failed at its deadline and
  was nacked). A receipt names the reply, the obligation, the inbound it answers,
  the route, the branch and the timestamp — never the body — is created 0600, and
  is matched on the obligation id AND the inbound, so a reused obligation id can
  never be satisfied by an old receipt. The obligation retention sweep now also
  removes receipts: a receipt goes when its obligation is terminal or when the
  receipt itself is older than the retention window.

  (Refs #389)
