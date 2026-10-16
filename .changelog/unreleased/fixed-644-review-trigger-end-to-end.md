- **Attempt bounded publication of codex PR URLs from Flair and mail tasks** as `pr.opened`.
  Only an accepted POST can reach the review loop; exhausted retries call
  `console.warn` and return without an event if no POST was accepted.
  The review loop filters events attributed to the agent by stored `authorId`;
  an admin caller may supply `authorId`. It requests configured reviewers on the
  repository named by the PR URL, skips classified terminal failures (including
  HTTP 404/422), and gives other failures bounded attempts. A malformed
  `reviewTrigger` refuses runtime startup.
