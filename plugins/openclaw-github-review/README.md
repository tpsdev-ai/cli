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
5. **Reports every outcome, and says exactly which ones carry an audit
   record.** The audit record is a signed Flair `OrgEvent` (`kind:
   pr_review_posted`) with the reviewer identity, the canonical repo, the PR
   number and posted commit, a host-computed `body_sha256` taken over the UTF-8
   body handed to the serializer, the returned review id/URL, the review
   environment's runtime versions and image digest, and the verified login from
   the provisioning record. The runtime versions and digest are `null` until the
   reviewer image (section A) supplies them; the gateway's own versions are never
   presented as the review's. It can only be built from a readable 2xx receipt.

   | Outcome | GitHub response | Audit record | Dispatch afterwards |
   | --- | --- | --- | --- |
   | `posted` | 2xx, receipt validates | acknowledged by Flair | `posted` (final) |
   | `posted_audit_pending` | 2xx, receipt validates | not acknowledged; retained in `pendingAuditFile` and retried at the next gateway start, without reposting | `posted` |
   | `posted_audit_unretained` | 2xx, receipt validates | not acknowledged, and its retention for retry not durably confirmed (a retention write may have become visible before failing); one host log line naming the event id is attempted | `posted` |
   | `unknown` (`receipt_invalid`) | 2xx, receipt does not match the request | attempted as for a validated receipt; the result carries its id only when acknowledged | `reconcile_required` |
   | `unknown` (`receipt_invalid`) | 2xx, receipt unreadable | none (no receipt to build it from) | `reconcile_required`, with the review id when readable |
   | `unknown` (`reconcile_required`) | ambiguous (see 7) | none | `reconcile_required` |
   | refused `github_rejected` | a response that proves no review was created (see 7) | none | released |

6. **Posts at most one verdict per dispatch — for the processes that share the
   latch store's lock.** Before the review is POSTed the dispatch is CLAIMED: under
   the store's exclusive lock, one check-and-write records `reserved` together
   with this call's claim, so of two calls or processes claiming one dispatch
   exactly one succeeds (see Dispatch latches); if the claim cannot be made
   durable, nothing is posted (`store_unavailable`). The claim is held across
   the POST. A validated receipt settles it `posted` (every later call:
   `already_posted`; a further review needs a fresh dispatch); an uncertain
   outcome settles it `reconcile_required`. A dispatch whose claim is still
   held — in flight, or left by a process that stopped — is refused with
   `dispatch_in_flight`; any other latch is refused. Exactly ONE thing
   releases a dispatch: the handler, on a response that proves its own POST
   created no review (see 7). Nothing independent can prove that a POST which
   may have started created nothing, so the host's `latch-admin reconcile`
   never releases: it latches `posted` when the recorded receipt id is listed,
   and otherwise the dispatch stays latched — a further review is a FRESH
   dispatch.
   The tool also declares `executionMode: "sequential"`; OpenClaw 2026.8.1
   honours it on a freshly resolved tool but drops it on its cached tool
   descriptors, so the guards do not depend on it. The latch file is
   host-owned: editing it by hand, or pointing two hosts at one file, bypasses
   all of this.
7. **Treats only proof as a rejection.** A non-2xx response proves no review
   was created only when it is 401, 403, 404 or 422 — GitHub's documented
   rejections for this endpoint (bad credentials, forbidden, not found,
   validation failed) — AND carries GitHub's `X-GitHub-Request-Id` header (the
   same status from an intermediary proves nothing). Everything else is
   ambiguous — a review may exist: 408 and 429, any other 4xx, every 5xx and
   3xx, a transport failure or a request that exceeds the 30 s request
   timeout (every outbound request — the GitHub GETs and POST and the Flair
   audit write — is bounded by it; a timed-out audit write is retained like any
   failed one), a 2xx whose body cannot be read. After the POST
   the handler returns an outcome and does not throw: the event id, timestamp
   and digest are prepared before the claim; the POST's result is read once,
   field by field, into checked values; every later step (latch writes, the
   audit write, retention, host logging) is contained; and the last-resort
   fallback uses only values captured before. No refusal or log line names a
   host path; a host log line is an attempt (a failing logger is ignored).
8. **Fails closed on its durable stores.** Both stores (the dispatch latch file
   and the pending-audit file) must be configured, and must be readable and
   writable before any request (`store_unconfigured` / `store_unavailable`). A
   missing store file is empty; an unreadable or unparsable one is an error and
   is never overwritten. Every read-modify-write (not every read, and not the
   pre-request probes) runs under the store's
   exclusive lock (an O_EXCL lock file, `<store>.lock`); the lock serializes
   the processes on ONE host that use the same file on a LOCAL filesystem —
   that is its scope. A lock whose holder died is stale: operations fail
   closed, naming the lock file, its holder and the remedy (confirm no process
   is working on the store, then remove the lock file); nothing removes it
   automatically. Every write is durable before it returns: the new contents
   go to a uniquely named, exclusively created temp file that is fsync'ed,
   renamed over the store, and the directory is fsync'ed. That survives the
   process being killed at any point and, where the filesystem and device
   honour fsync (Linux), an OS crash or power loss; it does not survive storage
   that acknowledges fsync without persisting (on macOS, fsync does not flush
   the drive cache).

`github_review` executes in the gateway process. A sandboxed (`mode=all`)
session is not refused by the plugin: whether the session is offered the tool at
all is decided by the reviewer's sandbox tool policy (see Install).

## Approval evidence

`APPROVE` requires a host-side record of the review's build/test run for the
same reviewer, session and full commit, and every command in it must have
exited 0. `REQUEST_CHANGES` and `COMMENT` are unaffected.

The record is written by the host process that runs the review build, to
`approvalEvidenceFile`. Nothing inside the sandbox can write or read-modify that
file: the sandbox mounts only the review worktree and has no other host
filesystem access. The record binds the reviewer, the session key, the commit,
the commands with their exit statuses and a finish time, under a SHA-256 over
those fields; `github_review` re-computes the digest, so a record edited after
it was written no longer matches. The digest is recorded in the signed audit
record as `approval_evidence_sha256`. APPROVE is refused when the evidence is
missing or unconfigured, incomplete, failed, bound to a different reviewer,
session or commit, or does not match its digest.

The limit, stated: the evidence proves the repository's own build and tests ran
and passed on that commit, not that they are adequate.

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
| `approvalEvidenceFile` | **Required for `APPROVE`.** Host-only store of the review-build evidence (see Approval evidence). |
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
The package declares that release as its floor — `peerDependencies.openclaw`
and `openclaw.compat.pluginApi` are both `>=2026.8.1` — because it is the only
release the lane verifies (the plugin relies on its loader and tool-discovery
behaviour); a newer release must pass the lane before rollout.

1. Build the plugin (`npm ci --ignore-scripts && npm run build`) and install it
   into the gateway, e.g. with `openclaw plugins install`, or by listing its
   directory in `plugins.load.paths`. `--ignore-scripts`, as in CI: the plugin
   needs no install script, while the dev dependency tree it builds against
   carries several (openclaw, @google/genai, protobufjs, tree-sitter-bash, and
   — new with OpenClaw 2026.8.1's tree — koffi), none of which should run on a
   reviewer host.
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

`reconcileFile` holds one entry per dispatch that has attempted a post. Each
records the attempt: repo, PR, commit, the login it posted as, the sha256
fingerprint of the credential that made it (the binding the provisioning
evidence records — never the token), when it was reserved, the review id from
a 2xx receipt, and — while the gateway holds it — the claim (pid, host, time).

| Latch | Set when | Tool refusal | Who can release it |
| --- | --- | --- | --- |
| `reserved` + claim | durably, BEFORE the review is POSTed; the claim is held across the POST | `dispatch_in_flight` | only the handler that holds the claim, on a proved rejection (401/403/404/422 with GitHub's request id). Nobody else — not after the claim is gone, and not after `--stale-claim` overrides a claim still stored on the entry. A further review is a fresh dispatch |
| `reconcile_required` | the outcome is uncertain: an ambiguous response, or a 2xx whose receipt does not match or cannot be read | `reconcile_required` | nobody. `reconcile` latches it `posted` when its recorded receipt id is listed; a further review is a fresh dispatch |
| `posted` | the dispatch's review exists | `already_posted` | nobody: final. A further review is a fresh dispatch |

The host's command, shipped in the package, run on the gateway host as the
gateway's service user (no agent-invokable tool reaches it):

```sh
node <plugin>/dist/src/latch-admin.js list      <reconcileFile>
node <plugin>/dist/src/latch-admin.js reconcile <pluginConfig.json> <dispatchId> [--audit-log <file>] [--stale-claim]
```

`<pluginConfig.json>` holds the plugin's configuration object (the same keys as
its `plugins.entries` config). `reconcile`:

1. refuses while the gateway's claim is held — the attempt may be in flight.
   If its process is gone (the gateway was stopped or restarted since), rerun
   with `--stale-claim`; that is still refused while the claiming pid is alive
   on this host (a claim from another host cannot be checked, so the operator's
   `--stale-claim` is taken as their statement, and recorded);
2. refuses an attempt younger than 10 minutes;
3. requires the credential its configuration loads to be the one that made the
   attempt (same fingerprint) and its provisioning evidence to name the
   attempt's login: a rotated or different credential is refused
   (`credential_mismatch`, `login_mismatch`), and such a dispatch stays latched
   — a further review needs a fresh dispatch;
4. lists every review on the pull request with that credential (a listing it
   cannot complete changes nothing) and decides — there is NO release:
   - **latch `posted`** only on proof: the review id recorded from the
     attempt's 2xx receipt is in the listing;
   - **retain** in every other case — an empty listing, an attempt that
     recorded no receipt id, a recorded id that is not listed, a review by the
     attempt's login on its commit WITHOUT the recorded id (it may predate the
     attempt) — and print the remedy: the dispatch stays latched; to review the
     pull request again, issue a FRESH dispatch (a new dispatchId). That is
     also the retry path after a credential rotation;
5. RECORDS the decision before changing anything: a Flair `OrgEvent` (`kind:
   pr_review_reconciled`), or — when Flair does not acknowledge it — one line
   in the local audit log (`<reconcileFile>.audit.jsonl` by default), with the
   line AND its directory fsync'ed before every append returns (another writer
   may have created the file); it prints which. If neither can be written,
   nothing changes;
6. applies a `posted` decision under the store lock, only if the entry is
   unchanged since step 1.

ATTRIBUTION. The plugin configures no host principal: the reconciliation event
is signed with the REVIEWER's Flair key (`signingKeyFile`) and its `authorId` is
the reviewer. The only operator identity the command knows is the OS account
that ran it (user, uid, host, pid), recorded as `invoked_by`.

`clear` never changes the store: it points at `reconcile` and the fresh-dispatch
remedy. A store file the
command cannot parse is refused and left untouched: repair it by hand. A stale
lock is reported with its path and the remedy.

## CI

The suite runs through an isolated launcher (`scripts/run-tests.mjs`) and writes
`test-reports/github-review.xml`, which the repository's coverage guard reads; a
run that exits 0 without that report fails (only a caller-supplied `--reporter`
may skip it).
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

What the lane runs is exactly the list above: OpenClaw's loader, its gateway
tool resolution and its `tools.invoke` dispatch, in one node process, against
controlled services. It starts no sandbox container and does not run the
embedded agent runner, so it does not establish that sandbox execution cannot
read the marker (the container half, see Scope).

## Scope

This plugin implements the host-side, credential-custody and audit parts of the
reviewer design, and the `APPROVE` build/test evidence binding. The reviewer
sandbox **image matrix** and the real container half of the boundary lane (the
sandbox must NOT read the marker) are follow-ups.
