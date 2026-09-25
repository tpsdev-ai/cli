- **A bridge or wire delivery is receipted the same way, and a receipt stays small.**

  Every non-local delivery that leaves no locally readable mail file — the
  remote-branch wire send and the branch-office bridge — persists the same
  metadata-only receipt, in the REPLYING agent's own obligation store at
  `<mailDir>/<agent>/.obligations/receipts/<obligation-id>.json`. A receipt
  names the reply, the obligation, the inbound it answers, the route, the branch
  and the timestamp — never the body — is created 0600, and is matched on the
  obligation id AND the inbound, so a reused obligation id can never be satisfied
  by an old receipt. The obligation retention sweep owns those receipts: one
  whose obligation is terminal goes, and one with no obligation left goes once it
  has aged past the retention window. A bridge reply's obligation is therefore
  discharged instead of failing at its deadline and being nacked.

  (Refs #389)
