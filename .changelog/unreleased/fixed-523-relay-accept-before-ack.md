- **The relay records a delivery's acceptance durably before it writes the inbox record and before it acknowledges.**

  `tps office sync` and `tps office connect` write the acceptance marker under
  `.relay-accepted/by-branch/<branch>/<id>` with a temp file, fsync and rename
  before the inbox write. A failed marker write leaves the inbox untouched and
  sends no ACK; a failed dead-letter removes the marker so the delivery stays
  retryable.
