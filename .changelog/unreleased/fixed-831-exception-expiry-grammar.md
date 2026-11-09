- **The dep-age exception parser accepts an expiry only as a strict `YYYY-MM-DD` UTC calendar day.**

  A value in another spelling (an extended year, a two-digit year, an unpadded
  month, or a timestamp) is refused with exit 2, naming the exception line and
  the value.
