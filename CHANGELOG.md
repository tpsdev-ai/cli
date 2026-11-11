# Changelog

All notable changes to the TPS CLI are recorded here.

## [Unreleased]

Entries for the next release live as **fragment files** under [`.changelog/unreleased/`](.changelog/unreleased/) —
one file per change, so pull requests with distinct fragment filenames do not share an edit to this section.

Add `.changelog/unreleased/<category>-<slug>.md` containing your entry as it should read under
its `### Category` heading, leading `- ` included. Categories: `added`, `changed`, `deprecated`,
`removed`, `fixed`, `security`.

```bash
node scripts/changelog-fragments.mjs render   # preview the assembled section
node scripts/changelog-fragments.mjs check    # what CI checks
```

`node scripts/changelog-fragments.mjs promote <version>` writes them into a `## [<version>]` section
below this one and deletes them as part of a version cut. **Do not add anything to this section by
hand**: `check` and `promote` refuse while it holds anything but this note.

## [0.9.0] — 2026-11-11

### Added

- **Audit main daily; on failure, attempt to comment on or open the tracking issue, leaving the run failed if listing or writing fails.**

- **`scripts/promote-latest.sh` dispatches the Docker image build after `latest` has moved (Refs #420).**

  After a successful move, the script runs `gh workflow run docker.yml --repo
  tpsdev-ai/cli -f version=<version>`. A dispatch that fails leaves the promote
  in place and exits 6; `--no-docker` skips the dispatch.

- **Reject nonrelease `@tpsdev-ai/*` dependencies in regular, non-symlinked `package.json` files outside `node_modules` and `.git` (Closes #424).**

- **`github_review` refuses `APPROVE` without an authenticated, passing evidence record for the same repository, PR, dispatch, reviewer, session, commit and configured CI job (#426).**

  `scripts/reviewer/run-review-jobs.mjs` writes the record when given the
  evidence arguments: each job's planned `run:` scripts and its launcher's exit
  status as `docker exec` returned it. `APPROVE` is also refused unless the store
  and its key resolve outside every `sandboxMountRoots` path. `REQUEST_CHANGES`
  and `COMMENT` are unaffected. Its digest is recorded in the audit draft and in
  an acknowledged signed audit record when that write succeeds.

- **Changelog entries are now one fragment file per change under `.changelog/unreleased/`, so pull requests no longer conflict on `CHANGELOG.md`'s `[Unreleased]` block (Closes #449).**

- **A real-Flair CI lane.**
  Runs the named test files: memory and registration
  cases, the mail Agent-read guards, the Presence contract (a capped task
  served to a signed reader, and a refused Bearer token) and the review-trigger
  case (Flair stamps a signed non-admin write with its signer, and the loop skips
  an event that only claims the agent's attribution). A guard scans repository
  `*.test.ts` and `*.test.js` files outside `node_modules` and `dist`; any reference
  to `TPS_TEST_REAL_FLAIR` requires lane naming and workflow path coverage.
  Named files must have at least one expected case.
  The lane runs against `@tpsdev-ai/flair@0.58.0` on Harper.

- **Add a 7-day release-age gate for dependency resolutions and locked external versions.**

  Bun refuses young versions at resolution time. `scripts/check-dep-ages.mjs` checks every
  external version in `bun.lock`; young versions require a dated exception in
  `docs/dep-age-exceptions.md`. Invalid exception lines fail the gate.

- **A signer inventory test classifies every `TPS-Ed25519` site in the packages'
  src trees.** The scan lists each occurrence of the literal (string, template
  or concatenation operand) and each reference to a binding that holds it. Every
  site must be either a signer mapped to a test that drives it against the
  shared verifying Flair stub, or an explicit non-signer with a reason. An
  unclassified site, a stale entry, or a reference the scan cannot resolve fails
  the inventory, and the stub refuses an unsigned caller through the real
  request path.

- **Release-age exclusions need unexpired dated exceptions.**
  CI reads `minimumReleaseAge` and `minimumReleaseAgeExcludes` with Bun's TOML parser. It fails when Bun cannot
  be run or rejects bunfig.toml, and when the threshold is missing, not a non-negative number, or below 7 days.
  Each excluded name needs an unexpired dated entry and an exact declaration. Its declarations in dependencies,
  devDependencies, optionalDependencies, peerDependencies and the root package.json's overrides must be exact
  pins; its override in a nested package.json, and a `resolutions` key of its name or `**/` and its name, are
  refused. Outside node_modules and .git, it follows in-root manifest and directory symlinks and refuses outside-root links.
  When `minimumReleaseAgeExcludes` is non-empty, the gate also refuses root `workspaces` patterns it cannot model
  (for example `!` negation, extended globs, `..` or empty alternatives in a brace group, brace/class mixes); it exits 2 naming
  the pattern. `docs/dep-age-exceptions.md` lists the refused shapes.

- **A CI lane runs `tps heartbeat` against a real, pinned OpenClaw release.**
  The dead-gateway case asserts the persisted error and exit 1; the live case
  starts the real gateway on an ephemeral port and asserts an online record and
  exit 0. The lane installs an exact OpenClaw version from a committed lockfile that
  pins the tarball integrity into a temp prefix with install scripts disabled,
  and leaves the lockfile unchanged.

- **The release-age gate checks tracked `package-lock.json` files (Closes #797).**
  It requires a v2 or v3 npm lockfile and ages npm entries by canonical registry tarball URL, or recorded name@version
  without `resolved`, regardless of `inBundle`. It refuses versionless entries,
  URL/name/version disagreement, non-canonical registry URLs (including query
  strings and percent-encoded path components), and git URLs. Root, link and unencoded local entries are
  skipped. CI installs tracked npm lockfiles through a helper that reads the manifest and lock from `GITHUB_SHA`
  under GitHub Actions (validated as 40 hex characters), or `HEAD` locally, and compares the installed lock against
  those bytes afterward.

### Changed

- **The Docker image workflow builds each platform natively, smokes that platform's OCI archive, and assembles one manifest index (Closes #353).**

  `linux/amd64` and `linux/arm64` build on their own runners, without QEMU.
  Each leg loads its own OCI archive and checks its nono against
  `docker/nono.sha256` and its `--version` against `.nono-version`, then uploads
  the archive. A `publish` job copies each archive with `--all
  --preserve-digests` into a local `registry:2`, records the platform's
  image-manifest digest, assembles the index from those digests, and checks the
  index's non-attestation entries are exactly `PLATFORMS`. After the index
  verifies, a second local registry rehearses the index copy whether or not
  `publish` is set. Only `publish=true` logs in to
  ghcr.io and copies that index to the computed tags.

- **Breaking: the TUI approve and merge actions are removed**. Pulse notification mail uses
  the `pulse` principal. `pulse start` requires `mergeAuthority`, `ghAgent`, and
  `author`; transitions require their notification recipient before changing
  state. The keyring-PAT, office-health and owner-inference agent lists come from
  the credentials manifest's `agents` list; pulse's reviewer list stays in pulse
  configuration.

  **Upgrade:** a Pulse config that relied on the defaults must set `mergeAuthority`, `ghAgent` and `author` in `~/.tps/pulse/config.json`, and provision the `pulse` principal (a local signing key registered in Flair, for example `tps agent create --id pulse` while Flair is available), which `pulse start` also requires.

- **Breaking: `tps memory archive`/`unarchive` fail closed and PATCH only the governance fields; `search` signs as `TPS_AGENT_ID`; `approve`/`reject` are unsupported.**

  Archive and unarchive read the record first and refuse, without writing, when
  that read fails or returns an incomplete record; the update is a server-side
  PATCH carrying only `archived`, `archivedBy`, and `archivedAt`. Search signs as
  the operator and passes the target agent as the search's `agentId` parameter.
  `approve` and `reject` exit non-zero: Flair has no operation that promotes or
  rejects a memory by id.

  **Upgrade:** scripts that call `tps memory approve` or `reject` must stop; the commands now exit non-zero.

- **`tps agent create` registers a `pending` agent's key through Flair's `POST
  /AgentKeyRegister` when the route accepts it and the stored key reads back
  equal.** It sends the generated key through that route over its operator
  credential. Definitive refusals exit non-zero with the agent, the Flair URL,
  the refusal name and a remedy; an error response with no recognized refusal,
  or an unreadable error body, remains unconfirmed with its HTTP status; an
  unrecognized 404 or 405 names the minimum Flair
  version that serves the route as the likely cause. After a successful or
  ambiguous POST, a read-back that fails or does not return the generated key
  reports this attempt unconfirmed with a re-run-create remedy. Flair
  drops `publicKey` on `Agent` PUT and PATCH.

- **Mail placement intents carry a phase; MailClient recovery, the CLI lease sweep and promotion skip or preserve non-`placing` intents (Refs #617).** Phase names here are the phase `phaseOf` resolves. It checks `version`, `presentations`, `firstPresentedAt` and `claim` before `phase`, and an unsupported value in any of them (a `claim` that is not a valid presentation claim, `null` included) resolves to `unknown` whatever `phase` says: `version: 2` with no `phase`, and `version: 2` with `phase: "failed"`, both resolve to `unknown`. An intent with no `phase`, a recognized `version` (absent or `1`), valid liveness values (`presentations` a non-negative safe integer, `firstPresentedAt` a parseable timestamp, each optional) and no `claim` resolves to `placing`; a valid `claim` is accepted only on an `in_progress` intent, so an intent with no `phase` and a `claim`, or a `failed` intent carrying one, resolves to `unknown`. So an otherwise-valid older intent whose `file` is a plain basename is handled exactly as before, and records with no intent are handled as before. On those paths, a record whose intent resolves to `in_progress` or `unknown` (an unsupported value in the recognized `phase`, `version`, `presentations`, `firstPresentedAt` or `claim` fields; other extra fields are ignored) is never finished, replaced, presented or checked out. Such an intent is not quarantined solely for that value, and it keeps only its own file's delivery gate closed. An intent that resolves to `failed` leaves its per-file (filename) gate open, while its message ID stays refused by the consumed-ID (replay) gate; it is not presented on those paths. It stays until an operator removes it, and its payload follows ordinary `cur/` archive and GC retention. One exception to preserving a non-`placing` intent: once a `failed` payload has left `cur/`, a different message may reuse the name. Its placement moves the marker to `.placement-<hash>.failed-<messageId>.json`, which keeps the old consumed ID retained, if that tombstone name is unoccupied or is the marker's own inode (treated as an interrupted move). An occupied tombstone refuses the reuse by name and keeps both files, and the new message is not delivered. While the payload is still in `cur/`, the new message waits.

  A placement intent whose `file` is not a plain basename (empty, `.`, `..`, or containing `/`, `\` or NUL) is now refused on write and quarantined on read. That includes an older intent the previous parser accepted when its hashed name matched: the one exception to legacy parity.

- **MailClient adds a per-message delivery API; CLI recovery and actions guard placement phase (Refs #617).**

  Unresolved `placing`/`in_progress` work defers `deliverNext()` commits.
  The token set covers MailClients of one module copy; claims from other copies
  in the same process are treated as live until process exit or lease expiry.
  Release failed handoffs before retrying. Completion
  checks the issued token and recorded device, inode, size and SHA-256.
  On later calls, an unclaimed `in_progress` intent becomes `failed` before
  a presentation beyond the fifth, or after the deadline of 24 hours from
  first presentation. The failure transition does not delete an existing payload;
  a kill after the phase write can prevent its log line.

  CLI recovery dispatch claims, ack and nack check placement phase under the
  mailbox lock. The OpenClaw plugin guards its envelope-less verification
  branch and its ack/nack stamps too.

- **The agent event loop processes one mail delivery at a time (Refs #617).**

  Handler completion requests finalization; a turn-limit return or thrown
  handler requests release. Deferred finalization and release are retried on
  the same delivery. Deadline quarantine requires the mailbox lock and storage
  to become available. A failed storage operation can leave the durable transition
  uncertain. A stop prevents
  the next `deliverNext()` call; a check already waiting can return a delivery,
  which the loop processes and attempts to settle before shutdown removes the
  PID file. Deferred settlement is retried; a stop bounds the retries, and the
  last deferral or refusal is logged. Any refusal can leave the intent pending,
  blocking that message until resolved.

  A handler that never returns cannot reach the presentation or deadline checks.

  A committed unfinished hand-over can be re-presented after a kill when
  recovery can verify it. A durably finalized delivery is not presented again.
  Delivery API consumers receive a JSON-encoded
  `[canonical mailbox path, messageId]` key, stable across presentations at that path.

- **`tps roster dashboard` and `tps office status` read per-agent presence from the Presence roster of the Flair instance they query.**

  Both views read `GET /Presence` from the queried Flair instance instead of the
  viewer's OrgEvent catch-up feed. Agents push heartbeats, their activity and
  their current task to Flair; Flair derives each agent's status and whether its
  activity is still fresh when it serves the read. The dashboard's last column
  is `Last Seen`: the presence status and the age of the agent's last heartbeat.
  Office status shows the same in `LAST SEEN`, and also the agent's current task
  or activity in `ACTIVITY`, or `was: <last activity>` (Flair's `lastActivity`)
  once Flair reports the activity stale. Only agents in the Agent list are
  displayed. A listed agent with no stored Presence row on the queried instance
  reads `no presence on this instance`. An older local row can remain after an
  agent moves. Presence is not federated. The presence columns read
  `unavailable`, not an empty column, when the read cannot be signed (it is then
  not sent) or fails, or when the roster has a missing or invalid field the
  views read or two records for one agent. Cross-field checks reject stale
  task/activity (a stale record with a current task or non-`idle` activity),
  fresh activity equality (fresh activity differing from lastActivity), and
  offline freshness (an offline record with fresh activity). Other combinations
  are not checked, including status versus a future heartbeat. Office status
  prints no blocker line. It prints the table's values with C0, DEL and C1
  control characters replaced by a visible placeholder (U+FFFD); a long value
  is not truncated and can widen its row.

- **Refusals from setup-failure cleanup and the bound teardown print inspection guidance, not a `git worktree remove` command, for a path the base no longer lists.**

  When `git worktree list` fails, the refusal reports that failure with the same
  guidance (#676).

- **The Docker Integration lane fails, instead of skipping, when the root-only set-runtime real-owner case loses a prerequisite (Closes #801).**

  The lane's `test` service sets `TPS_TEST_REQUIRE_REAL_OWNER=1`; a missing
  prerequisite then fails the case and names it. Other lanes keep the skip
  with the same reason.

- **`tps mail relay stop` exits non-zero when it refuses an unreadable or unverified pid record, and `tps bridge status --json` adds a `records` array.**

  Stop prints the record's guidance, signals no process and exits non-zero.
  Bridge status `--json` keeps the existing `running`, `pid`, `port`, `adapter`
  and `bridges` fields unchanged, and adds `records` with one
  `{ adapter, path, state }` entry per pid record. One liveness probe per
  unverified pid decides both its `records` entry and its `bridges` entry:
  `state` is the record kind (`running`, `invalid`, `stale`, `unverified`,
  `unreadable`), an unverified record whose pid the probe does not find alive is `stale`, a record
  whose kind carries a `pid` includes it, and an `invalid` or `unreadable` record includes
  its `reason` when it has one.

- **The reviewer's skip allowlist accepts `actions/cache` at v6.1.0, pinned to its release commit.** A workflow that pins that commit is no longer refused as an unreviewed ref.

- **Superseded pull-request runs are cancelled once a replacement starts, and smoke runs linux-x64 only on a pull request.**

  A newer push cancels a pull request's pending or in-progress run of these
  workflows, once that push starts a run. Smoke starts a pull-request run only
  when its path filter matches; a push to main keeps all four targets.

  A manual re-run of an older PR run cancels the current head's run only while
  that run is pending or in progress; a replacement head run may then be needed.
  A stale run does not supply a completed check for the current head.

- **CI test jobs fail after a bounded time instead of hanging (Closes #799).**

  Every job in `.github/workflows/test.yml` today is covered and sets
  `timeout-minutes`; a structure test fails a covered job that omits it or a
  job not named in the test. An exempt job may omit a timeout but needs a reason
  in the test.

- **Heartbeat skips the gateway probe only when `runtime` parses as `native` and
  has a single top-level plain `runtime: native` line,** with optional trailing spaces,
  tabs or a `#` comment; every other form is probed. Set it with
  `tps agent set-runtime --id <id> --runtime <openclaw|native>`.

- **The mailbox lock's default retry interval is 2 ms instead of 25 ms (Closes #538).**

### Removed

- **The unused root CLI tree (root `src/`, `bin/tps.ts`, `scripts/stall-monitor.ts`) is deleted; the CLI lives in `packages/cli` (Closes #379).**

- **The unpublished `@tpsdev-ai/pi-tps-mail` package is deleted (Closes #384).**

### Fixed

- **TPS help requests print usage before dispatch.** Option values and wrapped-command arguments remain data.

- **Office supervisor**: `shutdown_children` sends the stop signal, polls until the whole-second `SECONDS` deadline (at least the grace, at most the grace plus one second and one poll), stopping early when all tracked PIDs exit, attempts KILL for every tracked PID still alive, clears the tracked list and only then removes the PID file. A signal that arrives between a launch and the tracking of its PID is recorded by the handler and acted on right after the PID is tracked.

- **`tps skill show <name>` and `tps skill revoke <name>` read the skill name from the positional argument; `--name` still wins (Closes #360).**

- **CLI Claude Code, Codex and Gemini runners require launcher release or an interactive TTY `--no-sandbox` opt-out (Closes #363).**
  Conflicting sandbox flags and values other than `true` or `false` are refused by name.

- **Promotion locking, npm timeouts, and combined SemVer suffixes.** `promote-latest.sh` serializes runs with a repo-local lock. Each npm call runs under a Node supervisor with a `NPM_TIMEOUT_SECONDS` deadline (range 1..2147483), timed from just after spawn, and a 2-second TERM grace. At the deadline it sends TERM if npm is running; after grace it sends KILL if npm is still running. A timed-out write or a signal during a promote write keeps the lock and exits 7; its reason file lists each uncertain write by operation and attempted version when it can be written. The lock refusal prints the holder's PID, or `unknown` if the `pid` file is absent. The version check accepts prerelease plus build metadata.

- **Breaking: updates touch only existing records, and `MailClient` requires a verifier (Closes #380).**

  The deploy bot (`scripts/deploy-bot.ts` and its copy under
  `packages/cli/scripts/`) and the channel bridge's outbound consumer
  (`BridgeCore.watchOutbox`) moved `new/` records into `cur/` themselves.
  Failed verification refuses delivery and attempts dead-lettering. Each also re-drives retryable `dlq/`
  entries: the deploy bot on every poll, the bridge at a configurable
  interval, defaulting to 30 seconds.

  `@tpsdev-ai/agent`'s `MailClient` throws when constructed without a verifier;
  embedders must pass one. It also shares the envelope policy and locked consumed-ID replay store with `promote()`,
  which now live in `@tpsdev-ai/agent`.

  **Upgrade:** pass a verifier (a `FlairClient`) when constructing `MailClient`.

  The writer scan allows promotion, the locked existing-only `updateExistingRecord()`
  helper, `MailClient`, the container outbox/cur archive (`relay.ts`) and the
  office internal-mail store (`internal-mail.ts`). The delegation check covers
  `checkMessages`, `setBridgeSentAtPath`, `ackMessageAtPath`, `nackMessage` and `patchMailFile`.

- **`bun run audit` invokes `bun audit`, the command CI's Dependency Audit runs; the root `ws` dependency now equals its override (Closes #390).**

- **Mail events are logged under Node when `node:sqlite` is available, as well as Bun: a `node:sqlite` adapter writes the same `archive.db` (Closes #395).** Setup, migration, read, write and close failures produce diagnostics per archive path, operation and error code.

- **Reply-obligation timers and contexts clear on a stop matched to the active incarnation (Closes #403)**. Restart recovery requires readable obligations and verifiable inbound mail.

- **The Docker Image workflow is dispatched with a version and refuses one npm
  has not published.** It ran on the Release workflow's completion, while the
  packages were still staged, so the image build's `npm install` failed with
  ETARGET. It now runs only when dispatched with a version, and it pushes the
  image only after the version has the required shape, npm has published it,
  and the image builds and passes its smoke checks. `:latest` is pushed only
  when the version equals npm's `latest` when the tags are computed. An npm
  version lookup with a matching E404 and no conflicting npm code stops with
  "npm could not find" and conditional staged-release guidance. Other
  inconclusive version results, and failed, empty, or malformed latest results,
  stop with "could not verify".

- **Branch handler responses resolve logical aliases to the local identity.** Replies and forwards use the inbox routing fallback when the wire recipient has no local inbox.

- **The channel bridge signs every inbound channel message as its own identity (Refs #433).** The bridge signs with the existing bridge principal and its own key, never the host agent's, through the same path `tps mail send` uses; the channel author and content ride inside the signed body, and the signed envelope's trust is `external`. A bridge with no key is refused by name and no mail record is written. The legacy unsigned `sendMail()` helper is removed; the roster invite writes through the shared signed delivery path.

- **The openclaw-tps-mail outbound adapter signs every channel send (Refs #433).** A send the plugin routes to a local mailbox, the outbox, a remote branch or a branch-office sandbox is now a v1 signed envelope from the same signing path `tps mail send` uses. A recipient's `promote()` accepts it only when the recipient can resolve the sender's key and the remaining mailbox checks pass. A sender with no Ed25519 private key is refused by name before anything is written. The reply thread rides inside the signed envelope, and the record no longer carries an unsigned wrapper `replyToId`.

- **Within the turn budget, the agent runtime refuses calls outside its advertised trust-specific tool list.** On the over-limit turn, the loop stops without executing or refusing those calls.

- **CLI-internal producers and `MailClient.sendMail` now sign mail before delivery (Refs #433).** Pulse notifications, topic publish and catch-up, hire onboarding, roster invites, bootstrap introduction and health probe, and branch replies and forwards use the v1 signed envelope. The agent runtime and CLI share strict Ed25519 key parsing and the default two-location resolver. A recipient still requires a matching Flair principal and passing mailbox policy; the bootstrap health check now proves that decision. The agent runtime derives sender and a trust label from the verified envelope.

- **Topic catch-up verifies stored publisher envelopes.** Publication stores a signed topic envelope; catch-up delivers it unchanged. Unsigned legacy entries and signature failures are skipped with named warnings. CLI promotion and native `MailClient` accept topic addresses only for local subscribers and allowed publishers. A receiver running an earlier release rejects these topic-addressed envelopes, so upgrade receivers before relying on catch-up.

- **Each job of a `needs` closure runs in its own sandbox container, from a fresh clone of the assigned commit (Closes #435).** The host-side driver `scripts/reviewer/run-review-jobs.mjs` starts one container per job and the launcher runs only the job that container is for, and it attaches no host mount beyond that job's own clone, so a change inside `.git/`, a process that starts its own session, and anything else the job leaves in its tree cannot reach the next job.

- **The review driver runs each container as the clone's owner.** (Refs #435).

- **After resolution selects the current image, the reviewer launcher refuses a `default` step in a plan with a Node pin (`node-mismatch`; Closes #437).**

  A planned `run:` step carries `node`: `default`, or the version the most
  recent preceding `setup-node` pins. Conflicting in-matrix pins are refused as
  `conflicting`; a different selected image as `wrong-image`.

- **The openclaw-github-review test lane runs under the shared HOME-isolation guard (Closes #438).** Its launcher makes the guard's launch-time checks before it creates or deletes anything. The child gets the allowlisted environment. A caller-supplied `--reporter-outfile` is refused, by one check in `scripts/test-home-guard.mjs` that all three launchers now call. A temp dir inside an operator home is refused. The report directory is resolved (symlinks followed) and refused when it resolves at or above an operator home, `$HOME` included, or inside `~/.tps`, `~/.flair`, `~/agents` or `~/.config`; the report, log and seal files themselves must not be symlinks. The `~/.tps` metadata diagnostic fails a run on a recorded difference in the `~/.tps` of the HOME the launcher started with. Its test preload uses the shared root check, so a bare `bun test` in that directory is refused like the other lanes. When the plugin's TypeScript compiler is missing, the launcher skips the build only if neither `node_modules/` nor `dist/` exists, and otherwise refuses to run.

- **Correction to the 0.7.0 notes: the `latest` promote is not all-six-or-none.** `scripts/promote-latest.sh` re-reads each move and attempts a rollback; a rollback that fails is reported and needs manual repair (Refs #441).

- **The codex runtime records liveness on Flair's Presence resource instead of writing `Agent.status` (Closes #444).** In Flair `Agent.status` is the principal's lifecycle state (a value other than `active` deactivates it), so the shutdown write of `"offline"` deactivated the agent — its requests were then refused with `401 principal_deactivated`, and the agent could no longer self-update back to `active`. The runtime now POSTs `/Presence` with the agent's own credential: one beat at startup, then one every 5 minutes on its own timer, and one bounded final `activity: "idle"` beat on SIGINT/SIGTERM. A Presence failure only logs and never writes the Agent row.

- **`scripts/promote-latest.sh` runs `npm dist-tag add` with the script's own stdin/stdout/stderr, so npm's browser 2FA can run when the script runs from a terminal (Closes #445).**

  Both adds (promote and rollback) ran inside a command substitution, so npm's stdout was not a TTY and npm could not prompt for 2FA; the first add exited `EOTP` without moving the tag. Neither add is captured now. npm prompts for 2FA only when stdin and stdout are both a terminal, so keep both stdin and stdout attached to a terminal when running the script. A move still needs a zero exit from the add and a registry re-read that shows the target.

- **Fix symlinked entry checks in `scripts/test-suite.mjs` and `scripts/check-test-reports.mjs`.** Node’s default symlink resolution broke the old comparison; both scripts now compare canonical paths.

- **The `tps` launcher preserves non-zero platform binary exits and maps signals to a non-zero code (Closes #480).**

  Previously, either case ran the JS fallback: success returned 0 without a
  banner; otherwise it printed the missing-binding banner and returned 1.
  Fallback now runs when the platform package could not be resolved or the
  binary could not start. A missing JS entry prints reinstall guidance and exits 1.

- **First delivery never replaces or writes through an existing `cur/` record (Closes #482).**

  A delivery never replaces an existing `cur/` record: both writers place it with an exclusive hard link.

- **Breaking: the bridge, roster dashboard and `tps agent commit` require a configured
  agent identity**. Each refuses by name when none is set rather than falling
  back to the literal `anvil`.

  **Upgrade:** anything that relied on the implicit `anvil` identity must set `TPS_AGENT_ID`.

- **A webhook delivery that finds a completion record for its `X-GitHub-Delivery` ID returns 200 without calling GitHub (Closes #490).** The record is written after the event is handled; until it exists, a redelivery can repeat the re-request.

- **Report failed cur/ stamps**. Retry failed ack/nack stamp writes.

- **Mail verification decodes uniform-case hex and canonical base64/base64url public keys to exactly 32 bytes (Closes #493).**

- **The office relay logs local write failures and attempts dead-letter storage (Closes #494).**

- **Breaking: `tps branch start` and memory governance actions refuse by name without an identity.**

  Branch start takes `TPS_AGENT_ID` or the id persisted by `tps branch init --agent`. Memory `review`, `approve`, `reject`, `archive`, `unarchive`, `purge`, `list`, `show`, and `search` take `TPS_AGENT_ID`; `review` and `list` can use their agent-id argument.

  **Upgrade:** a branch initialized without `--agent` and a memory command run without an identity (they used the host name and `admin`) must now get `TPS_AGENT_ID`.

- **A Flair public key of exactly `pending` now fails mail verification retryably instead of being rejected as malformed (Closes #507).**

- **Relay delivery and ACK accept the 64-hex delivery ids that GitHub-webhook outbox records carry.**

  `tps office sync` and `tps office connect` log a relayed delivery that fails wire-schema validation, naming the branch and the invalid fields.

- **A relayed resend within its retention window creates no additional inbox record, keyed by authenticated branch and delivery id (Closes #513).**

  A relayed inbox record is now named by a key derived from the authenticated
  branch id and the delivery id. A resend of the same id from the same branch is
  matched to that record by its name, including when the inbox write succeeded
  but the acceptance receipt was not written (a crash between the two). A
  recognised resend creates no additional record, and the record keeps its file
  name and id. When the match is in a mailbox root that acceptance holds for
  writing (the recipient's own always is), its `receivedAt` is refreshed; a match
  in a root scanned read-only is returned without that rewrite. The same id from
  a different branch is still delivered.

  The retention window lasts while the record is in the mailbox (new, cur or the
  dead-letter queue) or its acceptance receipt is unexpired (seven days by
  default). After a local ACK has removed the record, a matching receipt means a
  resend writes no record at all. Once both the record and the receipt are gone,
  a resend is eligible for a new delivery attempt, and the ordinary inbox and
  dead-letter paths apply to it.

  A record under the keyed name that does not parse as a mail record refuses the
  delivery, with no ACK and no replacement. Repair or move it aside so a retry
  can be accepted.

- **Verify pending mail placement copies before committing them (Closes #515)**

  Cleanup preserves pending files; `MailClient` resolves trust tier before placement.

- **Sandboxed agent launch keeps `--config`, prepares the worktree with checkout deferred, and ignores flags inside a wrapped
  payload.** For a selected runtime whose workspace has a base repository, `tps
  agent start` reads `--config` once into a private snapshot used for parsing,
  the attested re-exec and its read-file grant; when a base repository exists and the workspace is absent,
  the parent creates the worktree with the checkout suppressed
  and the hook path and fsmonitor disabled. Relative workspaces use the source config
  pathname’s directory; the child uses the parent’s absolute workspace and refuses
  a pending-worktree mismatch with `WorktreeLifecycleError` before checkout.
  The sandbox-flag scan reads parsed arguments before a wrapped payload.

- **Fix `tps secrets-guard` mode parsing (Closes #517).**

  A child argument `--check` or `--no-guard` leaves the guard's mode unchanged.

- **The nono agent launch path refuses profile access to protected credential paths and writable launch directories overlapping nono profile directories.**

- **Host-side relay acceptance validates stored records and refuses payload conflicts without ACK.** MailClient retains its signature-verified replay gate.

- **`tps office connect` announces a relayed message after its inbox record is published (Closes #524).** Conflicts and deliveries dead-lettered after a write failure are not announced. Quarantining a corrupt existing record can precede publication, ACK and announcement of the incoming delivery.

- **Attempt aged owed-nack release before the unresolved-inbound hold; treat missing `cur/` records during lookup/read as resolved for retention (Closes #525, Closes #526).**

- **MailClient requires a pending placement intent to recover linked new/→cur/ records (Closes #527).** An interrupted placement left by an earlier version has no intent, so it is not delivered on recovery; after verification and the replay-history check succeed, its new/ link is removed and the record stays in cur/, and if either fails the link stays in new/ for a later retry.

- **openclaw-tps-mail: lock obligation writes and retention; keep receipts for held or ambiguous obligations.**

- **Inbox-routed branch relay deliveries are recorded before ACK.** Inbox payload conflicts are refused without ACK. Reply, forward and drop handler outcomes are outside this guarantee. Promotion rejects repeated signed-envelope messageIds.

- **Relay ACKs accepted deliveries even if the announcement callback throws or rejects.**

- **Scope TPS version detection to its argument prefix (Closes #550).**

- **The TCP, host WebSocket, and join WebSocket listeners now settle `close()` with a peer connected and resolve at once when closed.** Each terminates its accepted sockets and force-stops its server rather than waiting on them. Before, a connected peer left `close()` pending, so a branch daemon stopped with `tps branch stop` did not reach `process.exit`.

- **cli test files: a guard checks spy and module-mock teardown, and a test preload checks process.env.** A cli
  test file that contains `spyOn`, `mock`, `jest` or `vi` as an identifier fails
  the guard unless a top-level `afterEach` uses a zero-argument arrow containing only
  the Bun `mock.restore()` call, with bindings resolved through named imports,
  aliases or namespace imports from `bun:test`; a cli test file that calls `mock.module()` fails it. The
  preload appends an `afterAll` hook to each `.test`/`.spec` file bun loads,
  which fails the file when `process.env` differs from when bun loaded it,
  naming the names added, removed or changed.

- **Relay acceptance leaves records without a `relayDelivery` property in place.** Malformed records with that property are quarantined only in the recipient's own mailbox, even when its value is invalid (e.g. `null`).

- **Relay acceptance serializes receivers with a stable recipient lock and publishes into the selected mailbox.** A timeout publishes no mail record or acceptance marker.

- **Breaking: a guard flag before the `secrets-guard` subcommand is refused (Closes #563).**

  `tps --check secrets-guard …` and `tps --no-guard secrets-guard …` exit 1
  with `InvalidSecretsGuardMode` and run no child. Put the flag after the
  subcommand: `tps secrets-guard --check` or `tps secrets-guard --no-guard …`.

- **Deduplicate relay resends after local ACK while the receipt remains.** A fixed set of lock stripes serializes acceptance; a failed acceptance that throws rolls back what the attempt wrote, and incomplete rollback refuses delivery with a possible-duplicate warning; the receipt TTL also applies to flat per-branch markers.

- **The Docker integration image is built with a `BUN_VERSION` build arg instead of a floating `oven/bun` tag (Closes #578).** The Docker Integration job derives it from the root `package.json` `packageManager` and fails when the image's Bun differs from that pin. Locally, compose accepts any nonempty `BUN_VERSION`. Image tags are mutable; a digest pin is not part of this change.

- **Relay acceptance receipts store a digest and byte length of the accepted payload, not the payload itself (Closes #579).**

  A schema-valid receipt already on disk that holds the payload is compared
  by its digest while it remains within its TTL.

- **`tps agent create` names both remedy branches when a failed key read-back leaves the Agent row's existence unknown (Refs #593).**

  With the row's existence unknown, the remedy now names `flair agent remove <id>`
  (which also deletes that agent's Memory and Soul rows) as well as
  `flair agent add <id> --keys-dir <dir>`; the definite no-row remedy is unchanged.

- **Non-OK Flair response errors name the entry point, method, requested pathname, status and an allow-listed code (else `unrecognized_error`), without raw response bodies (Closes #597).**

  The client reads an allow-listed string from the response's `error` field
  when present; other values become `unrecognized_error`. Response error messages exclude
  raw bodies and other response text. The reported pathname excludes query and
  fragment; encoded parameters stay encoded when the wrapper or caller encodes
  them. Wrapper methods encode ids; `request()` sends its caller's path.
  Caught transport failures use `Flair <entry> <method> <pathname> transport
  error: <reason>` with only a fixed reason class and no message text, including
  when inspecting the failure throws. Failed
  successful-response JSON parses use `Flair <entry> <method> <pathname> →
  <status>: malformed response body`; `request()` and `registerAgent()` accept
  204 without parsing. Local checks interpolate ids (promotion refusals,
  invalid principal records, governance read refusals and missing agents);
  private-key read failures interpolate the key path and agent id. Governance
  read failures also embed the caught error's message. These local messages
  are outside the response bound.

- **MailClient recovers verified interrupted placements with matching identity (Closes #600).** Recovery verifies a `cur/` copy and, under the mailbox lock, matches its recorded identity and pre-verification raw bytes. `checkNewMail()` then finishes the intent before returning the message; `deliverNext()` returns the message with the intent still in progress and keeps it until `completeDelivery()` finishes it. Verifier unavailability or a lock failure defers recovery; quarantine is attempted for a `placing` record that verifies as neither supported format, or as both, after the identity and byte checks. A present mismatched copy or an older-build intent without identity whose only copy is in `cur/` is withheld with its intent pending.

- **Relay acceptance locks recipient and observed same-ID candidate roots.** Shared-stripe and same-ID-move guarantees require the same resolved lock directory (`TPS_MAIL_DIR` aligned with `MailClient.mailDir`); a different `MailClient.mailDir` is outside this guarantee. Recipient and candidate mailbox locks stay held in path order. Root changes while waiting trigger bounded discovery retries. Branch-receiver publication remains outside the stripe; the exported scan's earlier-root contention still raises a generic error.

- **`tps agent create` prints "registered" only when the key pair is
  consistent and Flair accepts a request signed with the private key.** Before
  any Flair request it signs a probe with the private key and refuses when the
  `.pub` file does not verify that signature, instead of using the `.pub` bytes
  unchecked. A partial identity (an entry, a dangling symlink included, at any
  identity path, without both `.key` and `.pub`) is refused before any file is
  written; `create` used to generate a new pair over it, or through the link.
  An identity file `create` reads (`.key` and `.pub`, and `.meta.json`, `.seed`
  and `.x25519.pub` when present) that cannot be read, and a `.meta.json` that
  is not JSON, are refused by name. The probe loads the private key as the
  Flair client signs with it (an unencrypted PEM key, a raw 32-byte seed or
  base64 PKCS8 DER): an encrypted PEM key is refused as encrypted, and any
  other readable key file the client cannot load is refused too. After Flair
  reads back the registered key, `create` sends one request signed with the
  private key and requires Flair to accept it and its response to carry the
  registered key. A refusal names the agent, what it found and the remedy, and
  exits non-zero.

- **MailClient promotion and dead-letter moves take the relay acceptance stripe from the configured mail directory, so CLI acceptance holding that stripe defers them (Closes #616).**

  MailClient took the stripe from its process `TPS_MAIL_DIR`, so a MailClient
  whose environment named a different root than its configured `mailDir` locked
  a stripe under that other root. Acceptance, promotion and dead-letter moves now
  derive their lock roots from resolved real paths in one shared module;
  placement recovery and the other mailbox lock sites still lock the mailbox
  root path as given.

- **The task loop and `tps agent logs` read Flair's catch-up envelope rather than a list (Closes #624).** A `task.assigned` event now reaches the task handler, and `FlairClient.getEventsSince` returns the read's outcome, so a caller can tell an empty feed from an unreadable one.

  A read is unavailable, with a bounded reason, when the request is refused or fails, the signing key cannot be read, `since` is not a valid date, or a page fails validation (its envelope, its events' fields, positions and order, or a `nextAfter` that does not follow from them). `tps agent logs` then says the OrgEvents are unavailable and still shows mail; the task loop handles and persists nothing from that read.

  The task loop keeps its feed position in `~/.tps/cursors/<agent>-task-loop.json` as `{ position, updatedAt }`, written atomically, and sends it on every read. With no usable cursor file it sets the position one hour back, once, and reads nothing until that position is saved, retrying a failed save with the same position; an unreadable file is logged and treated as no cursor, and a legacy `{ since }` file resumes from its timestamp. `tps office status` shows the cursor's timestamp in either format.

  The saved position never passes a task before its handler succeeds, provided that once saved, the cursor file is not removed or corrupted; the feed only appends (a new event sorts after those already served), with positions within five minutes of the server's time; and an event does not expire before its handler succeeds. Delivery also needs the loop to keep running, its reads and the initial save to succeed eventually, and the handler to eventually return successfully for each earlier task (a handler that keeps failing holds the loop at that task); then each task after the starting position is handled, meaning its handler returns successfully, at least once, not exactly once. The position is saved after a read's handlers run, when it advances: a crash between a handler returning and that save replays the task, and after a failed save (logged) a restart replays the events since the last successful save if it occurs before a later save succeeds. Handlers must be idempotent.

- **The codex runtime's review-trigger loop reads the agent's own catch-up feed (Closes #631).** It uses a different cursor filename from the task loop and accepts loop IDs through 79 characters, including a 64-character agent ID plus `-review-trigger`.

- **Attempt bounded publication of codex PR URLs from Flair and mail tasks** as `pr.opened`.
  Only an accepted POST can reach the review loop; exhausted retries call
  `console.warn` and return without an event if no POST was accepted.
  The review loop filters events attributed to the agent by stored `authorId`;
  an admin caller may supply `authorId`. It requests configured reviewers on the
  repository named by the PR URL, skips classified terminal failures (including
  HTTP 404/422), and gives other failures bounded attempts. A malformed
  `reviewTrigger` refuses runtime startup.

- **Breaking: a relative `workspace` in `agent.yaml` resolves against the config file's directory, and a launched child receives the absolute path.** An absolute workspace remains absolute and is normalized. A `workspace` or `repo` string starting with `~` is refused, because `~` is not expanded, and so is a `workspace` or `repo` key whose value is null (in YAML a bare `~` or nothing after the key), not a string, or an empty or blank string. For the native AgentRuntime, default `mailDir` and `memoryPath` derive from the resolved workspace (Closes #658).

  **Upgrade:** a relative `workspace` or `repo` that was meant relative to the launch directory must be rewritten relative to the config file or made absolute; a value starting with `~` must be written as an absolute path.

- **A launch that creates a worktree attempts to write an ownership marker, and cleanup attempts to remove that worktree only while the marker still matches.** Immediately after `git worktree add`, setup attempts to write a random nonce to the worktree's admin git directory with exclusive create, reports the record to the caller, then reads its identity facts. A marker it cannot write is a setup failure: the record has no marker and cleanup refuses, naming the path and, while the base still lists it, printing a POSIX-quoted `git -C <base> worktree remove --force <path>` command. When a later setup step fails, cleanup attempts to remove the worktree it created if the marker and any recorded identity facts still match, and otherwise refuses with that command (while the base still lists the path); the removal itself can fail. The setup-failure cleanup, the launch fallback and the `onStop` teardown route attempt removal of a created worktree only when the admin directory holds the exact recorded nonce; teardown does not compare HEAD, which the runtime may move. A change at the pinned path between that check and the removal is not covered (cli#706). On the `onStop` teardown route, ownership is decided by the nonce and the recorded `.git` pointer, not by the directory's identity, so a replacement directory that keeps the original `.git` pointer and is in place before that check is not detected. The worktree is added detached, so no branch is created or removed.

- **`tps agent start` removes `config-*` launch snapshots whose recorded launcher is dead (Closes #667).**

  A forced termination leaves the private config snapshot under `~/.tps/launch`
  behind. A snapshot is now created under a `.pending-config-*` name and renamed
  to `config-*` after its owner record is written, so a published snapshot has
  its owner record. The owner record
  holds the launching pid and, when one is readable, its process start token. It
  is opened without following a symlink at `owner.json` itself, must be a
  regular file of at most 4 KiB, and is parsed strictly.

  The next launch attempts to remove a published entry whose pid is gone, or
  whose pid is alive under a different readable start token from the same
  source; a live pid
  is kept when either token is unavailable or the two come from different
  sources, and so is a published entry whose owner record names a live pid under
  the same readable token. A published entry with no readable owner record is
  kept until its directory mtime is past a one-minute grace; an entry whose mtime
  cannot be read is kept.

- **A signal to the sandboxed launcher is passed on to the nono supervisor, and the released agent is then checked.**

  A SIGINT, SIGTERM or SIGHUP is forwarded as received; the supervisor gets SIGKILL if it has not exited within the bound. The launcher never signals the agent's pid; it reads the identity captured before the release.

- **A signal removes a worktree this launch created only after the stop check; a pre-existing worktree is untouched.**

  A survivor keeps the worktree.

- **`tps agent start` sweeps pending launch snapshots, never attestation directories; the mailbox lock, outbox lock and `tps status` share one pid check (#677, #681).**

  A forced kill while a launch snapshot is pending can leave a
  `.pending-config-*` directory under `~/.tps/launch`. The next launch attempts
  to remove one whose owner record names a dead launcher, by the same pid and
  start-token rule as published snapshots, or that has no readable owner record
  and a directory mtime at least 24 hours old; a removal that fails is logged
  and the directory is kept. One whose recorded launcher is still running is
  kept.

  The sweep selects only entries named `config-` or `.pending-config-` followed
  by exactly six letters or digits, so a launch's attestation directory in the
  same place, named after its agent id, is never selected, including for an
  agent whose id is `config` or starts with `config-`.

  The `@tpsdev-ai/agent` mailbox lock, the cli's outbox lock and `tps status`
  check a recorded pid with one rule: a pid that is not an integer from 1 to
  2147483647 is never treated as a live process, and one whose probe is refused
  with `EPERM` (permission denied) is. `tps status` reported a pid refused with
  `EPERM` as a zombie, and did not check a recorded pid of 0.

- **A launch's worktree cleanup now passes Git a pinned pathname.** Setup cleanup and record retries check ownership in `verifiedCreatedWorktree`; bound `onStop` checks it separately, and path-only `onStop` checks the base's worktree registry without an ownership marker. Marker-mismatch refusals include a manual command when registration is present and readable. A change at the pinned path during removal is not covered (cli#706), and a directory left at the pinned path after Git succeeds is reported, not deleted.

- **A selected runtime uses `repo` when `workspace` is absent.** `tps agent start --runtime codex|gemini|claude-code` resolves its workspace from `workspace`, then `repo`, then its default (Closes #679).

- **A selected runtime expands `${NAME}` references in `workspace` and `repo`.** An interactive `tps agent start --runtime codex|gemini|claude-code --no-sandbox` expands those two keys with the native loader's rule, and an unset variable fails the start with the loader's `Missing environment variable` error; other keys are read as before (Closes #680).

- **`pidState` now backs the remaining CLI pid probes (Closes #683).**

  `tps agent list`, `tps agent status`, `tps agent healthcheck`, the branch
  daemon status and stop wait, connection state, the mail bridge, the LLM proxy,
  the mail relay and the launch attestation use the one rule. The mail relay
  keeps a pid file naming a process this user cannot signal (EPERM) and reports
  it running; an invalid pid is handled as a missing process. `tps branch stop`
  signalling is handled in #702.

- **A relay acceptance receipt is classified and parsed from its own properties only.** A digest receipt needs both digest fields as own properties; a receipt with neither takes the legacy body-digest path, and an invalid digest receipt does not match.

- **Removal advice naming an absent worktree path is dropped.**

  On a signal, an unconfirmed removal keeps the launch state, names what remains (the original path, the moved-aside path or the registration), and exits with the refusal code (78, or the supervised refusal code when supervised).

- **The Office Manager trims surrounding whitespace from a curl `url` in the workspace manifest.** Whitespace around the URL, including non-ASCII whitespace such as U+00A0 and U+3000, is removed before the URL is checked, and curl and the `[curl]` log lines get the URL without it; a URL that is still invalid after trimming is refused with `Invalid URL` (Closes #687).

- **The review launcher reads a worktree's `.git` entry to classify unreachable metadata.**

- **`tps branch stop` keeps the pid file and fails when the signal is refused with EPERM (Closes #702).**

  A process this user may not signal is alive; the stop classifies the refusal
  with the shared `pidState` classifier and reports the pid instead of removing
  its pid file and saying the daemon is not running. A process the same
  classifier reports gone still has its stale pid file removed.

- **A mail lock whose owner exited but was not reaped can be reclaimed on Linux.**

- **Launch worktree removal records the pinned path and leaves a locked worktree alone.** A launch now refuses an absent registered workspace instead of treating it as existing. With a removal record the refusal names the pinned tree and how to move it back or delete it and prune the registration; without a record it points at `git -C <base> worktree prune` and a relaunch.

- **`bridge stop` stops a bridge started through a discovered adapter name.** It finds `bridge-<adapter>.pid` records whose adapter part is lowercase ASCII letters, plus the legacy `mail-bridge.pid`, instead of only `bridge-openclaw.pid` and `mail-bridge.pid`. A missing run directory has no records; any other error reading it is reported with the path and error code and fails the command. A record that does not exit keeps its pid file and the remaining records are still handled. The shared pid reader opens with the available nonblocking and no-follow flags, checks the descriptor is a regular file, and reads that descriptor. Non-regular files and final-component symlinks refused by the no-follow flag are classified without being read.

- **`tps branch stop` checks the recorded token immediately before signalling.**
  `ps` tokens have one-second precision; PID reuse between the check and signal
  remains possible. Unverified live records are refused; stale and invalid
  records are removed if unlink succeeds. Missing, stale and invalid records leave daemon state unknown.

- **The OpenClaw mail plugin handles an error from its inbox watcher (#720).** An `error` event on the `new/` watcher used to go unhandled; it is now logged as a `tps-mail: new/ watcher for <agent> stopped` warning, and mail in that inbox is still picked up by the periodic rescan.

- **`tps mail relay status`, `tps mail relay stop` and `tps bridge status` (human output) describe bad or unverifiable pid files instead of reporting "not running".**

  An invalid, stale, unverified or unreadable pid file is no longer reported
  as the relay or bridge not running. `tps mail relay status` names the record
  and reports the relay's state as unknown or unverified. `tps bridge status` (human output,
  when no bridge record is running) prints
  `Bridge state unknown (<kind> pid file <path>).` for each such record.
  `tps mail relay stop` names an
  invalid or stale record, signals no process for it, removes it when the
  unlink succeeds, and leaves the relay's state unknown. When a signalled
  relay's recorded pid is proved gone, stop now prints a line beginning
  `Recorded relay process (pid N) is gone (`.

- **`BridgeCore` enforces the `[a-z]+` adapter-name grammar shared with `bridgePidFiles`, refusing invalid names before writing state (Closes #725).**

- **`tps branch start` refuses to spawn while the recorded process is running (pid + start token match) (Closes #726).** Unverified, unreadable and invalid records also refuse spawning; stale records are replaced on a successful launch. A daemon removes the pid file on shutdown only when a fresh read matches its own pid and start token.

- **Branch pid records are claimed and removed under one inter-process lock (Closes #730).** When launching a detached daemon, `tps branch init` and `tps branch start` read, classify, spawn and write the record while holding it; `tps branch stop`, daemon shutdown, stale-record replacement and `tps office kill`'s branch-record handling use the same lock. A command that cannot acquire the lock within its timeout refuses, naming the lock path. At a final read the file's bytes are compared byte-for-byte with the bytes read earlier: a replacement is preserved, an unreadable file or symlink is kept and the removal is refused, and a missing record is reported.

- **A daemon-launching `tps branch start` checks the recorded process before resolving the branch agent id (Closes #734).** A daemon-launching `tps branch init` checks the recorded process after its join and conf-presence guards and before the keypair, before writing the conf and before the join; init resolves no agent id (unchanged).

- **Breaking: commands that set a failure exit code now exit non-zero.** The entry point
  exits with the status the command set instead of replacing it with 0, so a
  failure path that sets `process.exitCode` reaches the caller.

  **Upgrade:** scripts that ignored these failures (the entry point exited 0) will now see the non-zero status and must handle it.

- **`tps office kill` prints each collected failure once.** It still exits
  non-zero, but no longer repeats the same failure in a second aggregate line.

- **`tps office kill` and the host connection writer share one lock per host state record.** `office kill`
  holds it across its final read and removal; `writeHostState` takes it for each write.
  The connector's `stop()` removes a valid record under that lock only for the same branch,
  the same PID, and the same start token when one is present. Writes after `stop()` begins are suppressed under the lock; a late connection skips writing.
  Blocking callers use a 5 s deadline plus the probes' own timeouts; a timeout names the lock
  path and a removal remedy. `office kill` collects host-record lock failures and continues shutdown before
  exiting non-zero. If an attempt fails after a channel is assigned, the relay attempts to close it before retry.
  A close that rejects is reported and retained for `stop()`. If a close still rejects at `stop()`, the record
  is kept and `stop()` rejects with its path. Stalled closes are not detected: the transports resolve after
  their own timeout (cli#774). Inbound host-record updates coalesce on a timer and retry failed zero-wait writes
  with capped backoff. Stop and disconnect cancel pending updates. Failures report the record path.
  Lock release is best effort: lock-directory removal errors are ignored, and the next
  acquirer reclaims a remaining lock only if its owner is provably dead. `stop()` keeps records classified as unreadable or invalid
  by the locked read and reports their path, instructing the operator to inspect the record and remove it if no connector
  for that host is running. Other removal failures except a missing file are rethrown.
  `tps office connect` awaits `stop()` on SIGINT and SIGTERM and exits 1 if it rejects, reporting the failed disconnect;
  `office kill` sends SIGTERM and attempts record removal after confirming exit.

- **Heartbeat and office join exit statuses.** `tps heartbeat` exits 1 for workspace write failures or failed gateway RPC
  probes, and `tps office join --tunnel-via` exits 1 when Flair spoke or
  supervision provisioning fails. A guard test checks approved AST contexts
  for no-argument and explicit-zero direct `process.exit(...)` calls.

- **`tps office connect` runs its checked shutdown on SIGTERM as well as SIGINT (#762).**

  `tps office kill` stops the connector with SIGTERM, so the relay now stops and
  the host connection record is cleared under the record lock. A failed clear
  prints `Disconnect failed: ...` and exits non-zero; a second signal while the
  shutdown runs starts no second shutdown.

- **`tps branch init` prints the join token only after the listener binds.** On a bind failure it names the port and exits non-zero without a token.

  On both the `ws` and `tcp` transports, a failure to bind (for example, the
  port is already in use) reports the address and exits non-zero; it prints no
  token for a listener that was never running.

- **The Codex runtime shares a bounded loop-stop drain between signal shutdown
  and rejection cleanup.** Stopped loops discard late reads. Mail awaiting dispatch at shutdown stays unacknowledged.

- **Rejected relay disconnect closes are reported; `stop()` retries retained channels.** A rejected close retains the channel; a successful retry in `stop()` removes it and can clear the host record, and a retry that rejects keeps the record and throws `HostChannelCloseError`. Connect-time host-record write failures are reported before reconnecting.

- **`agent set-runtime` reports when the config changed after its replacement was written and no rollback was attempted (Refs #795).**

- **The codex runtime's mail-task auto-commit keeps the pre-task baseline across a stale-rebase abort and resolves `autoCommit.repo` against the config file's directory.**

  The runtime resolves `autoCommit.repo ?? workspace` once and runs the mail auto-commit gate's Git
  probes and the rebase abort there. An interrupted rebase is detected with
  `git rev-parse --path-format=absolute --git-path`; a failed probe skips
  auto-commit and reports it. A successful abort keeps the pre-task baseline, so
  a restored HEAD different from the pre-task HEAD causes a commit attempt (for
  example a commit made on that branch before the rebase). A final HEAD
  different from the restored one skips as indeterminate. The clean message
  states that Git status is clean and HEAD matches its pre-task value. A
  relative `autoCommit.repo` resolves against the original config file's
  directory, with the same environment-variable expansion as `workspace`, and
  the launch snapshot carries the absolute value; a relative value with no
  config file to anchor it is refused. Sender notices are attempts: a failed
  signed send is logged and acknowledgement is attempted.

  **`autoCommit.repo` is resolved only by the Codex runtime.** A Gemini or Claude Code launch neither resolves nor expands it, so an unset variable there cannot stop the launch; an empty YAML entry reads as absent, and the runtime's workspace fallback applies.
  **An empty or blank `autoCommit.repo` string is refused.** After environment expansion, a blank value names the field and the remedy: omit it to use the workspace, or give a path.
  **A rebase-path probe that does not return an absolute path is indeterminate.** A Git that does not support `--path-format` echoes the flag; auto-commit skips and reports the probe and its output.
  **An empty final `git rev-parse HEAD` read is indeterminate.** The gate skips and reports the probe instead of reading the empty value as a change.

- **Host and branch connection state writes are atomic, and a branch state write failure is logged best-effort without stopping message handling (Closes #808).**

  A write or rename failure leaves the previous record intact, and the
  temporary file is synced before the rename. The parent directory sync after
  the rename is best-effort. The logger attempts to append a branch state
  write failure report to the branch log. Failed appends are counted; the count
  appears on the next successful append by the same running daemon and is lost
  if the daemon exits or restarts. Nothing is written to stderr, and handling
  continues.

- **The auto-commit helper refuses when its working-tree status probe fails.** A non-zero exit, spawn error or signal from `git status --porcelain` throws without committing or pushing, after attempting to publish a blocker event for the task; the error names the repository, the probe and its failure, with stderr's control characters (U+0000-U+001F, U+007F-U+009F) replaced by spaces and stderr capped at 300 characters (cli#824).

- **A subsequent connection-state record write or host-record listing attempts to remove temp files left by a crash that are older than the age threshold.**

- **Rewriting a connection-state record keeps the observed permission bits (0o777), so a record tightened to 0600 stays 0600.**

- **A sandboxed Codex launch refuses an `autoCommit.repo` outside the launch-option
  paths checked** (workdir, cwd, `--allow` directories and exact `--allow-file`
  files). Profile-only `filesystem.allow` / `filesystem.write` grants are not
  consulted. The refusal names the repository, the launch-option paths checked
  and the remedy (put the repository under the workspace, or run that agent
  without the sandbox).

- **Mail-task auto-commit handles an unborn HEAD.** The mail auto-commit gate leaves a clean unborn HEAD alone and skips after an indeterminate HEAD probe or failed stale rebase abort.

- **The reviewer sandbox image retries transient download failures.** Each of its four downloads (node, bun, gh, js-yaml) retries a failed or partial transfer up to five times with a bounded timeout; the checksum check after each download is unchanged.

- **Recover missed OpenClaw mail watch events**: Periodically rescan bound inboxes and log mail promoted by the rescan.

- **Sandboxed Codex launch:** a launch that reaches the autoCommit repository check refuses a present non-string, non-null `autoCommit.repo` before `nono run`, naming the field, original config file, and type, with the launch's applicable refusal exit status. Earlier launch failures keep their own messages; a config-load error, including an unset variable inside that value, stops with the loader's error before `nono run`.

- **OpenAI token refresh saves updated credentials to the TPS provider store.** Reader and sync share Codex file selection. A failed write warns for that target without trying a later file; when selection fails, sync warns if a candidate exists. Refresh rejects missing or non-string access tokens, present non-string refresh tokens, and non-finite or negative expiry durations before saving. Credential saves use an exclusive 0600 temporary file, fsync it, rename it, and attempt a best-effort parent-directory fsync that never fails the write.

- **An unreadable lock owner with a changed sampled identity causes a retry.** A live owner in another process on that retry reports `duplicate in progress`. A live owner in the same process still raises `MailLockOwnerError`, which the webhook returns as a 503 naming the lock path, and a stable unreadable owner still fails closed with its named lock path (Closes #863).

- **Retry retained OpenClaw mail**: Retry failed promotions that leave their source in new/, with a per-source-identity failure limit and a diagnostic when exhausted.

- **Skip mailbox dot-files.** Use a shared filename predicate for `new/` consumers.

- **Relay stop waits for an in-flight connect and retries a late-connect close that rejects; an unconfirmed close throws `HostChannelCloseError` and keeps the host record.**

- **Cache the verified Socket Firewall binary so a cached CI job does not depend on the download host (Refs #898).**

  Jobs attempt to restore the verified binary with actions/cache before the
  pre-fetch and use it only when the checksum tool found on the job's PATH
  reports the pinned sha256; a cold cache downloads with a bounded exponential
  backoff. A binary whose checksum does not match is discarded.

- **Breaking: refuse a value-less `--agent` in `mail ack`/`nack`/`gc`:** an `--agent` with no value is refused, so it does not fall back to the default agent; `ack`/`nack` also refuse a trailing positional agent and honour `--agent=<id>`, `gc` refuses a positional agent, and the `ack` and `nack` usage lines and both mail help texts name `--agent <id>` instead of a positional `[agent]`.

  **Upgrade:** pass the agent as `--agent <id>`; a trailing positional agent on `ack` or `nack`, which the parser never read, and a positional agent on `gc` are now refused.

- **Breaking: one flag reader for the CLI subcommand blocks:** `agent`, `mail`, `memory`, `bridge` and `skill` now share one `--flag` reader that stops at the first `--` after the subcommand (a `--` before it is passed), accepts `--name value` and `--name=value`, and refuses a repeated flag with a usage error naming it; a conflicting repeat that meow rejects is reported as a usage error instead of an uncaught stack. `tps agent run --message` is still read directly and takes only the `--name value` form.

  **Upgrade:** a command line that repeats a flag the shared reader handles is refused; pass each flag once.

  `tps flair sync` does not use this reader: give its interval as `--interval <seconds>`, because `--interval=<seconds>` is not recognised as a request for a daemon and runs one sync.

- **The branch relay leaves a young unparseable outbox file in place and retries the send pass after 5 seconds instead of quarantining it.** A file that still does not parse once it is at least 5 seconds old is quarantined, and the log line names its age in milliseconds.

- **A stopped inbox watcher is re-armed from the rescan tick.** After a watcher error, the next rescan tick creates a new watcher; repeated failures back off by 1, 2, 4 … ticks (capped). New mail is watched again as soon as the watcher re-arms, and the stopped, re-armed and still-failing states are logged without a line for every tick a failing re-arm skips.

- **`tps mail relay stop` re-reads the pid record before signalling; `tps office status` classifies the relay record instead of checking that its pid file exists.** Stop signals only a record that is still `running` with the same pid and start token; a re-read that still names a running relay under a different pid, or the same pid with a changed start token, exits non-zero with no process signalled. `tps office status <agent>` reports `running` only for a running relay record; in text output a stale, unverified, invalid or unreadable record is named, while `--json` reports `relay-unknown` for it (unless a sandbox container reports its own state) and does not name the kind.

- **`tps mail relay stop` compares a relay pid record's bytes before removing it.** The stop reads the record once immediately before signalling, signals only when it still names the same pid and start token, and compares the record's bytes with that read before it unlinks the path. It applies the same compare before removing a stale or invalid record. A record a new relay wrote is kept. A kept record (bytes differ) whose start token matches a different live process is named as belonging to that process; any other kept readable record is reported as no longer holding the record this stop read. A stale or invalid record replaced before removal is kept and the stop exits 0, as it does when the relay it targeted did stop. Relay pid records are written without a lock, so a record written between the compare and the unlink can still be removed. A record that cannot be read at the final check is kept and the stop exits non-zero.

- **`agent set-runtime` keeps the config's permission bits and group.** The
  replacement file no longer copies setuid, setgid or sticky bits, and it keeps
  the original group and owner where the process may. Group-only retry is limited
  to EPERM/EACCES; any other ownership error, a failed retry or a chmod failure
  refuses the write, leaving the original config in place.
  Before `--`, `agent create --runtime` with no value is refused, naming the
  accepted values.

- **The branch daemon installs its SIGTERM and SIGINT handlers before it starts listening (Refs #744).**
  A stop signal sent as soon as the port opens now runs the daemon's shutdown
  path instead of the runtime's default handler.

- **Bridge outbound replies carry the constructed adapter name, and an adapter-name refusal escapes every character outside printable ASCII.**

- **`tps mail check` says why a message is re-delivered.**

  A `cur/` record that is re-verified and re-presented after its 30-minute
  checkout lease expired is marked as re-delivered. For ackable mail it prints
  `tps mail ack <id> --agent <agent>`; for external-tier mail it says
  that `tps mail ack` and `tps mail nack` refuse it. `--json` carries the `redelivered` field.

- **MailClient resolves its mail root and mailbox directory to canonical path strings once per operation, then derives subsequent paths without resolving again.**

  The mailbox lock, the maildir paths and the replay state derive from the
  canonical mailbox string. Bridge-principal trust, the relay acceptance
  stripe paths for promotion and dead-lettering, and the recipient inboxes
  that `deliverOutbox()` moves records into derive from the canonical mail-root string.
  No resolved canonical root is cached at construction. When the symlink at the
  configured mail path, or at the agent's mailbox directory, is repointed while
  a client is alive, the new target is selected at the start of the next operation. A
  plain rename of the configured directory is not followed: the next operation
  creates the configured path again and uses that, not the renamed directory.
  The relay stripe is a cooperative lock among MailClients that resolve the same
  canonical path. The OS follows same-user filesystem changes to that path during
  an operation; the stripe does not exclude them.

- **`office connect` attempts announcements for recovered relayed deliveries.**
  On a resend, a matching record still in the mailbox outside the dead-letter
  queue is due an announcement if acceptance receipt recovery and sync succeed.
  The callback is attempted unless a matching, unexpired announcement marker's
  file and directory sync successfully. The ACK follows a successful marker check or
  a completed callback and successful marker write and sync. Callback errors,
  or a marker that cannot be written and synced, withhold that attempt's ACK.
  A resend that still finds the record and recovers its receipt attempts the
  callback again unless an announcement marker counts. Cleanup attempts removal
  of the temp file or renamed marker; the retained-marker sync check is the
  fallback. A marker counts only
  for the payload it records, and only once syncing its file and directory
  succeeds. A resend of the same payload whose
  marker counts is not announced again, but a crash between the announcement
  and its marker, a marker failure, a marker older than the acceptance receipt
  TTL (7 days by default), or two acceptances of the same delivery at once can
  announce it again.

- **`tps office kill` checks each record's start token immediately before signalling it.** Host
  state records written by the relay carry the process start token when it is available, and the
  branch pid file is read at the path its writer uses. A record classified as unverified is not
  signalled: it is kept and named, and the command exits non-zero. A pid reused
  after the check and before the signal is not detected, and the `ps` fallback token has one-second
  precision.

- **office kill re-lists host records after each signalling pass and again after the branch step, within a bounded number of passes.** A record first seen at a pass limit is named, not stopped in that pass; a new record path created after the last listing is not seen. A listing failure or an unprocessed record at either bound makes the command exit non-zero.

- **`tps office kill` treats a Linux zombie as stopped.** A process that has exited but whose parent has not
  reaped it still answers `kill(pid, 0)`; `office kill` now reads `/proc/<pid>/stat` and attempts to remove the record
  instead of reporting a failed stop.

- **Outbox queueing no longer fails when a concurrent drain moves a record.** The existence check reads the record once instead of checking and then reading it; a record moved from `new/` to `sent/` is found in `sent/` and reported as a duplicate.

- **Relay and bridge pid files carry a start token; a stop checks it immediately before signalling and refuses a mismatch.** A pid can still be reused between that check and the signal, and the `ps` fallback compares start time only to the second. `bridge stop` re-reads each record immediately before its own signal. The writer reads the token through the agent API, which may return null or a `ps`-derived token. A stale record is removed; a record whose identity cannot be confirmed is refused with the pid file named, and an EPERM from the stop signal keeps the file and exits non-zero. `bridge stop` classifies both known pid files before acting, handles each record independently, prints every record's outcome, reports a pid file it cannot remove as kept with the error code, and exits non-zero when a stop fails or a record is kept without a verified stop.

- **A relay connection bounds the channels it retains after a failed close, and reports the first host-record refresh failure.** At most four failed channels are kept for `stop()` to close, so a persistent close failure does not make shutdown wait on one close per reconnect. The heartbeat and health callbacks name the record path and the error on their first persist failure per connection and stay silent until a write succeeds.

- **Renovate's setup-action runtime rule matches by dependency name.** The github-actions `uses-with` rule now matches `depName`, so setup-node's `node` dependency (package `actions/node-versions`) is skipped.

- **Renovate no longer proposes several update categories that the reviewer gates refuse.** It skips `engines`, peer-dependency and OpenClaw updates, and bun and node runtime-version updates through the `npm`, `bun` and `github-actions` managers; Docker node image updates stay enabled. The `dependencies` of the published packages under `packages/` keep their ranges (`widen`). The reviewer action allowlist accepts actions/checkout v4.4.0 at its release commit.

- **`agent set-runtime` orders ownership before mode, verifies the temporary file before the rename, and warns after the rename when the owner could not be preserved.**

  `agent create` validates `--runtime` before refusing an existing config, so
  an invalid value gets the accepted-values refusal either way.

### Security

- **`tps mail watch --exec` presents only mail that verifies, without consuming it (Closes #375).** The watcher verifies each record in `new/` IN PLACE — the same signature and envelope-binding checks `promote()` applies (the wrapper sender against the signed sender, and the signed recipient against the mailbox), factored into a shared function that moves, leases and writes nothing — and passes only the records that verify to `onMessage` and the `--exec` hook. It calls no consumer path (`promote`, `checkMessages`, a lease or an ack) and never moves a record out of `new/`. A record that does not verify is skipped and logged, never presented. The verified body is written to the hook as UTF-8, and the four `TPS_MAIL_*` variables the watcher sets for the hook come from verified fields (the verified envelope id as `TPS_MAIL_ID`, plus `TPS_MAIL_FROM`/`TPS_MAIL_TO`/`TPS_MAIL_TIMESTAMP`). A verified record whose envelope id the watcher's lookup finds in the consumed ledger is skipped and logged; when the consumed history cannot be read, the error is logged, the file is left untouched, and the record is retried on the next scan if the file remains. `promote()` and the watcher refuse an envelope whose signed `body` is not a string.

- **Check selected-runtime sandbox grants (Closes #483).**

- **The tracked-lock installer now uses the release-age gate's registry and refuses configuration that could redirect it.** Before npm runs it refuses an `.npmrc` in the install directory, an `npm_config_*` variable or an unprefixed proxy variable that could change the fetch, `NODE_EXTRA_CA_CERTS`, `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, and a lock entry whose `resolved` URL is missing or outside that registry or whose `integrity` is missing or not sha512.

- **The release npm upgrade uses an exact pin** CI checks its publish age against `bunfig.toml`; the release job repeats the check before upgrading.

- **handlebars resolves to 4.7.10.** It is the first release patched for GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f and GHSA-xw65-4hp5-5hc7. Both manifests declare `^4.7.10`, which keeps that floor; 4.7.10 is now older than 7 days, so handlebars is no longer excluded from the install-time release-age window.

- **The `shell-quote` override now resolves 1.11.0, outside the range of GHSA-pqg4-j6r4-53mv.** cli does not import `shell-quote`; it reaches the install only through `react-devtools-core`. `bun audit` reports no vulnerabilities.

- **The CLI workspace now depends on zod 4.6.7, outside the range of GHSA-mrhx-c7xc-m3w5.** Report defaults, ids, timestamps, records and `Expected string, received …` error text keep their zod 3 behaviour. Three differences are deliberate: `.int()` now requires a safe integer, so a value beyond `Number.MAX_SAFE_INTEGER` may not be the integer that was sent (adjacent integers can collapse to one double); `z.number()` now refuses `Infinity`; and an empty `identity.default_name` reports zod 4's length message (`Too small: expected string to have >=1 characters`) rather than zod 3's.

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
