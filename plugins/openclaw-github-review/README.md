# openclaw-github-review

A separate, independently versioned OpenClaw plugin that exposes **one**
host-side verb, `github_review`. It lets a reviewer agent post a pull-request
review under a trusted identity **without the GitHub credential ever entering
the sandbox**.

It shares nothing with `openclaw-tps-mail`: its own installation, deployment and
rollback lifecycle, its own dependency tree, and no mail code.

## What it does

`github_review` takes `{ repo, pr, commit_id, event, body }` and:

1. **Binds to the session's dispatch assignment.** The tool factory receives the
   gateway's trusted session context. `repo` and `pr` must match the immutable
   `{repo, pr}` assignment the host created for that session, and the
   assignment's reviewer must match the host signing identity. A missing,
   expired, inactive or mismatched assignment refuses posting.
2. **Resolves the head itself.** The host fetches the PR and requires it to be
   open and the caller's `commit_id` to equal both the host-recorded reviewed
   commit and the fetched head. Caller metadata is never trusted.
3. **Keeps the credential on the host.** A fine-grained personal access token is
   read **once**, at gateway start, into the handler's closure. Its path is not
   re-read; it appears in no environment, log, tool result or session. Scope
   (login, repository coverage, permissions) is verified from **trusted
   provisioning evidence** bound to the installed credential **before any
   request**: unknown or stale evidence disables posting (fails closed).
4. **Posts exactly what was validated.** The request is built internally from the
   validated assignment, event, commit and body; there is no endpoint, header or
   method passthrough. `body` is treated as opaque bytes and is sent unchanged.
5. **Publishes a signed audit record.** Every posting emits a Flair `OrgEvent`
   (`kind: pr_review_posted`) with the reviewer identity, the canonical repo, the
   PR number and posted commit, a host-computed `body_sha256` over the exact
   bytes sent, the returned review id/URL, the observed runtime versions and the
   verified login from the provisioning record.
6. **Reports partial outcomes honestly.** GitHub refusal, an ambiguous GitHub
   outcome and an audit failure after a confirmed post are never reported as
   complete success. A failed audit is retained host-side as
   `posted_audit_pending` and retried **without** reposting the review.

The handler **refuses to run inside the sandbox**. It executes in the gateway
process; a sandboxed context is refused with `handler_sandboxed`.

## Configuration

All values come from the gateway's plugin config (`plugins.openclaw-github-review`,
and the keys below). None come from tool input.

| Key | Meaning |
| --- | --- |
| `allowedRepositories` | The host-configured `owner/repo` set. |
| `maxBodyBytes` | **Required.** Finite UTF-8 byte cap for a body; absent/invalid disables posting. |
| `credentialFile` | Path to the fine-grained PAT (mode 0600). |
| `provisioningFile` | Trusted evidence bound to the token's install/rotation. |
| `assignmentsFile` | Host-managed dispatch assignment store. |
| `signingKeyFile` | The reviewer's Flair signing key (separate custody). |
| `reviewerIdentity` | The reviewer the signing key belongs to. |
| `pendingAuditFile` | Where a failed-after-post audit record is retained for retry. |
| `flairUrl` | The Flair base URL. |
| `sandboxImageDigest` | Recorded in every audit record. |
| `provisioningMaxAgeDays` | Evidence older than this is stale. Default 90. |

## CI

The suite runs through an isolated launcher (`scripts/run-tests.mjs`) and writes
`test-reports/github-review.xml`, which the repository's coverage guard reads. A
dedicated **gateway-boundary lane** (`test/gateway-boundary.test.ts`) registers
the plugin through `api.registerTool` and proves the host/sandbox contrast.

## Scope

This plugin implements the host-side, credential-custody and audit parts of the
reviewer design. The reviewer sandbox **image matrix** and the real container
half of the boundary lane are follow-ups; build/test evidence binding for
`APPROVE` is a separate slice.
