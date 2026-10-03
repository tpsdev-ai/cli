Closes #380.
Closes #487.

For CLI signed-inbox delivery, promote() is the only first-delivery writer of cur/. Updates touch only existing records. MailClient and CLI promotion share the envelope policy and locked consumed-ID replay store; CLI promotion additionally rejects an invalid signed non-bridge trust value, which MailClient instead maps to external. Outbox and internal mail are separate stores.

## What changed

- **The deploy bot (both copies) and the channel bridge promote instead of renaming.** Failed verification refuses delivery and attempts dead-lettering. The bridge's parse-failure path no longer moves an unparseable record into `cur/`.
- **Bridge acknowledgement uses the promoted path.** The bridge attempts to persist a sent marker after adapter.send succeeds; recovery skips sent or acknowledged records. Reported send failures leave no marker and are retried on restart. Ack atomically updates existing records. Ack or cleanup failure preserves the sent marker. A crash or marker-write failure after successful send can permit a duplicate.
- **Both retry eligible `dlq/` entries.** The bridge also retries `new/` on its timer and serializes mailbox work.
- **One mailbox policy for `promote()`, `MailClient`, and topic catch-up.** The signature/sender/recipient/id-shape/timestamp decision, envelope parser, and topic-recipient rules live in `packages/agent/src/lib/mailbox-policy.ts`. The CLI and `MailClient` use its consumed-id replay store under the shared mailbox lock; topic catch-up retains its cursor when verification or recipient policy is unavailable.
- **`MailClient` throws when constructed without a verifier.** The parameter is still optional in TypeScript; the refusal is at runtime. `AgentRuntime` constructs a verifier using `config.flair?.url`, `FLAIR_URL`, then `http://127.0.0.1:9926`.
- **Updates use `updateExistingRecord()`.** It locks, re-reads, mutates and atomically replaces an existing record; lease checkout revalidates its verified snapshot. The writer scan allows promotion, the locked existing-only helper, `MailClient`, the container outbox/cur archive (`relay.ts`) and the office internal-mail store (`internal-mail.ts`); unrecognized destinations may be missed. The delegation check covers `checkMessages`, `setBridgeSentAtPath`, `ackMessageAtPath`, `nackMessage` and `patchMailFile`.
- **Follow-ups:** #482 same-filename promotion overwrite; the per-process bridge queue.

- **Registry verification accepts hex and canonical base64 public keys; the agent provider accepts raw private seeds.** Non-404 registry read failures are retryable.
- **Lock acquisition and stale reclamation share an atomic claim.** A stranded claim requires operator recovery; polling re-reads birth tokens.
- **Unrecoverable consumed history withholds delivery.** Appends preserve a line boundary; initialized ledger loss refuses delivery; CLI cur recovery requires a ledger ID.
- **The scan uses the filesystem destination position before options or callbacks.** The forged deploy-bot fixture includes an ID.
- **The delivery-control test checks its build prerequisites.** Missing agent entry points report `packages/agent/dist missing — run bun run build`; the root test script is unchanged.

## Evidence

### Touched tests, measured on b5527966

| File | Fixture | Pass | Fail |
|---|---|---|---|
| `test/mail-cur-writers.test.ts` | native | 8 | 0 |
| `packages/cli/test/mail-final-controls.test.ts` | native | 14 | 0 |
| `packages/agent/test/mail-promote-guard.test.ts` | in-process HTTP | 20 | 0 |
| `packages/cli/test/bridge-mail-promote.test.ts` | in-process HTTP and polling watcher | 3 | 0 |

Native bind/watch integration remains unverified.

### Measured on 9d86f15f versus origin/main 3df27695

Isolated launchers, canonical paths, empty launcher HOME; per-file runs with a 90-second deadline. Plugin dependencies came from the existing offline installation; both trees were built.

| Suite | 9d86f15f pass/fail | origin/main 3df27695 pass/fail | Timeouts (head/main) |
|---|---|---|---|
| agent | 134/0 | 120/0 | 0/0 |
| cli | 1507/16 | 1496/16 | 0/0 |
| pi-tps-mail | 0/0 | 0/0 | 0/0 |
| root-test | 135/2 | 123/2 | 0/0 |
| plugin | 208/0 | 205/0 | 1/1 |
| github-review | 195/6 | 218/6 | 0/0 |
| Whole socket-free lane, observed cases | 2179/24 | 2162/24 | 1/1 |

Counts combine completed cases and successful reruns without double-counting. Both trees skip the same three pi-tps-mail cases and have identical failing test names.

The updated cur-writers test passes 10/0 on 9d86f15f. Applied as a test fixture to origin/main 3df27695 sources (which have no native cur-writers test), it reports 6/4 and detects the original deploy-bot and bridge bypasses.

Timed-out file on both trees:

```text
plugins/openclaw-tps-mail/test/locality.test.ts
```

Failed test names on both trees:

```text
4e positive — real nono (Landlock/Seatbelt): the premise > nono denies a path outside every grant while the granted twin is readable
4e positive — the attested launch against the pinned nono > tps agent start is RELEASED: real nono, canaries verified, session bound to the spawned pid
4e — the private dir is removed on every path > createPrivateLaunchDir + removePrivateLaunchDir leave nothing behind
4e+r4f positive — a TTY parent still RELEASES (real nono) > script(1) gives the launch a PTY; real nono keeps it and the child attests anyway
4g — the launch socket path is bounded to sun_path > a 64-char id under a long HOME still yields a within-limit socket path
4g — the launch socket path is bounded to sun_path > a HOME too long for even the shortened label refuses LOUDLY, naming the length
A1 — independent plugin loading > the built entry loads under node
E — the gateway-boundary lane (OpenClaw loader + gateway tool dispatch, in a separate node process) > from the lane's manifest OVERLAY: the probe runs in the gateway process, reads the host-only marker, sees a sandboxed session; a concurrent pair posts ONCE
E — the gateway-boundary lane (OpenClaw loader + gateway tool dispatch, in a separate node process) > the SHIPPED manifest REJECTS the CI probe even with the CI flag set
E — the gateway-boundary lane (OpenClaw loader + gateway tool dispatch, in a separate node process) > the SHIPPED manifest: zero diagnostics, default sandbox policy withholds the verb, the documented allow offers it, and it POSTS with the audit acknowledged
T5 — the pinned-path launch spawns nono and the child argv asserts the flags > agent start --sandbox-required with a fake nono at NONO_BIN: the run argv carries both flags
changelog fragments — two PRs with distinct fragment filenames (cli#449) > B merged into A, and A's original commit merged into B: both clean, both fragments present
get > runs verify and returns live value
latch-admin reconcile — decisions, records, application > the BUILT command runs under node: list, and clear refusing a posted latch
runCommandUnderNono() > warns and falls back when nono not on PATH (non-strict)
runVerify — nonzero exit > false command returns nonzero_exit
tps agent commit > creates a branch and commits only the requested paths
tps agent commit > pushes the branch and opens a PR via gh-as
type coercion > string coercion — rejects empty
```

Loopback-bind exclusions (socket-free cases retained where possible; launch-attestation requires Unix sockets). Loopback binds were refused.

```text
packages/agent/test/flair-context.test.ts
packages/agent/test/mail-promote-guard.test.ts
packages/cli/test/branch-join.test.ts
packages/cli/test/bridge-mail-promote.test.ts
packages/cli/test/codex-presence-444.test.ts
packages/cli/test/flair-sync.test.ts
packages/cli/test/launch-attestation.test.ts
packages/cli/test/mail-bridge.test.ts
packages/cli/test/mail-producers-sign.test.ts
packages/cli/test/mail-promote.test.ts
packages/cli/test/mail-receipt-thread.test.ts
packages/cli/test/mail-remote.test.ts
packages/cli/test/mail-send-routes.test.ts
packages/cli/test/mail-send-stdin-reply.test.ts
packages/cli/test/mail-unresolvable-principal.test.ts
packages/cli/test/mail-watch.test.ts
packages/cli/test/mail.test.ts
packages/cli/test/mock-llm.test.ts
packages/cli/test/noise-ik-transport.test.ts
packages/cli/test/plain-tcp-transport.test.ts
packages/cli/test/runtime-mail-lifecycle.test.ts
packages/cli/test/service-proxy.test.ts
packages/cli/test/wire-mail.test.ts
packages/cli/test/ws-noise-transport.test.ts
packages/pi-tps-mail/test/reply-send.test.ts
test/deploy-bot-promote.test.ts
```

### Measured on bbd6d313 versus origin/main 42de3b4b

Isolated per-file launchers; both trees built with offline plugin dependencies. Counts replace timing-failure runs with matching reruns.

| Suite | bbd6d313 pass/fail | origin/main 42de3b4b pass/fail |
|---|---|---|
| agent | 135/0 | 121/0 |
| cli | 1621/13 | 1854/16 |
| pi-tps-mail | 20/0 | 20/0 |
| root-test | 135/1 | 123/1 |
| plugin | 212/0 | 209/0 |
| github-review | 221/2 | 221/2 |
| Whole socket-free lane | 2344/16 | 2548/19 |

Shared files have the same failing test names; `runtime-attested-launch.test.ts` exists only on origin/main and adds three failures there. No final runs timed out.

Bridge/mail/cur checks present in each tree: bbd6d313 72/3; origin/main 42de3b4b 34/3, with the same failures in the shared tests. `bridge-ack-path.test.ts` reports 11/0 on bbd6d313 and 2/9 on 32104f71; the requested regressions fail on 32104f71.

### Measured on 056338b4 versus origin/main 42de3b4b

| Suite | 056338b4 pass/fail | origin/main 42de3b4b pass/fail |
|---|---|---|
| agent | 134/0 | 120/0 |
| cli | 1613/22 | 1838/25 |
| pi-tps-mail | 20/0 | 20/0 |
| root-test | 135/1 | 123/1 |
| plugin | 212/0 | 209/0 |
| github-review | 221/2 | 221/2 |
| Whole socket-free lane | 2335/25 | 2531/28 |
| Bridge/mail/cur target files | 47/0 | 4/0 |


### Measured on a8f1fd1a versus origin/main 42de3b4b

| Suite | a8f1fd1a pass/fail | origin/main 42de3b4b pass/fail |
|---|---|---|
| agent | 135/0 | 121/0 |
| cli | 1629/19 | 1852/23 |
| pi-tps-mail | 20/0 | 20/0 |
| root-test | 135/1 | 123/1 |
| plugin | 197/2 | 194/2 |
| github-review | 216/7 | 216/7 |
| Whole socket-free lane | 2332/29 | 2526/33 |
| Bridge/mail/cur target files | 60/0 | — |

### Measured on bb055580 versus origin/main 42de3b4b

| Suite | bb055580 pass/fail | origin/main 42de3b4b pass/fail |
|---|---|---|
| agent | 135/0 | 121/0 |
| cli | 1615/15 | 1822/18 |
| pi-tps-mail | 20/0 | 20/0 |
| root-test | 137/1 | 123/1 |
| plugin | 212/0 | 209/0 |
| github-review | 220/3 | 220/3 |
| Whole socket-free lane | 2339/19 | 2515/22 |
| Bridge/mail/cur | 243/0 | 143/0 |

Shared files have the same failing test names; origin/main-only `runtime-attested-launch.test.ts` adds failures there. Matching sequential reruns replace watcher timing failures. Final runs had no timeouts.

Lease-sweep-vs-ack and nack-vs-ack: bb055580 2/0; a8f1fd1a 0/2. Existing ack-vs-ack: bb055580 1/0.

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * Mail that cannot be verified during a temporary service outage can be retried when verification becomes available.
  * Mail processing validates signed envelopes, recipients, and message IDs before delivery.
  * Deployment bots and bridges can retry eligible dead-lettered mail.
* **Bug Fixes**
  * Invalid, forged, or previously delivered messages are withheld from delivery.
  * Mailbox history and locking safeguards help prevent duplicate delivery during concurrent processing or storage issues.
  * Deployment bots and bridges verify incoming mail before forwarding it.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

Merged main’s #485 strict synchronous outbox lock entry point; mailbox callers retain the shared agent lock.
