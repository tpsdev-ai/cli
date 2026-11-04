- **`tps branch stop` signals a branch daemon only when its pid record matches.** A
  legacy or unverified record with a live pid is refused; the refusal names the
  pid file and how to remove it.
