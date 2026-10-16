- **The codex runtime's review-trigger loop runs end to end.** A launch whose
  `reviewTrigger` config is valid starts the loop; the runtime publishes
  `pr.opened` with the PR URL, and a missing PR or a failed review request fails
  the handler so the loop retries rather than advancing its cursor.
