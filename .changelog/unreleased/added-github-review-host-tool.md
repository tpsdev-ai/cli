- **A host-side `github_review` verb posts pull-request reviews without the GitHub credential ever entering the sandbox (Refs #425).**

  A new, independently versioned OpenClaw plugin, `openclaw-github-review`,
  registers exactly ONE production tool through `api.registerTool` — no
  passthrough, no generic shell/`gh`/HTTP access — and offers it only to the
  configured reviewer agent. It shares no code, deployment unit or dependency
  with `openclaw-tps-mail`.

  **The tool is bound to the session's trusted dispatch assignment.** `repo`,
  `pr` and `commit_id` ARE caller input and are accepted only when they equal the
  host's immutable `{repo, pr}` assignment and the head the host itself fetches;
  the session's agent, and the assignment's reviewer, must match the host signing
  identity. A missing, expired, inactive or mismatched assignment, an unsupported
  field, an unsupported event, a repository outside the configured set and an
  oversized body are all refused with a stable reason, the safely resolved actor,
  the relevant state and a remedy — and no request leaves.

  **The credential stays on the host.** A fine-grained PAT is read once at
  gateway start into a `#private` field of the custody object, reachable by no
  method; its path is not re-read and it appears in no environment, log, tool
  result or session. Repository coverage and permission scope are verified from
  trusted provisioning evidence bound to the installed credential BEFORE any
  request; unknown or stale evidence disables posting, so posting fails closed
  rather than falling back to an online check. Credential and audit work run only
  on a full registration.

  **The body is opaque and the digest is faithful.** The review request is built
  internally from the validated assignment, event, commit and body, with no
  caller-selected endpoint or header, and `body` is sent unchanged. Every
  successful posting emits a signed Flair `OrgEvent` (`kind: pr_review_posted`)
  whose `detail` carries the host-computed `body_sha256` over the UTF-8 body
  handed to the serializer, the returned review id/URL and confirmed commit, the
  review environment's runtime versions and image digest (null until the reviewer
  image supplies them), and the verified login from the provisioning record.
  Partial outcomes are explicit: a GitHub refusal is a refusal; an ambiguous
  outcome or a 2xx with an invalid receipt is reported as `unknown` and latches
  the dispatch so a retry cannot post a second review; a failed audit is retained
  as `posted_audit_pending` and retried without reposting; and a post is never
  followed by a throw.

  **A permanent gateway-boundary lane** loads the BUILT plugin through OpenClaw's
  own registration machinery with a `mode=all` reviewer configuration and proves
  the handler executes in the gateway process — the host-only marker's contents
  are readable there — and drives the secret scans over the success, refusal,
  rejected, ambiguous and audit-failure paths. The container half of the contrast
  is deferred to section A.
