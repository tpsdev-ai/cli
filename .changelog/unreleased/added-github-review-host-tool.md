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
  gateway start into a `#private` field of the custody object; the one method
  that returns a value built from it builds the Authorization header for the
  plugin's own GitHub client and is called nowhere else. Its path is not
  re-read, and neither the token nor its location appears in any environment,
  log, tool result or session. Repository coverage and permission scope are
  verified from trusted provisioning evidence bound to the installed credential
  BEFORE any request; unknown or stale evidence disables posting, so posting
  fails closed rather than falling back to an online check. Only a full
  registration reads the credential or the signing key or retries audits; any
  other registration mode reads no secret, never throws, and — when OpenClaw
  executes the tool from an on-demand `tool-discovery` registration in the
  gateway process — reuses the state the full registration loaded.

  **The body is opaque and the digest is faithful.** The review request is built
  internally from the validated assignment, event, commit and body, with no
  caller-selected endpoint or header, and `body` is sent unchanged. The audit
  record for a created review is a signed Flair `OrgEvent` (`kind:
  pr_review_posted`) whose `detail` carries the host-computed `body_sha256` over
  the UTF-8 body handed to the serializer, the returned review id/URL and
  confirmed commit, the review environment's runtime versions and image digest
  (null until the reviewer image supplies them), and the verified login from
  the provisioning record. A created review is reported `posted` (audit
  acknowledged), `posted_audit_pending` (the record is retained and retried at
  the next start, without reposting) or `posted_audit_unretained` (the review
  exists but its audit record was lost; one host log line names it).

  **At most one verdict per dispatch, unless the host's reconciliation
  releases it.** The dispatch is durably reserved (fsync'ed temp file, atomic
  rename, fsync'ed directory) BEFORE the review is posted, and nothing is posted
  if that fails. A validated receipt latches the dispatch `posted` (every later
  call: `already_posted`); a definitive rejection removes the reservation; a
  reservation left by a crash or an unrecorded outcome, an ambiguous outcome
  and a 2xx with an invalid receipt all refuse with `reconcile_required` until
  the host's audited `latch-admin reconcile` checks GitHub with the same
  credential, records the result (signed Flair event, or a local audit line
  when Flair is down) and releases the dispatch only if no review exists. A
  `posted` latch is final. A concurrent call is refused while one is in flight
  (`dispatch_in_flight`). Nothing after the POST throws: fallible metadata is
  prepared first and every post-result step is contained. Both durable stores
  must be readable and writable before any request, and an unparsable store is
  never overwritten.

  **A permanent gateway-boundary lane** runs the BUILT plugin in a node process
  against the pinned OpenClaw 2026.8.1: it registers through OpenClaw's loader
  from the shipped manifest with zero diagnostics (the shipped manifest rejects
  the CI probe, which registers only from a lane-created overlay); under the
  reviewer's `sandbox.mode: "all"` the verb is withheld by OpenClaw's default
  sandbox tool policy and offered with the documented `alsoAllow`; dispatched
  through the gateway's tools.invoke path it posts through the plugin's real
  GitHub and Flair clients to `posted` with the audit acknowledged; the probe
  reports the gateway process identity and reads the host-only marker there;
  and every run is secret-scanned. The lane runs OpenClaw's loader, gateway
  tool resolution and tools.invoke dispatch in one node process; it starts no
  sandbox container and no embedded agent runner, so the container half of the
  contrast is deferred to section A.
