- **Publish codex PR URLs from Flair and mail tasks** to `pr.opened`.
  The review loop acts only on the agent's own events, requests the configured
  reviewers on the repository named by the PR URL, skips an event that fails
  permanently and retries a transient failure a bounded number of times. A
  malformed `reviewTrigger` refuses runtime startup.
