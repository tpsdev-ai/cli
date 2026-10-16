- **Publish codex PR URLs from Flair and mail tasks** to `pr.opened`.
  The review loop filters events attributed to the agent by stored `authorId`;
  an admin caller may supply `authorId`. It requests configured reviewers on the
  repository named by the PR URL, skips classified terminal failures (including
  HTTP 404/422), and gives other failures bounded attempts. A malformed
  `reviewTrigger` refuses runtime startup.
