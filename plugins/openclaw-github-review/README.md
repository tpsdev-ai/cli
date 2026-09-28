# openclaw-github-review

A separate, independently versioned OpenClaw plugin that exposes **one**
host-side verb, `github_review`. It lets a reviewer agent post a pull-request
review under a trusted identity **without the GitHub credential ever entering
the sandbox**.

It shares nothing with `openclaw-tps-mail`: its own installation, deployment and
rollback lifecycle, its own dependency tree, and no mail code.

## What it does

`github_review` takes `{ repo, pr, commit_id, event, body }` — all of it caller
input, none of it trusted on its own — and:

1. **Binds to the session's dispatch assignment.** The tool factory receives the
   gateway's trusted session context and the verb is offered ONLY to the
   configured reviewer agent. `repo` and `pr` are caller-supplied and must EQUAL
   the immutable `{repo, pr}` assignment the host created for that session; the
   session's agent, and the assignment's reviewer, must match the host signing
   identity. A missing, expired, inactive or mismatched assignment refuses
   posting.
2. **Resolves the head itself.** The host fetches the PR and requires it to be
   open and the caller's `commit_id` to equal both the host-recorded reviewed
   commit and the fetched head. Caller metadata is never trusted.
3. **Keeps the credential on the host.** A fine-grained personal access token is
   read **once**, at gateway start, into a `#private` field of the custody object
   — reachable by no method. Its path is not re-read; it appears in no
   environment, log, tool result or session. Scope (login, repository coverage,
   permissions) is verified from **trusted provisioning evidence** bound to the
   installed credential **before any request**: unknown or stale evidence
   disables posting (fails closed).
4. **Posts exactly what was validated.** The request is built internally from the
   validated assignment, event, commit and body; there is no endpoint, header or
   method passthrough. `body` is treated as opaque text and is sent unchanged.
5. **Publishes a signed audit record.** Every posting emits a Flair `OrgEvent`
   (`kind: pr_review_posted`) with the reviewer identity, the canonical repo, the
   PR number and posted commit, a host-computed `body_sha256` taken over the
   UTF-8 body handed to the serializer, the returned review id/URL, the review
   environment's runtime versions and image digest, and the verified login from
   the provisioning record. The runtime versions and digest are `null` until the
   reviewer image (section A) supplies them; the gateway's own versions are never
   presented as the review's.
6. **Reports partial outcomes honestly.** A GitHub refusal is a refusal. An
   ambiguous GitHub outcome, or a 2xx whose receipt does not validate, is
   reported as **`unknown`** (a review may exist) and latches the dispatch so a
   retry cannot post a second review. An audit failure after a confirmed post is
   `posted_audit_pending`, retained for host-side retry **without** reposting the
   review. A post is never followed by a throw, and no failure after a post
   surfaces a host path.

`github_review` executes in the gateway process; a sandboxed (`mode=all`) session
is not refused — the tool runs there like any other gateway tool, and the
sandbox/host contrast is a deployment property established by the CI lane below.

## Configuration

All values come from the gateway's plugin config. None come from tool input, and
`assignmentsFile` in particular is never read from the environment.

| Key | Meaning |
| --- | --- |
| `allowedRepositories` | The host-configured `owner/repo` set. |
| `maxBodyBytes` | **Required.** Finite UTF-8 byte cap for a body; absent/invalid disables posting. |
| `credentialFile` | Path to the fine-grained PAT (mode 0600). |
| `provisioningFile` | Trusted evidence bound to the token's install/rotation. |
| `assignmentsFile` | Host-managed dispatch assignment store. |
| `signingKeyFile` | The reviewer's Flair signing key (separate custody). |
| `reviewerIdentity` | The reviewer the signing key belongs to. |
| `pendingAuditFile` | **Required.** Where a failed-after-post audit record is retained for retry. |
| `reconcileFile` | **Required.** Durable per-dispatch latch for outcomes whose external state is unknown. |
| `flairUrl` | The Flair base URL. |
| `sandboxImageDigest` | Recorded in every audit record once section A supplies it. |
| `provisioningMaxAgeDays` | Evidence older than this is stale. Default 90. |

The credential read and the audit retry are host-side work and run only on a
**full** registration (`api.registrationMode === "full"`); discovery and
cli-metadata registrations do not read the credential.

## CI

The suite runs through an isolated launcher (`scripts/run-tests.mjs`) and writes
`test-reports/github-review.xml`, which the repository's coverage guard reads. A
dedicated **gateway-boundary lane** (`test/gateway-boundary.test.ts`) loads the
BUILT plugin through OpenClaw's own registration machinery with a `mode=all`
reviewer configuration and proves the handler executes in the gateway process
(the host-only marker's contents are readable there); it also drives the secret
scans over the success, refusal, rejected, ambiguous and audit-failure paths.

## Scope

This plugin implements the host-side, credential-custody and audit parts of the
reviewer design. The reviewer sandbox **image matrix** and the real container
half of the boundary lane are follow-ups; build/test evidence binding for
`APPROVE` is a separate slice.
