- **A host-side `github_review` verb posts pull-request reviews without the GitHub credential ever entering the sandbox (Refs #425).**

  A new, independently versioned OpenClaw plugin, `openclaw-github-review`,
  registers exactly ONE production tool through `api.registerTool` — no
  passthrough, no generic shell/`gh`/HTTP access. It shares no code, deployment
  unit or dependency with `openclaw-tps-mail`.

  **The tool is bound to the session's trusted dispatch assignment.** `repo` and
  `pr` come from host context, never from caller input; the assignment's reviewer
  must match the host signing identity; and the caller's `commit_id` must equal
  both the host-recorded reviewed commit and the PR head the host fetches. The
  host fetches the PR itself and requires it open. A missing, expired, inactive
  or mismatched assignment, an unsupported field, an unsupported event, a
  repository outside the configured set and an oversized body are all refused
  with a stable reason, the safely resolved actor, the relevant state and a
  remedy — and no request leaves.

  **The credential stays on the host.** A fine-grained PAT is read once at
  gateway start into the handler's closure; its path is not re-read and it
  appears in no environment, log, tool result or session. Repository coverage and
  permission scope are verified from trusted provisioning evidence bound to the
  installed credential BEFORE any request; unknown or stale evidence disables
  posting, so posting fails closed rather than falling back to an online check.

  **The body is opaque and the digest is faithful.** The review request is built
  internally from the validated assignment, event, commit and body, with no
  caller-selected endpoint or header, and `body` is sent unchanged. Every
  successful posting emits a signed Flair `OrgEvent` (`kind: pr_review_posted`)
  whose `detail` carries the host-computed `body_sha256` over the exact bytes
  transmitted, the returned review id/URL and confirmed commit, the runtime
  versions and image digest, and the verified login from the provisioning record.
  GitHub refusal, an ambiguous outcome and an audit failure after a confirmed
  post are never reported as complete success; a failed audit is retained as
  `posted_audit_pending` and retried without reposting the review.

  **A permanent gateway-boundary lane** registers the plugin through the same
  `api.registerTool` mechanism and requires the handler to execute in the gateway
  process: the host context posts and reads a host-only marker, while the sandbox
  context is refused (`handler_sandboxed`) and cannot read it.
