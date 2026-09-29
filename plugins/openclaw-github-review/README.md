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
5. **Audits every review it creates — and says when the audit is not
   complete.** The audit record is a signed Flair `OrgEvent` (`kind:
   pr_review_posted`) with the reviewer identity, the canonical repo, the PR
   number and posted commit, a host-computed `body_sha256` taken over the UTF-8
   body handed to the serializer, the returned review id/URL, the review
   environment's runtime versions and image digest, and the verified login from
   the provisioning record. The runtime versions and digest are `null` until the
   reviewer image (section A) supplies them; the gateway's own versions are never
   presented as the review's. A created review is reported as exactly one of:
   - `posted` — the receipt validated and Flair acknowledged the audit record;
   - `posted_audit_pending` — Flair did not acknowledge it; the record is
     retained in `pendingAuditFile` and retried at the next gateway start,
     without reposting the review;
   - `posted_audit_unretained` — Flair did not acknowledge it AND it could not
     be retained: the review exists, its audit record is lost, and one host log
     line names the event id so the host can record it.
6. **Posts at most one verdict per dispatch, unless the host's reconciliation
   releases it.** Before the review is POSTed, the dispatch is durably
   **reserved** in `reconcileFile` (see Dispatch latches); if that write fails,
   nothing is posted (`store_unavailable`). A validated receipt turns the
   reservation into `posted`, and every later call refuses with
   `already_posted` (a further review needs a fresh dispatch). A definitive
   GitHub rejection (a 4xx: no review was created) removes the reservation. A
   reservation that is still there on a later call — a crash, or an outcome
   that could not be recorded — and an uncertain outcome both refuse every call
   with `reconcile_required` until the host's audited reconciliation checks
   GitHub; it releases the dispatch only when no review exists. While one call
   for a dispatch is in flight in the gateway, a second is refused with
   `dispatch_in_flight`. The tool also declares `executionMode: "sequential"`;
   OpenClaw 2026.8.1 honours it on a freshly resolved tool but drops it on its
   cached tool descriptors, so the guards do not depend on it. The latch file is
   host-owned: editing it by hand bypasses all of this.
7. **Reports partial outcomes honestly.** A GitHub refusal is a refusal. An
   ambiguous GitHub outcome, or a 2xx whose receipt does not validate, is
   reported as **`unknown`** (a review may exist) and latches the dispatch
   `reconcile_required`. Nothing after the POST throws: the event id, timestamp
   and digest are prepared before the reservation, and every later step —
   latch writes, the audit write, retention, host logging — is contained. No
   refusal or log line names a host path.
8. **Fails closed on its durable stores.** Both stores (the dispatch latch file
   and the pending-audit file) must be configured, and must be readable and
   writable before any request (`store_unconfigured` / `store_unavailable`). A
   missing store file is empty; an unreadable or unparsable one is an error and
   is never overwritten. Every write is durable before it returns: the new
   contents go to a temp file that is fsync'ed, renamed over the store, and the
   directory is fsync'ed. That survives the gateway being killed at any point
   and, where the filesystem and device honour fsync (Linux), an OS crash or
   power loss; it does not survive storage that acknowledges fsync without
   persisting (on macOS, fsync does not flush the drive cache).

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

`reconcileFile` holds one latch per dispatch that has attempted a post:

| Latch | Set when | Tool refusal | Host remedy |
| --- | --- | --- | --- |
| `reserved` | durably, BEFORE the review is POSTed; still there later means the attempt never recorded its outcome (a crash, or a failed outcome write) | `reconcile_required` | `latch-admin reconcile` |
| `reconcile_required` | the outcome is uncertain: an ambiguous response, or a 2xx whose receipt does not match | `reconcile_required` | `latch-admin reconcile` |
| `posted` | the dispatch's review exists | `already_posted` | none: final. A further review is a fresh dispatch |

A definitive rejection removes the reservation, so a corrected retry can post.

Only the host releases a dispatch, with the command shipped in the package, run
on the gateway host as the gateway's service user, when no call for the
dispatch is running (no agent-invokable tool can release one):

```sh
node <plugin>/dist/src/latch-admin.js list      <reconcileFile>
node <plugin>/dist/src/latch-admin.js reconcile <pluginConfig.json> <dispatchId> [--audit-log <file>]
```

`<pluginConfig.json>` holds the plugin's configuration object (the same keys as
its `plugins.entries` config). `reconcile`:

1. verifies the GitHub credential exactly as the plugin does (provisioning
   evidence, repository coverage) — the same credential, used host-side;
2. lists the pull request's reviews and looks for the dispatch's review: the
   review id from a 2xx receipt, or any review by the dispatch's login on the
   dispatch's commit. A listing it cannot complete changes nothing;
3. records the result — a signed Flair `OrgEvent` (`kind:
   pr_review_reconciled`, signed with the reviewer key the plugin uses), or,
   when Flair does not acknowledge it, one fsync'ed line in the local audit log
   (`<reconcileFile>.audit.jsonl` by default) — and prints which. If neither
   can be written, nothing changes;
4. then latches the dispatch `posted` when a review exists, and releases it
   only when none does.

A `posted` latch is refused (`reconcile` and `clear` both), and `clear` never
changes the store for any latch: it only points at `reconcile`. A store file the
command cannot parse is refused and left untouched: repair it by hand.

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

What the lane runs is exactly the list above: OpenClaw's loader, its gateway
tool resolution and its `tools.invoke` dispatch, in one node process, against
controlled services. It starts no sandbox container and does not run the
embedded agent runner, so it does not establish that sandbox execution cannot
read the marker (the container half, see Scope).

## Scope

This plugin implements the host-side, credential-custody and audit parts of the
reviewer design. The reviewer sandbox **image matrix** and the real container
half of the boundary lane (the sandbox must NOT read the marker) are follow-ups;
build/test evidence binding for `APPROVE` is a separate slice.
