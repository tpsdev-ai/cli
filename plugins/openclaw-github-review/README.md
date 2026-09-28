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
   read **once**, at gateway start, into a `#private` field of the custody
   object. The one method that returns a value built from it,
   `authorizationHeader()`, exists for the plugin's own GitHub client and is
   called nowhere else; no tool input reaches it. The path is not re-read, and
   neither the token nor its location appears in any environment, log, tool
   result or session. Scope (login, repository coverage, permissions) is
   verified from **trusted provisioning evidence** bound to the installed
   credential **before any request**: unknown or stale evidence disables
   posting (fails closed).
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
6. **Posts exactly one verdict per dispatch.** Once a dispatch's review exists
   the dispatch is latched `posted`, and every later call refuses with
   `already_posted` (a further review needs a fresh dispatch). While one call
   for a dispatch is in flight, a second is refused with `dispatch_in_flight`.
   The tool also declares `executionMode: "sequential"`; OpenClaw's runner
   serializes a batch containing it when it sees that flag, but OpenClaw 2026.8.1
   drops it on its cached tool descriptors, so the in-flight guard is what
   enforces the rule.
7. **Reports partial outcomes honestly.** A GitHub refusal is a refusal. An
   ambiguous GitHub outcome, or a 2xx whose receipt does not validate, is
   reported as **`unknown`** (a review may exist) and latches the dispatch
   `reconcile_required`, so a retry cannot post a second review. An audit
   failure after a confirmed post is `posted_audit_pending`, retained for
   host-side retry **without** reposting the review; if even retention fails the
   status is `posted_audit_unretained` and one host log line names the audit
   event. A post is never followed by a throw, and no refusal or log line names
   a host path.
8. **Fails closed on its durable stores.** Both stores (the dispatch latch file
   and the pending-audit file) must be configured, and must be readable and
   writable before any request (`store_unconfigured` / `store_unavailable`). A
   missing store file is empty; an unreadable or unparsable one is an error and
   is never overwritten. A latch that cannot be written after a post is held in
   memory until the gateway restarts, and a host log line says so.

`github_review` executes in the gateway process. A sandboxed (`mode=all`)
session is not refused by the plugin: whether the session is offered the tool at
all is decided by the reviewer's sandbox tool policy (see Install).

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
| `reconcileFile` | **Required.** The durable per-dispatch latch store (see Dispatch latches). |
| `flairUrl` | The Flair base URL. |
| `sandboxImageDigest` | Recorded in every audit record once section A supplies it. |
| `provisioningMaxAgeDays` | Evidence older than this is stale. Default 90. |

Reading the credential and the signing key, and the audit retry, are host-side
work done only by a **full** registration (`api.registrationMode === "full"`).
Every other registration mode (discovery, tool-discovery, cli-metadata,
setup-runtime, setup-only) reads no secret, retries nothing and never throws.
OpenClaw 2026.8.1 can execute a plugin tool from a `tool-discovery`
registration it loads on demand inside the gateway process; such a
registration of the SAME configuration reuses the credential custody, signing
sink and one-verdict ledger the full registration loaded (held in the plugin
module's private scope), and says so in the gateway log. With no full
registration of that configuration in the process, it refuses
`credential_unavailable`.

## Install

The lane below pins **OpenClaw 2026.8.1**, the release deployed to the reviewer
hosts; the gateway runs on the Node that release requires (`>=22.22.3 <23`,
`>=24.15 <25` or `>=25.9`). An update to any of them must pass the lane first.

1. Build the plugin (`npm ci && npm run build`) and install it into the
   gateway, e.g. with `openclaw plugins install`, or by listing its directory
   in `plugins.load.paths`.
2. Allow and configure it (`openclaw.json`):

   ```json
   "plugins": {
     "allow": ["openclaw-github-review"],
     "entries": {
       "openclaw-github-review": { "enabled": true, "config": { "…": "see Configuration" } }
     }
   }
   ```

   `plugins.allow` is required for a plugin loaded from a path: without it the
   loader flags the plugin's provenance as unverified.
3. **Allow the verb in the reviewer's sandbox tool policy.** A reviewer runs
   with `sandbox.mode: "all"`, and OpenClaw's DEFAULT sandbox tool allow list
   (`DEFAULT_TOOL_ALLOW`) does not include `github_review`: without this step the
   reviewer is never offered the verb. Add it with `alsoAllow`, for the
   reviewer only:

   ```json
   "agents": {
     "entries": {
       "<reviewer>": {
         "sandbox": { "mode": "all" },
         "tools": { "sandbox": { "tools": { "alsoAllow": ["github_review"] } } }
       }
     }
   }
   ```

   (`tools.sandbox.tools.alsoAllow` applies it to every sandboxed agent; the
   plugin still offers the verb only to `reviewerIdentity`.) Use `alsoAllow`,
   not `allow`: an explicit `allow` list REPLACES the default one, removing
   every tool it does not name.

## Dispatch latches (host procedure)

`reconcileFile` holds one latch per dispatch that must not post again:

| Latch | Set when | Tool refusal | Host remedy |
| --- | --- | --- | --- |
| `posted` | the dispatch's review exists | `already_posted` | none needed: a further review is a fresh dispatch |
| `reconcile_required` | a post's outcome is unknown (ambiguous response, or a receipt that does not match) | `reconcile_required` | reconcile the PR's reviews on GitHub, then clear the latch |

Only the host clears a latch, with the command shipped in the package, run on
the gateway host as the gateway's service user (no agent-invokable tool can
clear one):

```sh
node <plugin>/dist/src/latch-admin.js list  <reconcileFile>
node <plugin>/dist/src/latch-admin.js clear <reconcileFile> <dispatchId>
```

A store file the command cannot parse is refused and left untouched: repair it
by hand. A latch the gateway logged as "held in memory" is not in the file;
reconcile, then restart the gateway to drop it.

## CI

The suite runs through an isolated launcher (`scripts/run-tests.mjs`) and writes
`test-reports/github-review.xml`, which the repository's coverage guard reads.
`npm run typecheck:test` typechecks the tests as well as the sources.

The dedicated **gateway-boundary lane** (`test/gateway-boundary.test.ts`) runs
the BUILT plugin in a separate **node** process (`test/gateway-driver.mjs`)
against the pinned OpenClaw release, with controlled GitHub and Flair services
installed as the global `fetch` before registration:

- it registers through OpenClaw's own loader, which reads the plugin record
  (contracts included) from the SHIPPED `openclaw.plugin.json` and validates the
  config against its schema — zero diagnostics, exactly the one tool;
- the shipped manifest REJECTS the CI probe (the undeclared-contract
  diagnostic); the probe registers only from a manifest overlay the lane creates
  in its temp directory;
- with the reviewer configured `sandbox.mode: "all"`, OpenClaw's gateway tool
  resolution does not offer the verb under the default sandbox tool policy and
  does under the documented `alsoAllow`;
- dispatched through the gateway's `tools.invoke` path, the verb posts through
  the plugin's real GitHub and Flair clients to `posted` with the audit
  acknowledged, refuses a second call `already_posted`, and posts a concurrent
  pair once;
- the probe, dispatched the same way, reports the gateway process identity,
  reads the host-only marker and sees the sandboxed session context, and every
  controlled-service request came from that process;
- every run is scanned for the token, the signing key, the marker contents and
  the credential locations (results, logs, diagnostics, process output, launch
  data, and what reached Flair).

The lane does not start a sandbox container or the embedded agent runner.

## Scope

This plugin implements the host-side, credential-custody and audit parts of the
reviewer design. The reviewer sandbox **image matrix** and the real container
half of the boundary lane (the sandbox must NOT read the marker) are follow-ups;
build/test evidence binding for `APPROVE` is a separate slice.
