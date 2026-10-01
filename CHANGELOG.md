# Changelog

All notable changes to the TPS CLI are recorded here.

## [Unreleased]

### Removed

- **The unused root CLI tree (root `src/`, `bin/tps.ts`, `scripts/stall-monitor.ts`) is deleted; the CLI lives in `packages/cli` (Closes #379).**

### Fixed

- **The codex runtime records liveness on Flair's Presence resource instead of writing `Agent.status` (Closes #444).** `Agent.status` is the principal's lifecycle state, so the shutdown write of `"offline"` deactivated the agent — its requests were refused with `401 principal_deactivated`, and the matching `"online"` write could never succeed. The runtime now POSTs `/Presence` with the agent's own credential on each heartbeat and on shutdown (a final `activity: "idle"` beat); Flair derives `offline` from heartbeat age. A Presence failure only logs and never falls back to the Agent row.
## [0.8.0] — 2026-09-30

**Breaking:** see **Breaking: `tps mail send` requires a usable sender signing key, refuses a recipient it has no route for, and prints only delivery metadata with `--json` (cli#429, cli#389).** under **Changed**.

### Added

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
  log, tool result or session. Credential binding and evidence freshness are
  checked at full registration; repository coverage and permission scope are
  checked before posting using the loaded evidence. Evidence that is missing,
  not bound to the installed credential or stale at registration leaves posting
  disabled, with no fallback to an online check. Only a full
  registration reads the credential or the signing key or retries audits; any
  other registration mode reads no secret, never throws, and — when OpenClaw
  executes the tool from an on-demand `tool-discovery` registration in the
  gateway process — reuses the state the full registration loaded.

  **The body is opaque and the digest is faithful.** The review request is built
  internally from the validated assignment, event, commit and body, with no
  caller-selected endpoint or header, and `body` is sent unchanged. The audit
  record — a signed Flair `OrgEvent` (`kind: pr_review_posted`) whose `detail`
  carries the host-computed `body_sha256` over the UTF-8 body handed to the
  serializer, the returned review id/URL and confirmed commit, the review
  environment's runtime versions and image digest (null until the reviewer
  image supplies them), and the verified login from the provisioning record —
  can only be built from a readable 2xx receipt. A validated receipt is
  reported `posted` (audit acknowledged), `posted_audit_pending` (retained and
  retried at the next start, without reposting) or `posted_audit_unretained`
  (the review exists; the audit was not acknowledged and its retention for
  retry was not durably confirmed; a host log line is attempted).
  A 2xx whose receipt does not match is `unknown` (`receipt_invalid`) with the
  audit attempted; one whose receipt cannot be read, and an ambiguous
  response, are `unknown` with NO audit record. Every `unknown` leaves the
  dispatch latched.

  **At most one verdict per dispatch, for the processes that share the latch
  store's lock.** Every read-modify-write of a store runs under one exclusive
  O_EXCL lock per store file (one host, local filesystem; a stale lock fails
  closed with its path and the remedy). Before the review is posted the
  dispatch is claimed — `reserved` plus this call's claim, one atomic
  check-and-write, durable (unique exclusive temp file, fsync, atomic rename,
  fsync'ed directory) — and nothing is posted if that fails. The claim is held
  across the POST. A validated receipt latches `posted` (final:
  `already_posted`); an uncertain outcome latches `reconcile_required`.
  Exactly ONE thing releases a dispatch: the handler, on a response proving
  its own POST created no review (401/403/404/422 that carry GitHub's request
  id — 408, 429, other 4xx, 5xx, transport failures and requests past the
  30 s timeout that bounds every outbound request are ambiguous). The
  host's `latch-admin reconcile` never releases: it refuses while the claim is
  held and on a recent attempt, requires the credential (by fingerprint) and
  login that made the attempt, lists the pull request's reviews with it, and
  latches `posted` only when the attempt's recorded receipt id is listed;
  otherwise — an empty listing, or a same-login same-commit review without
  that id — the dispatch stays latched and it tells the operator to issue a
  fresh dispatch. It records its decision first, as a Flair event signed with
  the reviewer's key (the OS account that ran it recorded as `invoked_by`), or
  as a local audit line whose file and directory are fsync'ed before every
  append returns. After the POST the handler returns an outcome without
  throwing. Both durable stores must be readable and writable before any
  request, and an unparsable store is never overwritten.

  **A permanent gateway-boundary lane** runs the BUILT plugin in a node process
  against the pinned OpenClaw 2026.8.1: it registers through OpenClaw's loader
  from the shipped manifest with zero diagnostics (the shipped manifest rejects
  the CI probe, which registers only from a lane-created overlay); under the
  reviewer's `sandbox.mode: "all"` the verb is withheld by OpenClaw's default
  sandbox tool policy and offered with the documented `alsoAllow`; dispatched
  through the gateway's tools.invoke path it posts through the plugin's real
  GitHub and Flair clients to `posted` with the audit acknowledged; the probe
  reports the gateway process identity and reads the host-only marker there;
  and the lane runs that invoke the tool are secret-scanned. The lane runs
  OpenClaw's loader, gateway tool resolution and tools.invoke dispatch in one
  node process.

- **The CLI package now exports `@tpsdev-ai/cli/utils/mail-routing` and `@tpsdev-ai/cli/utils/relay` for integrations.**

  `utils/mail-routing` is the outbound routing decision `tps mail send` makes,
  and `utils/relay` holds the remote-branch and branch-office bridge delivery
  it uses; the openclaw-tps-mail plugin imports both instead of keeping its own
  copies.

  (Refs #389)

- **`tps mail send` takes its body on stdin, threads replies inside the signature, can re-send a message under the same id, and reads the keys `bob onboard` and `tps init` write (cli#429).**

  Mail send supports stdin input and signed reply threading, accepts the
  documented Ed25519 key formats, and requires successful signing before
  delivery. What signing now requires of existing callers is in the Breaking
  entry for `tps mail send`.

  **`--stdin`: the body is read from stdin, never from argv.** The reader uses
  fd 0 directly, caps input at 64 KiB, distinguishes empty input, and bounds
  consecutive EAGAIN retries on nonblocking stdin. It never goes through
  `process.stdin`, so a regular-file, memfd or pipe stdin yields the same bytes
  under bun. The 64 KiB limit is enforced on the SIGNED message (the body plus
  its signature and envelope fields) before any route: a body just under the
  limit whose signed envelope is over it is refused by name, and nothing is
  written. The command never prints the body, and no error carries it.

  **`--reply-to <messageId>`: threading covered by the signature.** The signed
  `messageId` being answered is carried inside the envelope, so the signature
  covers it. One id rule — letters, digits, dot, underscore or hyphen, 1-128
  characters — applies to `--reply-to` and `--message-id`. The thread is shown
  by `mail check`, `mail list`, `mail read` and `mail log` for verified mail
  only.

  **`--message-id <id>`: a re-send is the same message.** The envelope is
  signed with that `messageId` instead of a fresh UUID, so a sender that
  re-sends after an unknown outcome produces the same message. A recipient
  that still finds that id recorded as consumed dead-letters the re-send as a
  replay; otherwise the copy may be delivered.

  **Keys: one search path, strict formats, no silent choice.** A signer
  resolving a key by agent id reads `~/.flair/keys/<id>.key` and
  `~/.tps/identity/<id>.key` (where `tps init` and `tps agent create` put it).
  When both exist they must hold the same key: two different keys are refused,
  naming both paths and the remedy, instead of one being chosen. A file that
  cannot be read or parsed is an error naming its path. Accepted formats: a raw
  32-byte seed, one line of base64 PKCS8 DER, raw PKCS8 DER, or exactly one
  unencrypted PEM `PRIVATE KEY` block — each parsed strictly (the whole input
  must be the one key; encrypted keys and other algorithms are refused by name;
  errors never contain key material).

  **pi-tps-mail: the watcher sends each reply as one message.** The reply goes
  out on stdin with `--reply-to` the inbound's verified envelope id, and is
  journaled first with the envelope `messageId` it is signed with. A send whose
  outcome is unknown (a non-zero exit or a timeout) is re-sent later as the
  same message: a recipient that still finds that id recorded as consumed
  dead-letters it as a replay, and otherwise the copy may be delivered. Recovery retries
  acknowledgement without resending when the journal records `sent`; if that
  write did not persist, it may resend using the same envelope message ID. If
  the watcher stops before journaling a reply, the unacknowledged inbound can be
  re-presented after lease expiry. A launcher timeout produces a diagnostic
  reply.

  (Refs #429)

- **A reviewer sandbox image with a digest-pinned base and checksum-verified runtimes, a trusted runtime table and a launcher that builds a PR the way its CI job would, as advisory evidence for the reviewer; the image bundles no credentials, and isolation from the host depends on the deployed sandbox configuration (Refs #425).**

  The reviewer environment now has its own image and launch path, defined in
  this repository. Its verdict, `review-build-ok`, is advisory evidence for the
  reviewer, not a merge gate; the CI workflow runs for pull requests that target
  `main`. The image
  bundles no credentials, and the launcher restricts its child environment and
  Git configuration. Isolation from the host depends on the deployed sandbox
  configuration. How well the build predicts CI is best effort, with its known
  limits documented in `docker/reviewer/README.md`.

  **The image** (`docker/reviewer/Dockerfile`, linux/amd64) uses a
  digest-pinned Debian base (`debian:bookworm-slim`) and checksum-verified Node,
  Bun and `gh` releases, each at the exact version and checksum the trusted
  table gives; `gh` carries no credential of its own. Git and the other system
  packages are installed through Debian's package manager: the package set of
  OpenClaw's documented sandbox build, which uses the floating
  `debian:bookworm-slim` tag (python3 is what OpenClaw's sandbox write/edit
  helpers run), plus the download and unpack tools and procps. It has no
  entrypoint and its CMD is `sleep infinity`, matching how OpenClaw starts
  sandboxes. Its default `HOME`, `USERPROFILE`, `TMPDIR` and Bun/npm caches
  point under `/tmp/review`, which is discarded with the sandbox when the
  deployed sandbox mounts `/tmp` as a tmpfs, as OpenClaw's sandbox creation
  does. It carries no credentials and no configured credential helpers.

  **The trusted table** (`docker/reviewer/runtime-matrix.json`) is maintained
  here and installed on the host. The reviewed checkout can neither extend it
  nor choose a download source.

  **The launcher** (`/opt/reviewer/bin/reviewer-launch`, from
  `scripts/reviewer/reviewer-launch.mjs`) is run explicitly. Build mode takes no
  arguments and always builds the worktree the host mounted at `/workspace`
  (`--self-check` is the only other mode). Before any repository code runs it
  reads the fixed table and the image's baked identity; takes the workflow, job
  and base branch only from the environment the HOST gave the sandbox at
  creation (`REVIEWER_CI_WORKFLOW`, `REVIEWER_CI_JOB`, `REVIEWER_CI_BASE`),
  refusing a caller that passes different values; refuses symlinked lockfiles
  and symlinked directories in the worktree; plans the job and the jobs it
  `needs`; resolves the reviewed commit's declarations (`packageManager`,
  `engines`, `.nvmrc`, `.node-version`, `.bun-version`, `.tool-versions`, each
  read with size bounds and inside the worktree) and every planned job's runtime
  pins to ONE matrix image with npm-semver range semantics; refuses unless that
  image is the one it is running in; builds the child environment from an
  allowlist (hermetic values, a fixed `PATH`, `LANG`, `LC_ALL`, `TERM`, `TZ`,
  `CI=true`); and runs the image's own Node and Bun at fixed paths to verify
  their versions. Then, job by job in dependency order, it removes what earlier
  jobs of the build created, gives each job a fresh `HOME`/`TMPDIR`/cache root,
  refuses a worktree whose effective git configuration leaves a documented safe
  baseline (no `core.fsmonitor`, `core.hooksPath`, `core.pager`, `protocol.*`,
  `url.*.insteadOf`, credential helpers, auth headers, ...) or whose repository
  holds hooks, and refuses unless the worktree passes a clean-clone check. It
  runs every `run:` step as one script under `/bin/bash --noprofile --norc -eo
  pipefail` after re-checking the step's effective environment and that its
  resolved working directory stays inside the worktree, enforces
  `timeout-minutes` (the job's, default 360, and each planned `run:` step's),
  and sends `SIGKILL` to the tracked step process groups when the job ends.
  After every job it refuses symlinked lockfiles and symlinked directories. It
  reports `review-build-ok` only when every job in the closure ran, every step
  exited 0, and no lockfile in the worktree (outside `node_modules/` and
  `.git/`) changed, appeared or disappeared.

  **The planner** (`scripts/reviewer/ci-job.mjs`) bounds the workflow (bytes,
  YAML nodes counting every alias use, depth) before trusting it, requires
  printable-ASCII keys, and requires a `pull_request` trigger that covers the
  host-named base branch; a workflow CI would not run for the review is refused.
  Every job must begin with `actions/checkout` and run on `ubuntu-latest` or
  `ubuntu-24.04`. It skips checkout (first step only), setup-bun and setup-node
  (exact versions only), socketdev (firewall-free), cache (path and key
  required) and upload-artifact (path required; unique, valid name) only at
  reviewed commit SHAs, with every input the real action needs and only input
  values whose skip is equivalent; it names them in the verdict and refuses
  every other action, ref or input. It refuses what it cannot reproduce: a
  `${{ }}` expression anywhere it would have to be evaluated (scripts, env
  values, working directories, runner labels, timeouts and every input of a
  skipped action — the only expressions accepted are `if:` conditions that are
  exactly `success()` or `always()`), `timeout-minutes` on a skipped `uses:`
  step, conditions other than success/always, `continue-on-error`, matrices and
  containers; and credential-shaped or config-redirecting workflow env
  (`GH_TOKEN`, `*_TOKEN`, `*_SECRET`, `*_KEY`, `GIT_*`, `NPM_CONFIG_*`, `SSH_*`,
  `NODE_OPTIONS`, `BASH_ENV`, `LD_*`, proxies, ...). Ambiguous, conflicting,
  malformed and out-of-matrix runtime requirements are refused by name; an
  out-of-matrix refusal names the missing image (e.g. `missing image: node >=25
  with bun 1.3.10`).

  The host supplies the assignment; its integrity and sandbox isolation depend
  on deployed host controls (#436), and per-job isolation within a build is
  tracked in #435. The build verdict is advisory.

  This repository now declares `engines.node: "22.x || 24.x"` (the Node majors
  its CI runs: the runner's 22, and the exact 24.21.0 its `test` job sets up
  for the github-review plugin suite), so with that pin its `test` job resolves
  to exactly one reviewer image, `reviewer-node24-bun1310`.

  A dedicated CI job builds every matrix image and runs the image-level checks
  (A2 integrity and build-path refusals, including a caller naming another job,
  a `--workspace` argument, impostor binaries on the caller's `PATH`, an
  enforced `timeout-minutes`, a worktree that fails the clean-clone check and a git
  `core.fsmonitor`; A3 hermetic defaults observed inside a build run the way
  OpenClaw runs the sandbox; A9 tokenless `gh`, a worktree git auth header and a
  workflow `GH_TOKEN`), then requires the A9 checks to fail on derived images
  carrying planted fake credentials.

### Changed

- **Breaking: `tps mail send` requires a usable sender signing key, refuses a recipient it has no route for, and prints only delivery metadata with `--json` (cli#429, cli#389).**

  **Breaking:** `tps mail send` requires a usable sender signing key; provision
  it before upgrading callers. `--unsigned` is unsupported. With no usable key
  the command exits non-zero, names the key path(s) it looked at (or the path
  of the unusable key) and the remedy, and writes nothing to any maildir,
  outbox, sandbox or wire, on every route; `--unsigned` is refused by name.
  To upgrade: give each agent id that sends mail an Ed25519 key at
  `~/.flair/keys/<id>.key` or `~/.tps/identity/<id>.key` in one of the accepted
  formats, make sure Flair holds its public key (recipients verify against it),
  and remove `--unsigned` from any caller.

  **Breaking: a recipient with no route is refused.** On an office host, a
  recipient with no GAL entry, no branch-office registration and no local
  maildir is refused with an error naming the fix, and a GAL entry whose branch
  has no `remote.json` is refused as `gal-without-remote`, whatever maildirs or
  branch-office inboxes exist. Either refusal exits non-zero, writes nothing and
  creates no directory. To upgrade: create the recipient agent, or add it to the
  GAL with a registered branch, before sending to it.

  **Breaking: `--json` prints delivery metadata only.** On every route the
  output is one line of JSON: `status`, `route`, `to`, `from`, the signed
  `messageId`, `replyToId` when the message is a reply, `signedAt`, and the
  route's own details (on the local route, the record `id` and `timestamp`).
  The body and the rest of the stored record are not printed. To upgrade: read
  only those fields from the output.

  (Refs #429, #389)

- **Renovate uses the shared TPS preset and excludes `@tpsdev-ai/**` dependencies from automated updates.**

  Maintainer note: `.github/renovate.json` extends the shared tpsdev-ai preset,
  and Renovate does not bump `@tpsdev-ai/**` dependencies, which are this
  repository's own release packages: the release workflow checks all six
  versions and attempts to stage all six, and approval and promotion are
  separate maintainer steps. Its configuration is reviewed separately from the Semgrep scan: the
  Semgrep step excludes `.github/renovate.json`, and Renovate configuration is
  checked in pull-request review.

  (Refs #423)

### Fixed

- **Failures persist pending nack notifications for startup retries; retries can duplicate a notification, and aged debt is subject to the configured abandonment policy (cli#389).**

  **The nack is owed on the record.** The write that sets `failed` also sets
  `nackPending`. The verb awaits the send, and a nack that reaches a route
  records `nackSentAt` and clears `nackPending` in one further write. When that
  write fails it is logged `obligation-write-failed`, naming the inbound; the
  record keeps `nackPending`, and a later start may send the nack again. The
  `nackedAt` stamp on the inbound is written before the send and is not
  evidence that the sender was told.

  **Startup retries owed nacks in the background.** Startup schedules bounded
  background nack retries before running retention; pending debt inside the
  hold window is retained regardless of retry completion order. Each retry is
  bounded by one overall timeout spanning the connection and the ACK wait; on
  expiry the transport is closed and `nack-retry-timeout` is logged by name.
  A retry may duplicate a nack. Delivery is not guaranteed: debt still owed
  after the configured hold may be abandoned.

  **The hold is bounded by age.** While a record owes its nack and is inside
  the hold window, the retention sweep keeps it and reports how many it held.
  The window is a configurable multiple of `obligationRetentionDays` (key
  `obligationNackHoldMultiple`, in the plugin or channel config; default 4,
  i.e. 28 days on the default 7-day window). A multiple below 1 is rejected
  with a named log (`obligation-nack-hold-multiple-invalid`) and the default is
  used. Past the bound, retention attempts to clear the debt and logs
  `nack-abandoned`; unsuccessful persistence can cause that attempt and log to
  repeat. A successful abandonment write clears `nackPending` and records
  `nackAbandonedAt`, preventing subsequent startup retries for that debt, and
  normal retention then applies to the record.

  (Refs #389)

- **A reply obligation is settled from its persisted delivery state by one verb, which also owns the nack mail; a closed obligation refuses a late final (cli#389).**

  **Delivery state is persisted.** The obligation record is written
  `delivering` before the delivery call and `posted` when the call returns, so
  the turn, the deadline timer and restart recovery all read the same state,
  and one verb settles the obligation from it. Persisted delivery state
  prevents uncertain delivery and evidence-maintenance errors from becoming
  failure verdicts; attributable quarantine remains a definitive failure.

  **Outcomes.** Receipt evidence gives `acked`. A committed record
  (`delivering` or `posted`) with no evidence at its deadline becomes the
  terminal state `unconfirmed`, logged by name, with no failed state and no
  nack, because non-delivery cannot be shown. A definitive non-delivery verdict
  fails the obligation and nacks the sender, even after commit: a refusal
  decided before the delivery call (no route, or a named route failure such as
  `gal-without-remote`), or the outbox drain quarantining this reply's own
  record, attributed by the reply id in the quarantined name. A quarantined
  record that cannot be attributed to this reply is not a verdict and resolves
  by the deadline rule.

  **Uncertain and post-commit errors.** A delivery call that throws after
  `delivering` was persisted may have thrown after the bytes left, so it is
  logged `delivery-uncertain:` and resolves by evidence or deadline, never
  `failed`. Every step after a delivery call returns (the `posted` transition,
  the receipt write, the log line) runs under its own guard that logs by name,
  such as `receipt-write-failed`, and records no failure. An error in a later
  step of a committed turn, such as the receipt scan, is logged
  `post-commit-error:<step>` and arms the normal deadline. When the obligation
  store cannot be written as an outcome is recorded, the plugin makes one
  attempt, logs `obligation-write-failed`, and the obligation resolves on a
  later start once the store can be written.

  **One nack path.** Every transition to `failed` goes through the verb, which
  sends the nack mail, so the same verdict gives the same sender-visible
  outcome wherever it is found and no caller mails on its own; how an owed nack
  is retried is in the nack-recovery entry. A terminal record refuses later
  transitions: a final that arrives after the obligation closed, as `acked`,
  `failed` or `unconfirmed`, is logged `late-final-refused` and not delivered,
  and a refused `unconfirmed` or `failed` transition stamps nothing and sends no
  nack. A `nackedAt` stamp on the inbound does not fail an obligation whose
  record says the delivery committed; recovery decides those by evidence and
  deadline.

  `posted` means the reply was handed to its route: sent over the wire to a
  remote branch, delivered into a local maildir, or queued in the outbox for
  the branch drain.

  (Refs #389)

- **A reply obligation is acked only on a receipt whose signed reply verifies, and receipts live in the replying agent's own store (cli#389, cli#429).**

  **Receipts.** Local, bridge and remote-branch reply receipts include the
  signed reply envelope and are created with mode 0600 in the replying agent's
  obligation store, at
  `<mailDir>/<agent>/.obligations/receipts/<obligation-id>.json`. A receipt
  also names the reply, the obligation, the inbound it answers, the route, the
  branch (for the wire and bridge routes) and the time it was written. The
  outbox route writes none: its record stays in this host's outbox, where the
  scan reads it. A bridge delivery's sandbox record carries the obligation ids
  too, so it is evidence in its own right.

  **What counts as a receipt.** The scan accepts three forms: the metadata
  receipt, the posted reply record carrying the obligation marker, and the
  bridge sandbox record. Each must name this obligation and the inbound it
  answers, and the reply it carries must be a signed envelope from the
  obligated agent, addressed to the inbound's sender, whose signatures verify
  against the key Flair holds for that agent and whose signed `replyToId` is the
  inbound's verified envelope id. For legacy obligations without an inbound
  envelope ID, the scan checks wrapper threading against the inbound record ID
  while still verifying the signed reply's sender and recipient. A record the
  recipient already promoted counts only when its plaintext body and recipient
  are the stored signed envelope's. Metadata and bridge receipts also match the
  recorded reply ID when one is known; all accepted receipt forms must pass
  signature, sender, recipient and applicable thread checks. An unsigned, badly
  signed, foreign-signed or misaddressed record never acks an obligation. When
  Flair cannot be reached to verify a candidate, that is logged
  (`receipt-verify-unavailable`) and the obligation is left to a later scan or
  its deadline.

  **How the store is read.** The receipts store is read ONLY by its direct
  `<obligation-id>.json` path and never listed; the route's posted-record
  directories (the maildir `new`/`cur`, the bridge sandbox, the outbox) are the
  only ones walked. An unreadable file in the receipts store is never read as a
  failed delivery.

  **Retention.** The agent's obligation retention sweep owns its receipts and
  keys each one on the obligation id: a live obligation keeps its receipt, a
  terminal obligation's receipt goes, and a receipt whose obligation is gone (an
  orphan) goes once it has aged past the retention window. An orphan with no
  readable timestamp, and a receipt that names no obligation id, stay in place.
  While any obligation record in the store is unreadable or malformed, the
  sweep deletes no orphan receipt in that pass (terminal-rule deletions,
  decided from records it did read, still apply) and reports the count.

  (Refs #389, #429)

- **One routing decision for outbound mail, shared by `tps mail send` and the openclaw-tps-mail plugin (cli#389).**

  Outbound mail uses a shared resolver that applies branch routing and office
  GAL precedence before local-maildir fallback. It lives in
  `packages/cli/src/utils/mail-routing.ts`, and `tps mail send` and both plugin
  paths (the dispatcher reply and the outbound adapter) import it rather than
  keep their own rules:

  - On a BRANCH, a recipient bound to this gateway is local and every other
    recipient is relayed through `~/.tps/outbox/new/`; directory existence never
    matters there.
  - On the OFFICE, the GAL is consulted first. A GAL-listed recipient whose
    branch is registered remotely (a GAL entry plus
    `~/.tps/branch-office/<branch>/remote.json`) is sent over the wire with
    `deliverToRemoteBranch`; one whose branch has no remote registration is the
    named failure `gal-without-remote`, whatever maildirs exist.
  - Only a recipient with no GAL entry reaches the rest, in this order:
    `remote.json` under the recipient's own name goes over the wire; a
    branch-office inbox (`~/.tps/branch-office/<to>/mail/inbox`) takes the
    `bridge` route, delivered through the CLI's own `deliverToSandbox`; a binding
    or an existing local maildir is written locally; anything else is the named
    failure `unknown`.

  A named failure is never a silent write. `tps mail send` exits non-zero with
  an error naming the fix and writes nothing (and creates no directory). The
  plugin's dispatcher reply records the failure in its log and in the
  obligation record as a definitive non-delivery; its outbound adapter throws a
  named error.

  A plugin reply sent over the wire keeps its identity: the dispatcher passes
  the reply `id` and `timestamp` to `deliverToRemoteBranch`, so the wire payload
  and the branch's ACK correlation use the id the plugin reports as the reply
  id. CLI sends carry a signed envelope message ID, optionally supplied with
  `--message-id`; the remote relay independently generates their transport
  record ID.

  (Refs #389)

- **The root `test/` directory now runs in CI, with a guard that compares discovered test files to the suites' JUnit reports (cli#411).**

  The root `test` script runs `./test` through the suite runner
  (`node scripts/test-suite.mjs root-test ./test`), so
  `test/security-properties.test.ts` runs in the `Unit & Integration Tests` job
  for PRs targeting `main`. The job's last step, `scripts/check-test-reports.mjs`,
  compares the test files discovered on disk with the file names in the suites'
  sealed JUnit reports, and fails on a missing required report and on a
  discovered file that no report names. bun's JUnit reporter omits a file with
  zero test cases, so a placeholder or platform-only file needs a registered case
  (`test.skip`, `test.todo`, `describe.if` or `test.skipIf`).

  (Refs #411)

- **A suite's JUnit report is checked against a checksum saved when the suite ends, to detect accidental changes after completion (cli#414).**

  Each launcher saves a checksum when its suite produces a JUnit report. The
  coverage guard fails if a required report or checksum is missing, or if the
  report does not match its saved checksum.

  (Refs #414)

- **`bun run test` runs every lane under a throwaway HOME with an allowlisted environment, and fails a lane on a detected change to the caller's `~/.tps` metadata (cli#430).**

  The monorepo and openclaw-tps-mail test launchers use isolated homes,
  restrict inherited environment variables, validate write destinations and
  fail a lane on a detected change to the caller's `~/.tps` metadata. The
  openclaw-github-review launcher gives its suite an isolated HOME, and its
  preload aborts a run outside that root.

  The control is HOME redirection plus an allowlisted environment, applied at
  launch time in one shared place (`scripts/test-home-guard.mjs`), because under
  bun `os.homedir()` keeps the HOME it read at first call. Every lane of
  `bun run test` runs through `scripts/test-suite.mjs`, which creates a fresh
  throwaway root and gives the child its whole environment: `HOME` and
  `TPS_TEST_ROOT` at the root, `TMPDIR`/`TMP`/`TEMP` and bun's transpiler cache
  inside it, and only these inherited variables — `PATH`, the locale
  (`LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `LC_COLLATE`, `LC_MESSAGES`),
  `TERM`, `NO_COLOR`, `FORCE_COLOR`, `CI` and `GITHUB_ACTIONS`, each only when
  its value holds no `/` (PATH excepted). Every other inherited variable is
  dropped, including ones nobody has named yet; the launcher prints the dropped
  names, never their values. A preload (`bun --preload`, and the `bunfig.toml`
  preloads at the repo root and in `packages/agent`, `packages/cli` and
  `packages/pi-tps-mail`) aborts the run before any test module loads unless
  `os.homedir()` is inside `TPS_TEST_ROOT`, the root is not and does not
  contain the account's home, and the root is one a launcher made (its marker
  matches `TPS_TEST_ROOT_TOKEN`). So a bare `bun test` — including one run with
  `TPS_TEST_ROOT=$HOME` — aborts by name. This is a launch-time check, not an
  OS boundary; the OS-enforced boundary is tracked in #434.

  Before creating or deleting anything, the monorepo launcher refuses a suite
  name that is not a plain file-name token (`[A-Za-z0-9._-]`, no `..`), a temp
  dir inside an operator home, a report directory that is or contains an
  operator home (`TPS_TEST_REPORT_DIR=$HOME`, or `/`), and a report directory
  that resolves inside `~/.tps`, `~/.flair`, `~/agents` or `~/.config` — the
  default `test-reports/` included. Report, log and seal files that are
  symlinks are also refused; the seal path is checked again before the seal is
  written. The monorepo and openclaw-tps-mail launchers also refuse a
  caller-supplied `--reporter-outfile` argument, owning the report destination.
  The Docker `attested` service runs its targeted files through the launcher,
  with its report on the container's writable tmpfs. The `openclaw-tps-mail`
  plugin's launcher (which runs only inside this monorepo) uses the same shared
  helper for its environment, destination checks and snapshot, and its preload
  applies the same root check.

  The monorepo and mail-plugin launchers compare the caller's `.tps` metadata
  before and after a suite as a diagnostic, and fail the lane on a detected
  change; OS isolation is tracked in #434.

  A CI step runs the suite with `HOME` pointed at an empty directory and asserts
  that directory still has no `.tps` afterwards.

  `tps auth` now builds its `~/.tps/auth` path each time it is used, instead of
  once when the module loads. Every home-relative path in `tps auth` goes
  through one helper, `homeDir()`: `HOME` when it is set and not empty,
  otherwise `os.homedir()`, read on every call. Nothing in the CLI changes HOME
  while it runs, so a CLI run uses the same paths as before; in the test suite,
  each test's `tps auth` calls use that test's home.

  (Refs #430)

- **A guard now fails CI if the test workflow's least privilege slips: a job that declares no `permissions` block of its own, a `write` scope with no comment naming the step that needs it, a checkout that keeps its token, or a top level that grants anything.**

  `packages/cli/test/workflow-permissions.test.ts` reads
  `.github/workflows/test.yml` and holds the shape cli#415 gave it: the top
  level grants nothing, every job declares its own block, every `write` sits
  beside a comment naming the step that uses it, and every `actions/checkout`
  sets `persist-credentials: false`. It also pins the set of workflows that run
  PR-controlled code, so a new one cannot appear without a decision recorded
  there. Every failure names the job or step responsible.

  (Refs #416)

### Security

- **Mail verification covers reply threads and message ids, unverified mail is shown as metadata only, and the mail runtimes sign their replies and answer only verified mail (cli#429).**

  **One id rule on receipt.** Every received envelope's `messageId` and
  `replyToId` must satisfy the id rule `tps mail send` applies (letters,
  digits, dot, underscore or hyphen, 1-128 characters); an envelope outside it
  is dead-lettered.

  **Unverified mail is metadata only.** Every unverified presentation (new/,
  dlq/, a cur/ record that does not re-verify) shows only the record's id,
  claimed sender and recipient, timestamp, location and lifecycle fields: the
  body, the thread fields (`replyToId`, `envelopeId`, the stored envelope), the
  headers (`X-TPS-InReplyTo`, `X-TPS-Obligation` and `X-TPS-Nack` among them)
  and every other field are withheld.

  **openclaw-tps-mail: replies and nacks are signed and threaded.** A
  dispatcher reply signs the inbound's verified envelope `messageId` as its
  `replyToId` inside the envelope, and so does the nack for an obligation that
  records the inbound's envelope id. Legacy obligations without an inbound
  envelope ID receive a signed, unthreaded nack. A reply or nack that
  cannot be signed is not sent: the failure is logged by name, and an owed nack
  stays pending for a later start. A reply receipt counts only when the signed
  reply it carries verifies (see the reply-receipt entry).

  **pi-tps-mail: the watcher answers only verified mail.** Each check runs
  `tps mail check <agent> --json` and acts only on the records it verified; an
  unsigned or forged inbound is dead-lettered by the CLI and never answered.

  **Which producers sign.** `tps mail send` (and so pi-tps-mail's watcher
  replies), the openclaw-tps-mail plugin's dispatcher replies and nacks, and the
  codex, gemini and claude-code runtimes' mail sign through the shared signing
  path. Other producer paths, including the `@tpsdev-ai/agent` runtime's
  `MailClient.sendMail`, do not sign yet; the CLI and plugin producers among
  them are tracked in tpsdev-ai/cli#433.

  (Refs #429)

- **Each job in the release workflow is granted only what its steps use, and only the publishing job can mint an OIDC token.**

  The top level of `.github/workflows/release.yml` grants nothing, and each job
  declares its own block, read from its steps: `contents: read` for the
  preflight, the binary build, the smoke test and the publishing job;
  `id-token: write` ONLY on the publishing job, whose
  `npm stage publish` step is the one call that trades an OIDC token for an npm
  credential; and `contents: write` ONLY on the job whose
  `softprops/action-gh-release` step creates the release. Artifact upload and
  download transfer within the run, so they need no scope of their own. A test
  reads the workflow and fails if the top level grants anything, if a job other
  than the publishing one holds `id-token`, if a job's grants widen, or if a job
  appears with no permissions block of its own.

  (Refs tpsdev-ai/flair#1890)

- **Jobs in `.github/workflows/test.yml` declare explicit permissions and disable checkout credential persistence; CodeQL alone receives SARIF-upload write permission.**

  (Refs tpsdev-ai/cli#412)

## [0.7.0] — 2026-09-24

**Release following `0.6.0` (2026-09-17).** 10 commits: 1 `feat`, 9 `fix`, no breaking changes. The version is a minor bump rather than a patch because the range carries a feature; nothing in it is breaking.

Because the changelog-fragment convention is in use for the whole of this range, the detailed entries below are those fragments, rolled into the notes at release time. The full list is the compare link at the foot of this section.

### Highlights

- **The three agent runtimes adopt the shared `promote()` LIFECYCLE.** Inbound mail is verified before it reaches a tool-holding model; replies are signed envelopes, and a record is acked only after the completion boundary — the reply is persisted and, for codex, the auto-commit that reads the `cur/` body has finished. Detail below.
- **Mail delivery fails closed.** Verification at the `new/` → `cur/` boundary is mandatory, `cur/` re-presentation is gated on proof-of-promotion and re-verification, and mailbox mutation is serialized by an inter-process lock that cannot be inherited in a broken state.
- **The mail archive no longer makes its importers unloadable outside bun**, so the OpenClaw gateway starts with the `openclaw-tps-mail` plugin loaded instead of silently missing it.
- **The `latest` promote after a release is a scripted, checked, all-six-or-none step** (`scripts/promote-latest.sh`), not a note in a run summary.

### Detail

- **The three agent runtimes adopt the promote() LIFECYCLE (Refs #380).** `gemini-runtime`, `codex-runtime` and `claude-code-runtime` each carried a private `checkNewMail()` that renamed `new/`→`cur/` with no verification and then handed the body to a spawned model with tool access. They now run the shared promote lifecycle (`utils/runtime-mail.ts`): inbound mail is promoted through `promote()` (mandatory signature verification — unsigned mail now dead-letters instead of executing), retryable `dlq/` entries are re-driven so an outage self-heals, `cur/` records are recovered and lease-swept, outbound replies are SIGNED envelopes (a `promote()`-reading recipient dead-letters an unsigned body terminal), and a record is acked only AFTER the completion boundary — the reply is persisted and, for codex, the auto-commit that reads the `cur/` body has finished — so cli#377's lease sweep can no longer re-dispatch a finished task every 30 minutes forever. Verification resolves through runtime-scoped Flair configuration instead of process-global env, and promotion, replies and acknowledgement all resolve the same `getInbox()` mailbox so a runtime cannot poll one root and ack into another.

- **Inbound mail is verified before it is promoted from `new/` to `cur/`, and verification is no longer optional.** `new/` is never mail; only `cur/` is presentable. The shipped verifier was dead because verification was an optional parameter on `checkMessages` and the only live caller passed two arguments; the parameter is now DELETED (not defaulted) and promotion goes through one exported `promote()` that parses the wrapper and envelope, verifies through an always-constructed Flair client, checks that the verified recipient is the mailbox owner and that the envelope has not already been consumed, and only then moves `new/` → `tmp/` → `cur/`.
  Rejections dead-letter to `dlq/` with a single `.reason` sidecar convention (the CLI wrote `.reject`, which the daily surfacing never saw): `invalid` (unsigned / not a v1 envelope / signature failure / wrapper-envelope from mismatch), `wrong-recipient`, `replay`, and the retryable `verify-unavailable` — a Flair outage quarantines inbound rather than dropping it, and a later check re-drives it so the outage self-heals. Terminal rejects are not retried.
  `mail list` no longer prints bodies from `new/` or `dlq/`: `new/` shows as `[pending verify]` and `dlq/` entries are labelled with their reason class. `mail read` likewise withholds an unverified body.
  The `openclaw-tps-mail` plugin now imports the same `promote()` and drops its own inline verification implementation (and its adapter). Consumers that still bypass the enforcement point — `mail watch --exec` handing bodies to hooks, and the ember/reed watcher — are tracked as follow-ups.

- **Mail promotion distinguishes an unresolvable principal from a forged signature: new terminal reject class `unresolvable-principal` (Refs #383).** Once envelope verification became mandatory (#377), resolving the sender's key — and every agent-kind entry in the delegation chain — from the LOCAL Flair became the promotion gate. A spoke holds only its own principal, so any hub-origin envelope (and any chain naming a principal the local Flair does not hold) resolved to `null` on the reachable-but-absent branch — the NON-retryable one — and was dead-lettered as `invalid`: classified as forgery, silently and permanently. `promote()` now recognises that presence failure by its stable reason string (`agent X not found in Flair`) and rejects as `unresolvable-principal` instead. It is TERMINAL and carries the SAME severity as `invalid` — enforced, not intended: it is not in `RETRYABLE_REJECT_CLASSES` and surfaces on the same `dlq` path, so an alert wired to the class field treats the two identically. `invalid` again means "malformed, or a principal we CAN resolve whose signature is bad" — a trustworthy forgery signal instead of noise on every legitimate cross-office message. The `.reason` sidecar names the specific entry, states that it is not registered in the local (spoke) Flair, that this is a spoke-topology condition, and plainly that the message was dead-lettered, not delivered. Hub→spoke mail stays broken-and-loud until hub principal keys are distributed to spokes (Option 1); the expected-but-not-yet-synced case that Option 1 introduces is a separate RETRYABLE class with its own name, never this one.

- **`cur/` re-presentation applies the same mailbox policy as first delivery (Refs #377).** The policy — signature, wrapper→envelope `from` binding, recipient binding, `messageId` shape — is extracted into ONE function that both `promote()` and `recoverPromoted()` call, so a check added to one path cannot be missing from the other. In particular the recipient bar (`wrong-recipient`) now applies on recovery: a record carrying another mailbox's genuine signed envelope is quarantined instead of presented.
- **`mail list`/`mail read` withhold the body of a `cur/` record with no `envelopeId`**, so a forged `cur/` record is no more presentable through the read commands than a forged `new/` one.

- **`cur/` re-presentation is gated on proof-of-promotion and re-verification (Refs #377).** Crash recovery and the `mail check` lease sweep no longer present a `cur/` record straight from disk: the record must carry the `envelopeId` and signed `envelope` that promotion stamps, and must re-verify through the same always-constructed client. A record that cannot prove provenance — or that was tampered with after promotion — is quarantined (`unverified`), not delivered. This closes a bypass where writing to the destination directory (`cur/`) skipped the enforcement point, while genuine crash recovery still recovers.
- **Three fail-open states were inverted.** A ledger-append failure now rolls the promotion back and quarantines it as retryable instead of silently succeeding with an unrecorded (replayable) id; a corrupt or absent ledger timestamp no longer forgets a consumed id; and stranded `tmp/*.promote` scratch is reaped rather than left invisible to every sweep.

- **The record↔envelope binding is now a single, compiler-enforced table (Refs #377).** `ENVELOPE_BINDINGS` is declared `satisfies Record<keyof Envelope, EnvelopeBinding>`, so adding a field to `Envelope` is a build failure until someone decides what it binds to (or writes a reasoned exclusion). It is a mapping, not same-name equality (`messageId` binds to `envelopeId`); `from`, `to`, `body` and `timestamp` are bound, and `v`/`subject`/`delegationChain`/`signature` are excluded with reasons. Recovery uses this one table. A malformed or absent envelope `timestamp` is now rejected instead of falling back to the wrapper's unsigned value.

- **Inbound mail promotion is hardened against replay, storage faults, and crash windows (Refs #377).** The `new/` → `cur/` enforcement point (`promote()`, used by `mail check` and the `openclaw-tps-mail` plugin) now:
  - records consumed envelope ids in an append-only, age-bounded ledger at the mailbox root, so the replay gate survives `cur/` acks and GC instead of reopening the moment a record ages out;
  - classifies a write/rename failure as the retryable `storage-unavailable` (a later check re-drives it) and preserves the ORIGINAL envelope bytes rather than dead-lettering a half-written payload as `invalid`;
  - validates `messageId` as a present, non-empty string before the replay lookup, so a malformed id is a `dlq` reason rather than an undefined key that silently never matches;
  - and the `openclaw-tps-mail` plugin sweeps `cur/` on startup for records promoted but never acked, re-dispatching them so a crash between promotion and ack cannot silently drop a message.
- **Fixed a polynomial-regular-expression sink on the identifier hyphen trim in `schema/sanitizer.ts`** (pre-existing; surfaced by dataflow re-attribution). Because runs are already collapsed to a single hyphen, the leading/trailing trim is a single-hyphen replace at each end — quantifier-free, and behaviour-preserving.

- **`mail list` and `mail read` require verified provenance for a `cur/` body, not a self-asserted `envelopeId` (Refs #377).** A record's `envelopeId` is a field the record asserts about itself, so using its presence as "presentable" let any mailbox writer present forged content with `envelopeId: "anything"` (CWE-345). Presentation now runs the SAME provenance + binding + signature policy as recovery — via one shared check — and withholds the body on any failure, including a Flair outage (fail-closed).

- **The `packages/agent` maildir→model path fails CLOSED, applies the full mailbox policy, and treats a Flair outage as RETRYABLE (Refs #380).** `MailClient.checkNewMail()` — the mailbox behind `AgentRuntime`'s tool-holding EventLoop, a fourth consumer alongside the three runtimes moved onto the shared promote() lifecycle — guarded verification behind `if (this.flairClient)`, so a runtime built without Flair config promoted `new/`→`cur/` unverified; and `verifyMailBody()` swallowed a verifier throw and returned `pass: true`, so a Flair outage promoted unverified mail. A record now reaches `cur/` ONLY after it passes the checks the shared `promote()` applies: signed-envelope verification, the wrapper→envelope `from` binding, recipient binding (`envelope.to` must be this mailbox's agent — a signature is not recipient-bound, and the outbox relay writes into any recipient's `new/`), and `messageId`/`timestamp` shape. Rejections dead-letter to `dlq/` under the shared class names (`invalid`, `unresolvable-principal`, `wrong-recipient`) with a `.reason` sidecar in the shared format, replacing the `.reject` sidecar no shared reader scans; there is no unverified path — no verifier leaves the record untouched in `new/`, and a throwing verifier leaves it in `new/` for a later check. An outage is now RETRYABLE rather than terminal: `FlairContextProvider.getAgent()` distinguishes "the principal does not exist" (a reachable 404 → null → `unresolvable-principal`, terminal) from "Flair could not be reached" (THROW → the record stays in `new/` and retries), matching the shared mail-verify client's null→ping→throw rule. Without that disambiguation every message would be dead-lettered as "principal not found" for the whole duration of a Flair outage.

- **Maildir mutation is serialized by a per-mailbox inter-process lock (Refs #377).** The lock spans the replay-check through the promotion commit/rollback — the consumed-id ledger's prune and append included — so two concurrent promotions cannot both pass the replay gate before either records the id, and an append cannot be lost to a concurrent prune. It is purpose-built (no lock primitive existed in this tree to reuse): atomic `mkdir` acquisition, bounded wait, an owner identified by pid AND process start time (so a reused pid cannot be mistaken for a live or dead owner), ownership-checked release, and it fails closed — failure to acquire prevents delivery rather than proceeding unlocked. Network verification runs before the lock and the source is revalidated under it.
- **The stranded-scratch reaper coordinates with that lock**: it holds the same lock and skips while a promoter is active, so it cannot eat an in-flight promotion's scratch. (An age guard alone is cleanup policy, not the safety property.)

- **Mailbox-lock acquisition is all-or-nothing (Refs #377).** `acquireMailLock` now builds a *populated* lock directory in a unique temp dir and `rename`s it onto `.mail-lock`; renaming a directory onto a non-empty one fails, so there is no window where the lock exists unowned. Previously `mkdir` and the owner stamp were separate, and a crash between them left a `.mail-lock` with no `owner.json` — which, because an unverifiable owner is never broken, permanently wedged the mailbox (every promote would time out as `busy`; inbound mail stopped with no signal). Stranded build-temps are reaped, and an ownerless `.mail-lock` from the previous code is treated as breakable so an upgrade cannot inherit the wedge.

- **Mailbox-lock ownership is classified by whether the owner is USABLE, not by corruption shape (Refs #377).** `ownerState` now returns `unowned` for any lock whose `owner.json` is missing, unreadable, unparseable, or carries no numeric pid, and the acquirer breaks an `unowned` or provably-dead lock while waiting only on a live/unverifiable one. Previously only the missing-file shape was recovered; a truncated, empty, or pid-less `owner.json` fell through to "unverifiable" and wedged the mailbox forever (every promote timing out as `busy`).
- **A birth token is only compared within the same source prefix (Refs #377).** A token stamped `proc:<ticks>` read where `/proc` is unavailable computes `ps:<lstart>`; comparing across prefixes marked a *live* owner "dead" and broke its lock — two owners, the race the lock exists to prevent. A cross-source token is now `unverifiable` (do not break), preserving "never break what you cannot disprove".
- **The owner's birth token is resolved once per acquisition attempt**, not on every 25 ms poll (the `ps` fallback forks), so a held lock does not spawn up to ~80 `ps` processes per acquire.

- **The mailbox-lock birth token is portable (Refs #377).** The owner's start-time token came only from `/proc/<pid>/stat`, which does not exist on macOS, so on that host the token was always null and lock ownership degraded to pid alone — exactly the pid-reuse confusion the token exists to prevent (a crashed holder whose pid was reused would read as "alive" and wedge the mailbox). The token now falls back to `ps -o lstart= -p <pid>` (present on macOS and Linux) and returns null only when both sources fail; an unverifiable owner is still never broken on age alone.
- Also: `recoverPromoted` presents the verified envelope's `timestamp` rather than the record's (the two presentation paths now present the same fields); and the scratch reaper's short lock timeout is documented as deliberate (it skips rather than waits, so it never delays mail).

- **The mail archive no longer makes its importers unloadable outside bun (Refs #394).** `packages/cli/src/utils/archive.ts` statically imported `bun:sqlite`, which put the `bun:` URL scheme in its module graph. Under NODE — the runtime the OpenClaw gateway runs the `openclaw-tps-mail` plugin under — the ESM loader rejects that scheme at module-graph load, so the plugin (which imports `utils/mail`, which imports `archive`) failed to load entirely: the gateway started with the plugin missing and reviewer mail was dead. All tests ran under `bun test`, where the scheme resolves, so nothing caught it. The sqlite binding is now resolved only when a bun runtime is actually present, so the module graph is portable. Under node the archive degrades to a no-op that prints ONE stderr line per process — the audit gap stays visible, never silent — and `queryArchive` returns an empty list; behaviour under bun is unchanged (same DB path, same schema, same events). No `node:sqlite` adapter is added in this change; parity of archive logging under the gateway is a separate follow-up.

- The mail archive's `bun:sqlite` binding is now resolved synchronously and lazily instead of through a top-level `await`, so the CLI utilities and the openclaw-tps-mail plugin load under `require()` as well as `import()` — the OpenClaw gateway loads plugins through a require-style path and refused the previous shape. A `require()` leg joins the plugin's node-load test and CI job.

- **The tps-mail dispatcher reply is never dropped and always posted (Refs #338).** Two fixes to the OpenClaw `tps-mail` channel plugin. First, a reply to a recipient with no local maildir or binding is now written to `~/.tps/outbox/new/` for the branch-service relay — the same route `outbound.sendText` already uses — instead of being logged and dropped; the outbox copy carries the reply reference (`replyToId` + `X-TPS-InReplyTo`) so the sender's tooling and any later scan can key on it. A LOCAL recipient's reply still lands in its maildir and never goes to the outbox. Second, the "the agent already sent something, so skip the dispatcher's reply" suppression is gone: the dispatcher's final is ALWAYS posted and is the only post that discharges the reply obligation — a progress note from the agent no longer suppresses the final. The inbound sender continues to be bound to the verified envelope `from` at the shared promotion boundary, so a wrapper/envelope identity mismatch is dead-lettered before any session or reply is built.

- **The `openclaw-tps-mail` plugin acks an inbound only after a committed final-reply receipt, and names a yielded run as a failure instead of a success (S2 of #392).** The plugin used to ack an inbound the moment the dispatcher settled, and set its delivered flag before the empty-text / signing / route checks — so a turn that produced no final reply (or failed to sign one) was still acked, and a turn that yielded to another run was acked as if it had answered. An inbound now carries a durable obligation record (`<mailDir>/<agent>/.obligations/<inboundId>.json`; one per inbound — a replayed inbound opens no second). The final reply carries an `X-TPS-Obligation` marker and the ack runs ONLY after a scan of the reply's destination (the sender's maildir `new/`+`cur/`, or `~/.tps/outbox/new`+`sent` for a remote peer) finds a record carrying that marker with the owning account, that agent as its `from`, the inbound it answers, and a wrapped envelope that CLAIMS the same agent — a claim about a string, never a verified signature; empty text, a missing key, a failed write or an unreadable (quarantined) receipt is a NAMED failure with a nack, never an ack. A run that yields with no posted final stays unacked and, after 60 minutes, fails as `yielded-without-resumption` with a nack naming the reason and the newest session-transcript mtime. Restart recovery derives the truth from the durable record (receipt → ack; nack → failed) and re-arms the deadline from the record, so a crash never strands or double-posts. Two accounts resolving to one mailDir are refused at startup. Plugin version 0.3.0.

- *Corrected (2026-09-25): this entry called the receipt "a file with that marker signed by the agent"; the scan verifies NO signature — it pins the obligation id the inbound minted, the inbound it answers, the record's account and `from`, and the sender the wrapped envelope CLAIMS.*

- **The `openclaw-tps-mail` plugin suite no longer leaks signed mail into the live outbox, and the dispatcher posts the turn's LAST real final (round 2 of #398).** Three review fixes. (1) ISOLATION: the plugin's outbox/archive writers resolve `~/.tps` and the CLI mail dirs from the process HOME, so a bare `bun test` wrote a signed mail into the LIVE outbox (reproduced by both reviewers). The suite now launches through `plugins/openclaw-tps-mail/scripts/run-tests.mjs`, which sets a throwaway `HOME`/`TPS_MAIL_DIR`/`TPS_TEST_KEYS_DIR` at launch time (the only thing that moves `os.homedir()`), and a bun `test` preload aborts the whole run by name before any module loads unless `os.homedir()` and `TPS_MAIL_DIR` both resolve inside that root. (2) LAST REAL FINAL: OpenClaw calls `deliver` once per non-reasoning final in a turn, so keeping the FIRST posted the wrong text; the plugin now remembers the LATEST final carrying real text and posts exactly once after the dispatch resolves. A `NO_REPLY` final is never posted as text — the runtime's own normaliser suppresses it before `deliver` reaches the plugin. (3) HONEST RECEIPT CLAIM: the receipt-scan docblock said the receipt is "signed by THIS agent"; it is not signature-checked, so the comment now states exactly which fields are checked (the `X-TPS-Obligation` marker, `accountId`, the record `from` and `replyToId` — the inbound it answers — and the sender the wrapped envelope CLAIMS) and why a signature check would not close the gap on its own.

- **A raw `NO_REPLY` final is an immediate empty-final failure, not a 60-minute yield.**

  On a host that delivers the silent token verbatim (`2026.5.7` with
  `surfaces["tps-mail"].silentReplyRewrite.direct = false`), `deliver` returned
  on a non-postable final without recording it, so a turn whose only final was
  `NO_REPLY` armed the 60-minute deadline and failed as
  `yielded-without-resumption` instead of `empty-final-text`. `deliver` now
  records the silent final, and the `empty-final-text` branch also requires that
  no real final was seen, so a turn that POSTED a real final whose receipt is
  absent still follows the posted-without-receipt path.

  (Refs #398)

- **An unrelated quarantined record no longer fails every later non-posting turn.**

  The receipt scan reports `malformed` for ANY `.malformed-*` in the scanned
  dirs, and its marker cannot be read, so it cannot be tied to this obligation.
  The plugin took that branch BEFORE the post-failure / silent-final / yield
  branches and without checking whether THIS turn had posted, so one quarantined
  record made every later turn that posted nothing fail at once as
  `receipt-malformed` — yields never armed and the real reason was overwritten.
  The branch now fires only when this turn posted.

  (Refs #398)

- **The `openclaw-tps-mail` plugin sweeps TERMINAL obligation records at startup, so they no longer accumulate forever (Refs #401).** Every inbound opens a durable record at `<mailDir>/<agent>/.obligations/<inboundId>.json` (the ack key, ~600 B each) and nothing ever deleted one. Startup recovery — the one place that already walks the store — now deletes a record only when it is in a TERMINAL state (`acked`, `failed`) AND its **last transition** is older than the retention window. `pending`, `posted` and `yielded` records are never deleted, at any age, because restart recovery reads them to re-arm deadlines. The age comes from the record's OWN recorded `lastTransitionAt` (falling back to `inboundTimestamp` for records written before that field existed), never the file mtime. The window is configurable via the plugin config key `obligationRetentionDays` (also accepted on the channel config block), default **7** days; a value `<= 0` disables the sweep. Deletion is safe and best-effort: an unreadable or malformed record — or one whose timestamp cannot be parsed — is left in place and logged once, and a deletion failure never blocks startup. A replayed inbound id whose record was swept opens a FRESH obligation: that is accepted (relay retries arrive within minutes or hours, never the window later) and is documented in `obligations.ts` and pinned by a test.

- **The tps-mail outbox reply is written atomically (Refs #338).** `writeOutboxFile` staged the record straight to its final name in `~/.tps/outbox/new`. The branch relay watches that directory and drains it on every directory event, including the create event that precedes the bytes; a drain that reads a partial file fails `JSON.parse` and quarantines it to `sent/.malformed-*` with no retry — losing the reply permanently, on exactly the remote-recipient path the outbox exists for. The record is now staged to a dot-prefixed temp in the same directory and renamed into place, the same pattern the CLI's own outbox writer uses (the drain filters dot-prefixed names), so a concurrent reader never sees a half-written record.

- **The `openclaw-tps-mail` plugin warns at startup when the HOST OpenClaw is old enough to rewrite an exact `NO_REPLY` into a postable final (Refs #402).** On an OpenClaw host older than `2026.5.22` a tps-mail session key (`agent:<id>:tps-mail:direct:<sender>`) classifies as the "direct" conversation type, whose silent-reply defaults are policy "disallow" **with rewrite ON** — so an exact `NO_REPLY` final is rewritten into a canned phrase (e.g. "Nothing to add right now.") *before* `deliver` runs. The plugin's token guard matches the raw tokens only, so it cannot tell that rewritten phrase from a real reply: it gets posted and discharges the reply obligation. The plugin now reads the **host** OpenClaw version at registration and logs ONE WARN when it is below the floor and the effective config does not set `surfaces["tps-mail"].silentReplyRewrite.direct = false` — naming the hazard, the host version and that exact key. It WARNs rather than refusing (a refusal would take mail down on a gateway that otherwise works), and also WARNs when the version cannot be determined instead of staying silent.

  The version is read from the **running gateway's own install** — walking up from the entry script (`process.argv[1]`) to the nearest `package.json` named `openclaw` — never from `require("openclaw/package.json")` resolved against the plugin's own directory, which returns the plugin's **dev dependency** (openclaw `2026.5.22`) instead of the host and can therefore never fire. An explicit `false` is read with an identity test, so it counts as *set* rather than being mistaken for an unset value.

  The version parse **fails toward the warning**. Only a full version string parses; a malformed one (`2026.5.22broken`, `2026.5.22.1`) is *unparseable* and produces the "could not check" WARN rather than being compared as if it were the floor (a prefix match would compare EQUAL to the floor and silently suppress the warning). And a version that carries a suffix whose numeric core EQUALS the floor (`2026.5.22-1`, `2026.5.22-beta.1`) is not provably at or above the floor — it could be a pre-release of the fix — so it also WARNs; a core strictly above the floor with any suffix (`2026.5.23-1`) does not.

  `peerDependencies.openclaw` is deliberately **not** raised to `>=2026.5.22`: an unmet peer range makes npm (v7+, incl. 10.x) fail the install with `ERESOLVE` when the plugin is installed as a resolved package, and the hosts we run (openclaw `2026.5.7` and `2026.5.3-1`) are below that floor — raising it would break installing the plugin on exactly the hosts the warning protects. The range stays `>=2026.3.7`; the README documents the floor and the host-side key, and the runtime WARN carries it.

- **The openclaw-tps-mail plugin builds and tests in CI: its tsc is green and the two plugin CI steps no longer swallow failures.**

  The plugin's `tsc` was red — `src/index.ts` imported six channel types from
  `openclaw/plugin-sdk/channels`, a subpath the pinned SDK does not export — and
  the CI steps papered over it (`npm run build || true`) or skipped the build
  entirely, so a stale-dist run failed the node-load tests. Types now come from
  the public SDK subpaths (`channel-contract`, `core`; the two adapters derive
  from `ChannelPlugin`), the emitted `dist/src/index.js` is byte-identical
  (type-only), and both plugin CI steps run `npm ci --ignore-scripts` plus a
  mandatory `npm run build`.

  (Refs #393)

- **`signOutboundBody` no longer aliases the caller's delegation chain (Refs #380).** `opts.priorChain` was used directly as the array to extend, so the outgoing hop was `push()`ed onto the CALLER's array. No current caller was affected, but it mutated caller state; the chain is now shallow-copied before the hop is appended.

- **The `latest` promote is now a recorded, checked, all-six-or-none step (`scripts/promote-latest.sh`), not a note in a run summary (cli#366).** After a tag push, `release.yml` stage-publishes six packages under the `staged` dist-tag and a maintainer approves them in npm — but approval cannot move `latest` (`--tag` is immutable on a staged package and `npm stage approve` has no tag flag), so `npm install` keeps serving the previous version until someone runs `npm dist-tag add`, by hand, per package. A forgotten promote is indistinguishable from a failed release.
  The new script performs that step. It verifies BEFORE acting that all six packages exist at the target version, and refuses — naming each missing package — if any does not, because `packages/cli` pins the four platform packages at exact versions and a partial promote would publish a `latest` CLI whose pinned dependencies do not resolve. It shows the current `latest` for each package and what it will do, then requires an explicit `yes` (`--dry-run` stops before any change; `--yes` skips the prompt for a scripted run). It promotes all six or none: each move is verified by RE-READING the registry rather than trusting `npm dist-tag add`'s exit code, and if a move fails, does not land, or the process is INTERRUPTED (SIGINT/SIGTERM/SIGHUP) — during the move loop or during the rollback itself — the packages already moved are rolled back. The attempt is flagged before each `dist-tag add`, so a signal landing immediately after a tag change still rolls that package back, and further termination signals are IGNORED while the rollback runs, so a second signal cannot abandon the remaining restorations. A final table reports each package's previous and new `latest` and whether the move was verified.
  A target that is not a forward release — older than the current `latest` (a downgrade) or a pre-release — is allowed (a downgrade is a legitimate rollback) but never silently: it is called out loudly and needs a distinct `--allow-downgrade` acknowledgement that `--yes` does not imply. Build metadata (for example `1.2.3+build-abc`) is not a pre-release and does not require the acknowledgement. Every npm call is pinned with `--registry` so the publish path cannot be redirected by machine-local npm config.
  The invariant delivered is *no partial promote*, not *the promoted set is trustworthy*: the script checks that each package exists at the version, never that the four platform packages came from the same commit as `cli`. A canary-gated, sha-bound promote is the remaining half of cli#366.
  `scripts/test-promote-latest.sh` pins the refusals, the registry re-read, the interrupt rollback, the direction guard, and the registry pin against a fake registry — no network, no real dist-tag is moved — and includes mutation checks that break the existence check, the post-move re-read, the TERM trap, and the pre-add attempt flag and confirm a fixture catches each. It runs in CI on both `ubuntu-latest` and `macos-14` (the script must run under bash 3.2, the bash on the machine that drives releases).

**Full commit range:** https://github.com/tpsdev-ai/cli/compare/v0.6.0...v0.7.0

## [0.6.0] — 2026-09-17

**First release since `0.5.4` (2026-02-27).** 332 commits: 101 `feat`, 123 `fix`, no breaking changes. The version is a minor bump rather than a patch because the range carries features; nothing in it is breaking.

Because the changelog-fragment convention was adopted partway through this range, the detailed entries below cover the most recent work only. The full list is the compare link at the foot of this section.

### Highlights across the range

- **Sandbox: the default agent-launch path now runs under `nono`, fail-closed.** The `cli#341` series (S1a, S1b, S2, S4) removes the environment bypass, replaces `--read /` with an explicit toolchain set, makes a missing or invalid profile a hard failure, and pins the Docker image's nono to an immutable commit with a post-build hash assertion. Detail below.

  **Scope, stated precisely.** `0.5.4` shipped **no sandbox at all**, so this is a strict improvement — but it is not yet universal. `tps agent start --runtime claude-code|codex|gemini` branches before the attested launch and spawns the runtime directly, so those three paths are **not** confined by nono. Do not read the entries below as covering them. Routing those runtimes through the attested launch is tracked in cli#363, which also covers making `--sandbox-required` refuse on that branch rather than silently passing.
- **Portable compiled binaries fixed (`cli#327`, #336).** The packaged binaries failed to resolve a native addon. On Linux this surfaced as an immediate `Cannot find addon` error; **on macOS it hung indefinitely**, so `tps mail send` from an installed CLI silently lost the message and `tps --version` printed nothing. Anyone on `0.5.4` should upgrade for this alone.
- **Security fixes:** a `socket.yml` `deferTo` block that was a silent no-op (#337); `js-yaml` to `4.3.2` (GHSA-2883-xcg3-v3hh, #349); a `brace-expansion` advisory whose previous override pinned a still-vulnerable version (#331); three high DoS-class advisories in transitive dependencies (#325).
- **Mail:** the dispatcher delivers one signed, idempotent reply per inbound message (#339); inbox back-pressure now reaches someone who can act on it (#329); Pulse calls `sendMessage` in-process with a timeout instead of wedging on failure (#333).

### Detail

- **Launch-path sandbox control (cli#341 S1a, Refs #341).** The environment bypass is gone: `TPS_FORCE_NO_NONO` is no longer read anywhere, and `findNono()` has no escape hatch. The only human override, `--no-sandbox`, is honoured **only from an interactive TTY** (stdin AND stdout); anywhere else it is refused with a message naming the flag and the reason.
- Every generated unit that launches an agent now asserts `--sandbox-required` — mail-watch `--daemon install` and office-supervision's office unit — and marks itself `TPS_SUPERVISED=1`. In a non-TTY context the launcher **refuses to launch** when the flag is absent (a hand-edited plist or a wrapper that dropped it), instead of silently running unsandboxed.
- **`--sandboxed` requires the LAUNCHER'S RELEASE, verified from outside the sandbox (cli#350 r4e; replaces the r3 capability probe).** The r3 probe — a write under the policy-denied `~/.tps/secrets` — and its fixtures are deleted: nothing a process can observe about *itself* is proof (nono 0.74.0 exposes no in-sandbox validation, strips inherited fds, and writes its per-session `sandbox_runtime` audit record only when tool-sandbox is active, which changes the launch shape and breaks the pid binding). The launcher now owns the invariant end to end:
  - it creates a private 0700 dir at a root covered by **no grant the launch passes** — `<home>/.tps/launch/<id>-<nonce>/`, never `os.tmpdir()`/`TMPDIR` (the launch grants the tmpdir read+write, so a naive `mkdtemp` lands inside a grant, the child legitimately reads the OUTSIDE canary, and a correct launch would be refused), with the socket in `<priv>/sock/` (the only granted subdir) and a launcher-pinned `XDG_STATE_HOME` at `<priv>/state/` (nono refuses a state root that overlaps a grant);
  - it plants two canaries with fresh nonces — OUTSIDE at `<priv>/canary-outside` (outside every grant) and INSIDE at `<priv>/sock/canary-inside` (granted) — verifies **pre-spawn** that its own uid can read OUTSIDE and that OUTSIDE overlaps no entry of the computed allow/read/read-file list (refusing otherwise), and removes `<priv>` on **every** exit path, refusal and kill included;
  - it spawns nono by an **absolute** path (`NONO_BIN`, else the pinned locations — never PATH) checked against the S4 `.nono-version` record where one is present, keeps that pid live, and reads `nono ps --all --json` with the same absolute binary and its own pinned `XDG_STATE_HOME`;
  - it releases the child (`CONFINED <session_id> <child_pid>`, over the launcher-owned socket) **only** when the child reports `PID <its pid>`, `CANARY OUTSIDE DENIED`, `CANARY INSIDE READ:<the launcher's inside nonce>`, and nono reports a **running** session whose `supervisor_pid` is the pid the launcher spawned, whose `child_pid` is the pid the child reported, and whose `profile` is the one it passed — then re-checks both live. Anything else: nothing is written, the session and child are stopped, the private dir is removed, and the launch exits non-zero naming nono.
  - Under `--sandboxed` the child holds that release or refuses (exit 78; 0 under `TPS_SUPERVISED=1`, so KeepAlive cannot storm). The child cannot attest its own confinement: its check is a guard against an **unwrapped launch**, not a boundary against the process that spawns it — that process already owns it.
- **`tps-base` pins `linux.sandbox_policy: "landlock"`** (belt, not the control): 0.74.0 accepts it in a profile and it errors at startup rather than falling back to seccomp-only networking where the kernel cannot enforce Landlock network restrictions.
- **The launch must grant `/tmp`.** Bun's own temp directory is `/tmp` regardless of `TMPDIR` (measured), and an unreadable temp dir is fatal to it, so the granted tmpdir stays `/tmp` and a cwd of `$HOME` (which `--allow-cwd` would grant wholesale) refuses the launch by design — fail-closed, and named in the refusal.
Generated agent units now use `KeepAlive {SuccessfulExit:false}` **only together with** "the launcher logs the refusal and exits 0": `{SuccessfulExit:false}` + `exit 78` measured 13 relaunches in 12 s, so a refusal exits 0 under supervision while a genuine crash (non-zero/signal) still relaunches. The coupling is stated in a code comment where each unit is generated. office-supervision's tunnel unit is left untouched (bare `KeepAlive:true`).
- `--nonono` is renamed to `--quiet-nono-check` (it only skips the loud availability check; it is not a sandbox bypass). The old spelling remains as a hidden alias for one release and prints a deprecation line (cli#341).
- **The launcher/child handshake is keyed on the LOCATOR, never the TTY (cli#350 r4f, Refs #341 #350).** Contract: **the launcher requires the release; the child attests whenever a launcher started it; a TTY changes nothing.** `bin/tps.ts` runs `attestConfinement()` whenever `--sandboxed` is present **and `TPS_LAUNCH_SOCK` is set** (the launcher always sets it) — the `!isInteractiveTty()` condition is gone — so a TTY child no longer skips the handshake the launcher always waits for: pre-r4f a human typing `tps agent start` in a terminal got `no released child within 4000ms` and no agent (fail-closed, but the interactive path was dead, and CI was green only because every fixture was non-TTY). `nono.ts` rule 1b drops its `&& !tty`: `--sandboxed` without a release is refused everywhere — it is an internal flag meaning "my launcher released me", never "trust me"; the interactive opt-out stays `--no-sandbox` (with its warning). Fixtures: a TTY-parent launch (`script(1)`) through the launcher is RELEASED (fake nono in the unit lane, real pinned nono in the Docker lane); a TTY `--sandboxed` with no locator is refused, naming the launcher; the non-TTY fixtures are unchanged; fails-first — the pre-r4f child shape (attest only when non-TTY) times out with `no released child within …`.
- **Review round — hardening from the PR threads (cli#350 r4g, Refs #341 #350).** (1) On a refusal the launcher signals **only the nono supervisor P**, never the child-reported pid — a peer can report any pid, so signalling it would aim SIGTERM at an unrelated process (CWE-20); killing P stops the session and its child. (2) The unix socket path is **bounded to `sun_path`** (`launchDirLabel`): the full `<id>-<nonce8>` when it fits, else a deterministic `<id[0:16]>-<hash8>`, else a loud refusal naming the byte length. (3) The launch grants **`/tmp` in addition to `TMPDIR`** (bun's temp dir is `/tmp` regardless of `TMPDIR`; launchd sets `TMPDIR` to `/var/folders/…`). (4) The availability check uses the **pinned** resolution, so a PATH-only nono gets the actionable "Install nono >= 0.70 or set NONO_BIN" message instead of a bare pinned-path refusal. (5) `pinRecordCandidates` decodes the module URL (`fileURLToPath`), so a checkout under a path with a space or `#` no longer silently skips the pin check (fail-open). (6) `test.yml` validates `.nono-version`'s `commit=` as exactly 40 hex and passes it through `env:` — never interpolated into a `run:` body (CWE-78). (7) Fixture scripts carry paths through the ENVIRONMENT, not interpolated into code. (8) Explicit test timeouts above the release windows (the 5 s `bun:test` default could stop the real-nono tests mid-flight). (9) `tps-base`'s description now states the real identity boundary: the launch grants exactly the launching agent's own key files, never the identity directory.

- **One nono profile directory, JSON `extends` (v2 shape), validate-or-FAIL (cli#341 S1b, Refs #341).** `packages/cli/nono-profiles/` is now the single source: the surviving code-asked name (`tps-agent-run`) plus the root tree's extras (`tps-office`, `tps-agent`) carried in; the duplicate root `nono-profiles/` tree is gone. Profiles are JSON targeting the nono 0.70+ schema (the pre-2.0 TOML dialect is not valid there) and use `extends`. Each carries the Linux note (Landlock cannot express deny-within-allow, so a deny nested in an allow makes nono refuse to start — matters for the exe.dev profiles) and the never-grant-the-state-root note.
- A profile that is **missing or fails `nono profile validate --strict` is a FAILURE**, never warn-and-continue: `resolveProfilePath()` / `checkProfileLoadable()` gate every launch (EX_CONFIG), and `installNonoProfiles()` validates what it installs when nono supports JSON profiles. The fake nono's profile set and profile resolution are JSON too (`test/fakes/nono/`), and `scripts/check-nono-profiles.sh` asserts the whole set validates plus live kernel enforcement (a granted write succeeds; a write to `~/.tps/secrets` is blocked).
- **Install migration (cli#341).** `installNonoProfiles` now overwrites an installed TPS profile whenever the bundled content differs (content-hash versioned) and retires a stale TPS-named `*.toml`; the copy and the validation are two passes over the whole set, so a filesystem-arbitrary readdir order (a child validated before its parent was copied) cannot abort mid-install and leave a partial shadowing state — nono resolves `extends` **by name across locations** with `~/.config` first, so a stale installed profile otherwise **shadows the bundled deny list for every child everywhere**. User-authored non-TPS profiles are never touched (everything is keyed on the set of names we ship).
- **The gate is a durable control:** `scripts/check-nono-profiles.sh` is wired into `.github/workflows/test.yml` as `nono-profile-gate` on **ubuntu-latest and macos-14**, against nono pinned to the S4 commit (from `.nono-version` when present, else the literal; built once and cached). The probe tree is built under the real `$HOME` so the positive control passes on macOS (nono's state root cannot overlap a granted `/private` read); a genuine enforcement break still fails loudly (cli#341).
- **`--read /` is replaced** by the explicit toolchain set Kern validated — `/opt/homebrew /usr /bin /sbin /Library` on macOS, `/usr /bin /sbin /lib /lib64 /etc /opt` on Linux (`harnessReadPaths()`), which `agent start` now grants instead of the filesystem root. A root grant is refused outright by nono 0.70+ (exit 1) (cli#341).
- **Read-set/deny agreement, narrowed to the agent's OWN key (cli#341 S1b r2+r4).** `tps-base` does not deny `~/.tps/identity` (nono resolves deny over grant, which would break the agent's own signing key), and the launch no longer grants the whole `~/.tps/identity` directory — it grants exactly the launching agent's own key via `--read-file ~/.tps/identity/<id>.key` (+ its `.pub`), derived from `--id`. On a shared-UID host one agent can no longer read a sibling's key. `/etc/shadow`, `/etc/sudoers` and `/etc/ssh` stay denied; on Linux `/etc` is no longer granted as a directory (Landlock cannot express deny-within-allow, so the two would conflict and nono would refuse to start) — the few files resolution/TLS need are granted by name. The gate asserts with real nono: own key ALLOWED, sibling key DENIED, `~/.tps/secrets`/`/etc/shadow`/`/etc/sudoers`/`/etc/ssh` DENIED.
- **One validated launch path.** `hire`, `roster` and `review` no longer call `buildNonoArgs` + `spawnSync(nono)` directly — they go through `runCommandUnderNono`, so every launch validates the profile (EX_CONFIG on missing/invalid). `buildNonoArgs` passes the **resolved profile path** to nono, so what was validated is what runs (a unit test asserts no source file invokes nono outside the helper).
- **`/dev/null` is writable inside the sandbox (cli#341 r5).** `tps-base` grants `filesystem.allow_file: ["/dev/null", "/dev/dtracehelper"]` (inherited by every profile; `/dev/dtracehelper` is the macOS Seatbelt probe `fetch()` trips), so `cmd >/dev/null` and `git` (which opens `/dev/null` for reading and writing) work under the launch — without it, `git ls-remote` exits 128 inside the sandbox. The gate asserts `/dev/null` readwrite ALLOWED for all 13 shipped profiles and runs a workload smoke (shell redirect, `git ls-remote` over https, `fetch`) under the exact launch args built by the same helper the launch uses.
- **The launch grant's input comes from outside the grantee's write set (cli#341 r5).** `~/.tps/agents/<id>/` is granted read+write to the agent, so the agent can rewrite its own `agent.yaml`; the grant is now derived from the validated `--id` argv (`^[a-zA-Z0-9._-]{1,64}$`, no traversal), the launch refuses when `config.agentId !== --id` (naming both), and the runtime's key resolution uses that validated id. `/etc/ssl` (and `/private/etc/ssl` on macOS) is granted read so the TLS CA bundle is reachable on Linux, where `/etc` as a whole cannot be granted.
- **A red gate says WHY (cli#341 r5b).** `scripts/check-nono-profiles.sh` quotes the failing command's own error line (git's `fatal: …`) in its failure message instead of only the exit code, adds `getent hosts github.com` to the workload set, and prints a resolution probe (resolv.conf path/content, `getent`, `GIT_CURL_VERBOSE` head) on both lanes so an ubuntu-latest-only failure is diagnosable from the lane log alone. The probe also records whether the pinned nono resolves a symlinked `--read-file` itself (it does: a symlink-only grant reaches the target; the ungranted control is denied).
- **git's SYSTEM config is readable inside the sandbox (cli#341 r5b).** Where `/etc/gitconfig` exists, git reads it as part of "reading the configuration files", and an *unreadable* one is fatal — not ignorable: on the ubuntu-latest lane `git ls-remote` died with `warning: unable to access '/etc/gitconfig': Permission denied` + `fatal: unknown error occurred while reading the configuration files` (exit 128) while the same command passed on macOS (no `/etc/gitconfig`; homebrew git's config is under the granted `/opt/homebrew`). The launch now grants `/etc/gitconfig` read by name (filtered to files that exist), alongside `/etc/hosts`, `/etc/resolv.conf` and `/etc/nsswitch.conf`. Probe evidence: inside the sandbox on ubuntu the resolver was fine (resolv.conf's `/run/systemd/resolve/stub-resolv.conf` target readable, `getent hosts github.com` resolving) — the missing grant was this file; the gate's fails-first reproduces the exact warning+fatal with an ungranted synthetic system config on hosts that have no `/etc/gitconfig`.
- **git's USER config no longer has to be readable (cli#341 r5c).** Under a real launch git also reads `$HOME/.gitconfig` from the agent's HOME — which the sandbox deliberately does not grant (it holds `~/.tps/secrets`, `~/.tps/identity`, keys) — and an existing-but-unreadable user config is **fatal** to git ("fatal: unable to access '~/.gitconfig': Operation not permitted" / the same with `Permission denied`, exit 128). The launch now exports `GIT_CONFIG_GLOBAL=/dev/null` for the sandboxed child (`sandboxChildEnv()`, so every git the agent shells out to inherits it), which is readable everywhere because `tps-base` grants `/dev/null`. `GIT_CONFIG_SYSTEM` is deliberately *not* overridden — where `/etc/gitconfig` exists it is granted read by name instead (r5b), preserving the system config's semantics. The gate's workload smoke now runs with a HOME that **has** a `.gitconfig` (rounds r5b's fixture HOME had none, which is why this was missed) and asserts fails-first: drop `GIT_CONFIG_GLOBAL` → git exits 128 on `~/.gitconfig`; with it → green.

- **Docker supervisor runs every agent inside nono, under `tps-office` (cli#341 S2, Refs #341 #351).** Both `nono run` invocations in `docker/tps-office-supervisor.sh` — the Landlock probe and the per-agent launch — now run the `tps-office` profile (as a *resolved absolute path* since r3; see below). The UID-only fallback (which started an agent with **no** nono isolation when the probe failed) is **deleted**: if nono cannot engage (it is missing, or Landlock cannot enforce the profile) the supervisor fails closed with a message naming nono, rather than launching an agent unsandboxed. Depends on the `tps-office` JSON profile landed in cli#351 (S1b). The refusal is now all-or-nothing: the supervisor stops any agent launched earlier in the run (`shutdown_children TERM`) before exiting, so a refusal leaves no orphaned agent. The harness's behavioural half is wired into the Docker Integration lane (`docker compose run --rm test bash scripts/test-tps-office-supervisor.sh`), with a Part A assertion that the workflow still invokes it.
- **Supervisor launch-path parity with the CLI path (cli#352 r, Refs #341 #351 #352).** The supervisor's launch (`nono run … -- tps-agent start`) bypassed what cli#351 put on the CLI path, so it now carries the same invariants:
  - **The launch id comes from the supervisor's own roster entry.** `team.json`'s `id` is validated (`^[a-zA-Z0-9._-]{1,64}$`, no traversal) and the identity grant (`<roster state root>/identity/<id>.key|.pub`) is derived from *it*, never from a field inside the agent's writable `agent.yaml` — otherwise an agent that can rewrite its own config could name another agent's key. A config whose `agentId` disagrees is refused, naming both, by a `tps-agent check --id … --config …` pre-flight that runs *before* anything is launched (so a refusal cannot leave a partial team), and the launch itself passes `--id` so the same rule is enforced a second time.
  - **The child environment is generated from one list.** The launch exports `TPS_NONO_ACTIVE=1` and `GIT_CONFIG_GLOBAL=/dev/null` — the same pairs `packages/cli/src/utils/nono.ts`'s `sandboxChildEnv()` sets — and the by-name system read files (`/etc/hosts`, `/etc/resolv.conf`, `/etc/nsswitch.conf`, `/etc/gitconfig`) mirror `systemReadFiles()`. `test/security-properties.test.ts` asserts both lists EQUAL the helpers, so the two launch points cannot drift.
  - **Real-nono coverage.** `scripts/test-tps-office-supervisor.sh` grew Part C, which runs under the S4-pinned nono (the Docker lane builds it for the container's distro): the Landlock probe passes, an agent launches under `tps-office`, `nono ps` shows the session bound to the supervisor's child, `git ls-remote https://github.com/tpsdev-ai/cli` exits 0 *inside* that agent, and the child env carries the exports above. Fails-first: with `tps-base`'s `/dev/null` allow reverted in a private profile copy the probe fails and the supervisor refuses everything — the behaviour S1's profile could not have caught without #351.
- **The office image now ships the profiles, and the supervisor hands nono an absolute path (cli#352 r3, Refs #341 #351 #352).** Sherlock's blocker: `docker/Dockerfile` copied only the nono binary, the supervisor and `.nono-version` — never the profiles (`installNonoProfiles()` runs only from `tps identity init`, which the container never executes) — while `docker/tps-office-supervisor.sh` passed the **bare name** `tps-office` at both launch sites. nono resolves a bare name against its own config dir, so in the shipped image the Landlock probe failed for the wrong reason (`nono: Profile not found`, exit 1) and fail-closed refused **every** office agent — the office was dead on arrival. Part C's own copy of the profiles in `XDG_CONFIG_HOME` hid exactly this (harness green, ship red).
  - `docker/Dockerfile` now `COPY`s `packages/cli/nono-profiles/` to `/usr/local/share/tps/nono-profiles` (world-readable — the agent uid reads the profile nono was handed).
  - The supervisor resolves `tps-office.json` to an **absolute path** — the operator's `~/.config/nono/profiles/`, then the bundled dir, the same two candidates in the same order as `resolveProfilePath()` in `packages/cli/src/utils/nono.ts` — and passes that path at both sites. An unresolvable profile is a **named refusal** before anything is launched (`profile file not found at <path>`); a bare name is never passed to nono. `TPS_NONO_PROFILES_DIR` moves the bundled candidate so the harness can point it at a fixture copy or at a missing directory.
  - Part C now runs the supervisor with `XDG_CONFIG_HOME` pointed at an **empty** dir, so the profile can only come from the bundled dir: the positive run (launch, session bound, git OK), then three fails-firsts — no profile reachable → the named refusal; `tps-base`'s `/dev/null` allow reverted in a private bundled copy → refuses everything; the resolver reverted to the bare name → the same setup that launches refuses, because nono can only report `Profile not found` for a bare name.
  - `docker.yml` gains a launch-level smoke of the **built office image** (after the byte smoke): with a one-agent fixture roster it asserts the bundled profiles exist at the path the supervisor resolves, that `nono run --profile <bundled path> -- true` exits 0 inside the image, and that the supervisor's probe passes — the fixture agent really launches under nono. A Dockerfile that forgets the `COPY` turns that step red.
  - Part B's orphan check no longer reads as a pass when `pgrep` is absent (`bad "pgrep missing; cannot assert no orphan"`), and the identity-grant ℹ️ message names the path it expects and says the office never writes it (office.ts writes only `team.json` under the mount root; `tps agent create`/`tps branch`/`tps identity init` write into the operator's own `$HOME/.tps/identity` on the host, not into the bind mount).
  - **The launch gives the agent a HOME it owns.** The image-level control above caught a second ship-red defect: `su -m` preserved the supervisor's HOME (`/root` in the image) into the sandboxed child, so nono could not create its session/audit state root (`Failed to create session directory /root/.local/state/nono/audit/…: Permission denied` — nono refuses a state root inside a grant, and `/root` is not writable by the agent uid) and **every agent silently failed to start** while the supervisor still exited 0 — the probe, which runs without `-m`, passed. The launch now runs the agent with `HOME=/home/<agent user>`: its own account home, writable and outside every grant, and the same HOME the probe already had (`su -m` still preserves PATH and SBOX_ENV). Part C asserts the launched agent's own HOME through the shim and asks `nono ps` with the passwd HOME (no `-m`) so a regression there cannot hide.
  - The `docker.yml` step is fails-first: built from a private copy of the same Dockerfile with the `COPY` removed, it exits non-zero on the first assertion (verified locally against both images).
- **The sandbox-egress CI workload can no longer fail for reasons unrelated to the sandbox (cli#352 r2).** The profile gate's `fetch` workload targeted `api.github.com`, whose anonymous per-IP limit (60/h, and runner IPs are shared) can answer `403` → `r.ok` false → the workload exited 1 while the sandbox was fine (the macOS lane, cli#352 r2). It now pings `registry.npmjs.org/-/ping` (no anonymous rate limit), prints the HTTP status/status-text/body so a red lane names the cause instead of quoting nono's denial summary, and the probe output records that the parent-dir read denials bun produces while walking up from the cwd (`/Users`, the probe dir) are expected and are never a failure by themselves.
- **The office image's launch control exercises the SHIPPED agent, not a stand-in (cli#352 r4, Refs #341 #351 #352).** Both reviewers named the same coupling: the supervisor's `tps-agent check --id …` pre-flight exists only in this branch's `packages/agent`, but `docker/Dockerfile` installs `@tpsdev-ai/agent@${TPS_VERSION}` from npm (latest 0.5.4, whose bin has no `check`) and the `docker.yml` smoke substituted a `tps-agent` stand-in whose `check` exited 0 — the harness supplying what the image lacks, one entrypoint over from r3.
  - `docker/Dockerfile` keeps `npm install -g @tpsdev-ai/agent@${TPS_VERSION}` as the shipped path and gains a **verification-only** build-arg `TPS_AGENT_TARBALL` — a path, relative to the build context, of an `npm pack` of `packages/agent`; when set, that tarball is installed instead, so an image can be built and smoked from the workspace agent *before* the release publishes it. The release build never sets it, and `docker.yml` does not pass it.
  - `docker.yml`'s launch control no longer writes a `tps-agent` stand-in: the supervisor's `check` pre-flight and its `start` launch both run the SHIPPED `/usr/local/bin/tps-agent`, readiness is the real agent's **own** signal (the pid file `tps-agent start` writes at `<workspace>/.tps-agent.pid`), and the supervisor's exit status is asserted as well as readiness. An image built from the published 0.5.4 agent (no `check`) goes red on the real pre-flight, with the supervisor's named refusal in the log.
  - `test/security-properties.test.ts` couples the two: the smoke must not write a `tps-agent` shim, must assert the real readiness signal and the supervisor's exit status, `packages/agent`'s version must be at least the one that introduced `check`, and the Dockerfile must keep the published install and gate the tarball behind the build-arg.
  - Ordering (also stated in the PR body): merge → the release publishes `@tpsdev-ai/agent` 0.6.0 (with `check`) → `docker.yml` (`workflow_run: Release`) builds the office image from it.
- **`@tpsdev-ai/agent` 0.6.0 (Refs #341 #352).** The binary gains the `check` sub-command (the supervisor's launch-id pre-flight), so the agent version moves in lockstep with the CLI train — `release.yml` publishes the agent at the tag version and its skip-path checks `npm view @tpsdev-ai/agent@<tag>`. Two runtime deps the agent imports were undeclared — `@noble/ed25519` and `canonicalize`, loaded through `lib/signEnvelope.ts`, so the shipped binary failed to **load** at all (`ERR_MODULE_NOT_FOUND`) and even `check` could not run — and are now declared; the dead `@tpsdev-ai/cli` dependency (imported nowhere in `packages/agent`; its envelope helpers are local) is dropped so the published agent installs and loads standalone.
- **Review round r5 (cli#352 r5, Refs #341 #351 #352).** (1) The supervisor derives the identity grants from the roster FILE's own directory only — the `TPS_STATE_ROOT` override is **removed** (CWE-668: a value diverging from the fixed `/workspace/.tps/team.json` could grant an agent another state tree's key for the same id). A harness that needs a different root points `TEAM_FILE`'s directory, never an env override; `test/security-properties.test.ts` now asserts the supervisor reads no `TPS_STATE_ROOT`. (2) The profile gate's fetch workload retries a **transient** registry failure (DNS/TLS/CDN/5xx — bun reports these with a short code, `ConnectionRefused`/`FailedToOpenSocket`/…) **3× with backoff** before failing, printing the status/error it saw on every attempt so a red lane still names the cause. A **sandbox denial** (`EPERM`/`EACCES`/permission denied) still fails immediately, and any non-5xx HTTP status is never retried.
- **Merge `main` (cli#350 S1a) and fix the agent-uid allocation it exposed (cli#352 r6, Refs #341 #350 #352).** Bringing `main` in (no rebase) hit one text conflict — `Dockerfile.test`'s apt line — resolved to the **union**: `git jq procps` (the office lane needs all three) **plus** `nodejs`, keeping main's `nodejs` comment verbatim. Without `nodejs` the cli#350 attested-launch positive stops executing the real artifact and the lane goes green proving nothing. The same merge textually collapsed the `docker` job's two sides into one job with **duplicate step IDs** (`pin`, `nono-cache`) — an invalid workflow (actionlint: "step ID must be unique within a job") — so main's attested-lane steps are renamed to `pin-attested`/`nono-cache-attested` (behaviour unchanged). The merge then surfaced a real defect the supervisor had all along: main's `tps` user at **uid 1001** collided with the supervisor's hardcoded `uid=1001` (`useradd: UID 1001 is not unique`), and 1000/1001 are the first/second human accounts on essentially every Linux host — so the office would have collided on a real machine. `docker/tps-office-supervisor.sh` now seats agents from **`AGENT_UID_BASE=20000`** (one named constant, clear of the human range) and, more importantly, **never assumes an id is free**: `first_free_id` probes `getent`, takes the next free id, is bounded by `AGENT_ID_SCAN_MAX`, and refuses loudly (naming the base, the range and the agent count) rather than reuse a colliding id. The `tps` group gets the same rule. The harness drops its "the test image has no group tps" assumption and adds a positive that pre-occupies the base uid and asserts every agent is seated above it (fails-first against the pre-r6 code). Part C and the cli#350 attested lane stay green.
- **Review round r7 — every seating-loop refusal now stops the launched agents first (Sherlock, cli#352 r7, Refs #341 #352).** The r6 uid-exhaustion refusal exited *without* `shutdown_children TERM`, so a failure at `i>0` orphaned agents already launched in earlier iterations — `pids.json` is written only after the loop and the EXIT trap only removes it, so nothing durable would reap them. That broke S2's whole-or-absent invariant; both sibling refusals in the loop already stopped the children. The r6 exit now does too. The same invariant, asserted over the source, surfaced **four more** members of the class: the roster-shape validation exits (`id`/`configPath` missing or invalid) also fire mid-loop at `i>0` and orphaned earlier agents — they now stop the children as well. Part A asserts that **every `exit 1` inside the agent seating loop is preceded by `shutdown_children` in the same branch**, so a new exit cannot reintroduce the class; verified fails-first (removing the r6 line turns it red, naming the line).

- Pin the Docker image's nono install to the immutable commit behind tag v0.74.0 (`commit=` in `.nono-version`, verified via `git rev-parse HEAD`), replacing the unpinned default-branch clone (cli#341).
- **Contract the image is now built to satisfy:** the shipped `nono` bytes come only from the pinned `nono-builder` commit. `nono-builder` records the sha256 of the binary it built at the asserted commit, in the same logical line as the pinned checkout and as its last instruction; the runtime stage's **last instruction** is an exec-form `RUN` with **exactly one** `--mount=type=bind,from=nono-builder,…,ro` and reads its baseline, its tools **and its interpreter** (`/b/bin/sh`) from that read-only mount of the builder stage — so no writable runtime-stage state (a rewritten baseline, an overwritten tool, a `/bin/sh` shadow, a `SHELL` directive, an `ENV PATH`, or a second mount shadowing `/b` or the shipped path) can change what is compared — and it fails the *build* if the shipped `/usr/local/bin/nono` is **absent or a symlink**, or does not hash to it (no pipeline whose exit is `xargs`'s; `sha256sum`'s status is captured). The **primary control is the post-build smoke** in `.github/workflows/docker.yml`, which runs **before** any push: the shipped binary must execute from the image without a shell, be a regular file on the runner host, and match `docker/nono.sha256` — **nothing in the runtime stage can alter what it compares**. Capability removal is best-effort hardening; this assertion is the control (cli#341).
- The runtime stage installs only what the shipped workload needs: `git` (the agents it starts shell out to git), `ca-certificates` (TLS for git), `jq` (the supervisor uses it), `libdbus-1-3` and `node`. No `curl`, `wget`, `python3`, `nc`, `socat` or `php` is installed (cli#341).

- Bump `js-yaml` to `4.3.2` in `@tpsdev-ai/agent` and `@tpsdev-ai/cli` to clear GHSA-2883-xcg3-v3hh; `bun audit` reports no vulnerabilities again (cli#348).

### Omitted from the 0.6.0 notes at release time:

- **`release.yml` diagnoses a failed `npm stage publish` from npm's error code instead of assuming a staged collision.** The first real OIDC run failed with `ENEEDAUTH` and nothing had ever been staged, but the failure text asserted "Most likely it is ALREADY STAGED" and sent the operator hunting for a pending stage that did not exist.
  The step now captures npm's own output and branches on the code it reports: `ENEEDAUTH`/`E401`/`E403` names an OIDC authentication failure and points at the package's Trusted Publisher registration, the `id-token: write` permission and the npm version floor; an already-exists or `E409` conflict keeps the staged-collision recovery block; any other code is reported as unclassified, with the raw npm code, rather than guessed at.
  Every terminal failure now discloses, first, the packages this run already staged and hands over the partial-stage recovery procedure — both are cause-independent, so a partial stage can no longer be hidden, or left without a way to clear it, by whichever failure branch happens to fire, including the unclassified catch-all. Only the collision diagnosis stays confined to the collision branch, since that is the part that must not be guessed.
  The 2FA rationale is corrected: per `npm-stage(1)` only `approve` and `reject` need interactive proof-of-presence, and the actual reason CI cannot inspect the staging area is that a token issued through a trust relationship cannot run `npm stage` subcommands at all.
  The job Summary reports staged and skipped packages as separate counts, prints "Nothing is live yet" only when nothing was skipped, and shows the dist-tag promote reminder whenever anything was staged or already published — so the re-run in which all six were already live still says how to move `latest`, instead of hiding its only remaining step (cli#368).

**Full commit range:** https://github.com/tpsdev-ai/cli/compare/v0.5.4...v0.6.0
