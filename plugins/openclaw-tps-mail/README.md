# openclaw-tps-mail

OpenClaw channel plugin that makes **TPS mail** a first-class channel alongside Discord, Telegram, and friends.

Before this plugin: TPS mail delivery to OpenClaw agents was a shell hook that wrapped `openclaw agent --message` externally. That path had a hard ~60-second per-request Gemini timeout and suffered from session accumulation noise, which meant deep analytical tasks (like spec reviews) consistently failed to complete.

After this plugin: TPS mail messages route through openclaw-gateway's native message flow — the same path Discord messages take — with proper turn budgets, session continuity, tool access, and reply routing.

## What it does

- **Inbound.** Watches `~/.tps/mail/<agent>/new/` via `fs.watch` for every agent bound to the `tps-mail` channel. When a new message arrives, parses the TPS mail envelope, constructs a `MsgContext`, and calls `channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher` to run the agent turn through the gateway.
- **Outbound.** When an agent produces a reply, writes the reply into the sender's TPS mail inbox (`~/.tps/mail/<sender>/new/<id>.json`) in the standard TPS mail envelope format.
- **State transitions.** Moves successfully processed files from `new/` to `cur/` with `ackedAt` set. On dispatch failure, moves to `cur/` with `nackedAt` and a reason.
- **Session scoping.** Each (recipient, sender) pair gets its own session: `agent:<recipient>:tps-mail:direct:<sender>`. Conversations accumulate context across multiple mails with the same sender.

## Installation

1. Place this directory at `~/.openclaw/extensions/openclaw-tps-mail/`.
2. Add `openclaw-tps-mail` to `plugins.allow` in `~/.openclaw/openclaw.json`:
   ```json
   "plugins": {
     "allow": ["...", "openclaw-tps-mail"]
   }
   ```
3. Register the channel in the top-level `channels` config:
   ```json
   "channels": {
     "tps-mail": {
       "enabled": true,
       "accounts": {
         "default": {
           "mailDir": "~/.tps/mail"
         }
       }
     }
   }
   ```
4. Add bindings for each agent that should receive TPS mail:
   ```json
   "bindings": [
     { "agentId": "kern", "match": { "channel": "tps-mail", "accountId": "default" } },
     { "agentId": "sherlock", "match": { "channel": "tps-mail", "accountId": "default" } }
   ]
   ```
5. Restart openclaw-gateway (e.g., `openclaw gateway stop && openclaw gateway start`).

## Runtime floor: an exact `NO_REPLY` on an older host (cli#402)

On an OpenClaw host **older than 2026.5.22**, a tps-mail session key
(`agent:<id>:tps-mail:direct:<sender>`) classifies as the "direct" conversation
type, whose silent-reply defaults are policy "disallow" **with rewrite ON**. An
exact `NO_REPLY` final is therefore REWRITTEN into a canned phrase (e.g.
"Nothing to add right now.") **before** `deliver` runs. This plugin's token guard
matches the raw tokens only, so it cannot tell that rewritten phrase from a real
reply — it gets posted and discharges the reply obligation. 2026.5.22 suppresses
an exact `NO_REPLY` natively; 2026.8.1 removed the rewrite.

At startup the plugin WARNs when the **host** OpenClaw (read from the running
gateway's own install, never the plugin's dev dependency) is below 2026.5.22 and
the effective config does not disable the rewrite. The host-side fix:

```json
"surfaces": {
  "tps-mail": { "silentReplyRewrite": { "direct": false } }
}
```

The plugin WARNs and never refuses — a refusal would take mail down on a gateway
that otherwise works. It also WARNs when the host version cannot be determined
rather than staying silent.

**Why `peerDependencies.openclaw` is NOT raised to `>=2026.5.22`.** A peer range
the host does not meet makes npm (v7+, incl. 10.x) fail the install with
`ERESOLVE` when the plugin is installed as a resolved package (registry install
or tarball) — and the hosts we run (openclaw 2026.5.7, 2026.5.3-1) are below that
floor. (A plain directory/`file:` link install skips peer validation, but a
packaged install does not.) Raising the floor would break installing the plugin
on exactly the hosts this warning exists for, so the range stays `>=2026.3.7`
and the runtime WARN carries the floor instead.

## The obligation lifecycle (cli#389 round 8)

Every inbound opens one durable obligation record, and its `state` is the
plugin's truth about what the delivery has done — the turn, the deadline timer
and a RESTART after a crash all read the same record:

- **`pending`** — the obligation exists; no deadline armed yet.
- **`yielded`** — the run ended without a posted final; the deadline is armed.
- **`delivering`** — WRITE-AHEAD: persisted BEFORE the delivery call, so a crash
  mid-delivery is distinguishable from a crash before it.
- **`posted`** — the delivery call RETURNED: the reply has been HANDED TO ITS
  ROUTE — sent over the wire to a remote branch, delivered into a local maildir,
  or queued in the outbox for the branch drain to send later. It is not a claim
  that the peer has received it.
- **`acked`** — terminal: a receipt (or the bridge sandbox record) proves the
  delivery.
- **`unconfirmed`** — terminal: committed, and no evidence arrived by the
  deadline. NOT failed, and the sender is never told it failed.
- **`failed`** — terminal: a definitive non-delivery verdict; failed and nacked.

The transitions: `pending`/`yielded` → `delivering` before the delivery call (if
THAT write fails, nothing was sent — the plugin makes ONE attempt to record the
failure and tell the sender, and does not retry in a loop; if the obligation
store cannot be written EITHER, nothing can be recorded at all, the failure is
logged by name (`obligation-write-failed`) and the obligation resolves on a
later start, once the store can be written); `delivering` → `posted` the moment the call returns; `posted`/`delivering` →
`acked` when the scan finds evidence (the ack is gated on the receipt, never on
the dispatch settling); `delivering`/`posted` → `unconfirmed` at the deadline
with no evidence; and any live state → `failed` on a definitive non-delivery
verdict. A TERMINAL record refuses a late `delivering` (`late-final-refused`,
logged by name): a final that arrives after the obligation CLOSED is not
delivered. The obligation can close as `acked`, `failed` or `unconfirmed`, and
`unconfirmed` tells the sender nothing at all — the reason is that the
obligation is closed, never that the sender was told it failed. Arming a
deadline never downgrades a committed record: `delivering` and `posted` keep
their state and only gain `deadlineAt`.

ONE verb settles an obligation (`settleObligation` in `src/index.ts`) and it is
the only writer of `failed` or `nackedAt` — and the only sender of the nack mail:
every path hands its verdict to that ONE nack path, so the same verdict reaches
the sender whichever path found it, and with no working route the nack stays owed
until one exists. That nack is
carried on the RECORD and is **at-least-once, never exactly-once**: the write
that sets `failed` also sets `nackPending`, the send is awaited, and a mail that
reaches a route records `nackSentAt` and clears `nackPending` in one further
write — WHEN THAT WRITE SUCCEEDS; when it does not, the debt stays and the nack
may repeat. So a crash between settling and sending — or a send that could not be
delivered — is visible on the record, and a later start retries delivery for any
`failed` record carrying `nackPending` with no `nackSentAt`, once the store can
be written; a crash AFTER the hand-off but before that write retries delivery
too, so the sender may see the nack twice — the mail is owed until a hand-off is
RECORDED. It
decides from the record — evidence found → `acked`; committed with no evidence at
the deadline → `unconfirmed` (no failed state, **no nack mail, no nack stamp**,
logged by name); a definitive non-delivery verdict → `failed` and a nack, **even
after commit**. A definitive verdict is a refusal decided BEFORE the delivery
call (no route at all, a named route failure such as `gal-without-remote`) or the
outbox drain QUARANTINING THIS REPLY'S OWN RECORD — attributed by the reply id
itself (the drain keeps the original name, which carries the reply the plugin
posted). A THROW FROM THE DELIVERY CALL IS NOT A VERDICT: once `delivering` is
persisted the bytes may already have left, so a throw resolves by evidence or
deadline — on a later start once the store can be written, if it cannot be
written at that deadline — and only a throw before the write-ahead landed fails
and nacks. An
unrelated `.malformed-*` marker, or an evidence step that threw, is not a verdict
either: those resolve at the deadline.

## Obligation record retention (cli#401)

Every inbound opens a durable obligation record at
`<mailDir>/<agent>/.obligations/<inboundId>.json` (the ack key). Left alone they
accumulate forever (one ~600 B file per inbound), so at **startup recovery** the
plugin sweeps the store:

- **Only TERMINAL records** (`acked`, `unconfirmed`, `failed`) are deletable.
  `pending`, `delivering`, `posted` and `yielded` are NEVER deleted, at any
  age — restart recovery reads them to re-arm deadlines.
- **A terminal record still OWING its nack mail is HELD, while it is inside the
  hold window.** A `failed` record with `nackPending` and no `nackSentAt` is not
  swept while its OWN last transition is inside the hold (a configurable multiple
  of `obligationRetentionDays`, default **4×**): startup retries delivery from
  that record, so deleting it would erase the only durable evidence that the
  sender is still owed a mail. Startup retries owed nacks OFF the startup path
  (one unreachable branch must not stall the start) and the sweep HOLDS a
  still-owed record whichever of the two runs first; once the debt is discharged
  (`nackSentAt` recorded) the record is ordinary and ages out normally. **Past the
  hold the debt is ABANDONED** — logged `nack-abandoned`, once, by name — and
  normal retention applies to the record.
- A terminal record is deleted when its **last transition** is older than the
  window. The age is the record's OWN recorded `lastTransitionAt` (falling back
  to `inboundTimestamp` for records written before that field existed) — never
  the file mtime.
- **The window is configurable.** Key `obligationRetentionDays`, in the plugin
  ENTRY's config (`plugins.entries["openclaw-tps-mail"].config` in
  `openclaw.json` — OpenClaw passes this to the plugin as `api.pluginConfig`) or
  the channel's config block (`channels."tps-mail"`). Default **7** days; a
  value `<= 0` disables the sweep.

  ```json
  "plugins": {
    "entries": {
      "openclaw-tps-mail": { "config": { "obligationRetentionDays": 14 } }
    }
  }
  ```

- **The owed-nack hold is configurable too.** Key `obligationNackHoldMultiple`
  (same two config locations), a multiple of `obligationRetentionDays`: default
  **4** (so a 7-day window holds an owed nack for 28 days before abandoning it).
  A non-positive/invalid value falls back to the default.

- **Safe + best-effort:** a record that is unreadable/malformed (or has no
  parseable timestamp) is LEFT in place and logged once, and a deletion failure
  never blocks startup.
- **Replay after a sweep is ACCEPTED:** a replayed inbound id whose record was
  swept opens a FRESH obligation. Relay retries arrive within minutes or hours,
  never 7 days later, so the sweep cannot collide with a real retry.

## Metadata receipts and the delivery residual

A reply delivered over a route that leaves **no locally readable mail file** —
the wire to a remote branch, or the branch-office bridge — is receipted so the
obligation loop can see that it committed. The receipt is a small metadata-only
record: the reply id, the obligation id, the inbound it answers, the route and
the branch, plus a timestamp, and **never the mail body**. It is written 0600 at
`<mailDir>/<agent>/.obligations/receipts/<obligationId>.json` — inside the
**replying agent's own** obligation store.

- **The replying agent owns its receipts.** They live beside the obligations
  that owe them, so a startup sweep sees only its own agent's receipts and keys
  each one on the obligation id (a unique id): a live obligation keeps its
  receipt, a terminal obligation's receipt goes, and a receipt with no
  obligation left in the store goes once it has aged past the retention window
  (an orphan). A receipt with no readable timestamp is never aged out.
- **A receipt is matched by what it NAMES, never by a signature.** The scan pins
  the obligation id, the inbound the receipt answers, and — when the obligation
  record knows the reply it was discharged by — the reply id too, so a body
  copied from an older reply under the current ids needs the matching reply id as
  well. The envelope `from` the scan reads is the CLAIM the body carries, not a
  verified identity: no signature is checked here (that boundary is tracked
  separately, and a signature alone would not bind the receipt to one inbound).
- **A bridge delivery is readable in the sandbox too.** The bridge's reduced
  sandbox record carries the obligation, inbound and reply ids when an
  obligation supplies them, so that delivery stays locally readable evidence
  even if the receipt above could not be written. A caller that supplies none —
  an ordinary send — leaves the record exactly as it was.
- **A committed delivery fails only on a definitive non-delivery verdict.** The
  commit is a PERSISTED
  state of the obligation record (`delivering` before the delivery call, `posted`
  when it returns), never a flag in the plugin's memory, so a restart, the
  deadline timer and the dispatch's outer catch all read the same truth. A throw
  from ANY step that runs after the commit — the ACK transition, the receipt
  scan, the posted transition, the receipt write, the failedCounts log — is
  logged by name (`post-commit-error:<step>`, or `receipt-write-failed` for the
  receipt) and does **not** fail the obligation or nack the inbound, whichever
  catch it lands in; the obligation's normal deadline is armed so it still
  resolves to `acked` or `unconfirmed` once the store can be written. The
  residual that leaves is the wire
  route's: a replying host that cannot write its own receipt (a full disk, for
  example — the bridge still has its sandbox record, the wire does not) has no
  local evidence, so its obligation resolves at its **deadline** — and so does a
  committed reply whose own posted record cannot be read back as a valid receipt.
  Either resolution needs the obligation store to be writable: if it cannot be
  written at that deadline, the record stays live and resolves on a later start,
  once the store can be written.
  The one thing that still fails a committed obligation is a DEFINITIVE
  non-delivery verdict: the drain quarantining this reply's own record, attributed
  by its reply id.

## Retiring the old hook

Once this plugin is live, retire the shell-hook setup:

- Stop `ai.tpsdev.mail-watch` launchd service (or update `tps-mail-watch` to exclude K&S/Anvil/Pulse)
- Delete or archive `~/.tps/bin/hooks/openclaw-deliver.sh`

See `~/ops/specs/TPS-MAIL-OPENCLAW-ROUTING.md` for the full design context and the reasons we migrated away from the hook.

## Security review status (Sherlock, 2026-04-09)

All five security concerns were reviewed. Two are fixed in this version; three are accepted risks gated by a future spec.

| # | Concern | Verdict | Status |
|---|---------|---------|--------|
| 1 | Trust boundary — filesystem as auth | fix-before-non-rockit | Accepted for single-user rockit. Requires Ed25519 envelope signatures before multi-host or shared-workstation deployment. Tracked in `TPS-MAIL-SIGNATURES` spec (to be written). |
| 2 | Prompt injection via body | fix-before-non-rockit | Mitigated by constraining senders to trusted agents (single-user host). Full defense-in-depth (origin tagging, destructive-tool approval flow) deferred to `TPS-MAIL-SIGNATURES`. |
| 3 | Session poisoning via spoofed `from` | fix-before-non-rockit | Same root cause as #1 — session key binds to unauthenticated `from` string. Requires cryptographic sender verification. Deferred to `TPS-MAIL-SIGNATURES`. |
| 4 | Outbound identity fallback to "unknown" | **fixed** | `sendText` now fails closed — refuses to send if sender identity can't be resolved. |
| 5 | File move race (write-then-unlink) | **fixed** | `moveToCur` now uses `renameSync` new/ → tmp/ (atomic), then writes enriched version to cur/. Crash between steps leaves file in tmp/ (not re-processable from new/). |

## Known gaps

- **Single hub account.** The plugin assumes a single "default" account pointing at `~/.tps/mail`. Multi-user or multi-host setups would need account-per-host configuration.
- **No per-principal auth.** The plugin trusts the OS user boundary for sender authenticity. This is acceptable on single-user rockit. For multi-host or shared-workstation deployments, file-level Ed25519 envelope signatures are required — see security review items 1-3 above. A `TPS-MAIL-SIGNATURES` spec will gate non-rockit deployment.
- **No debounce beyond 50ms.** If the same file gets multiple `fs.watch` events in rapid succession, only the first gets processed (via `seenFiles` dedup). Concurrent-send scenarios haven't been stress-tested.

## Development notes

- Requires OpenClaw SDK **2026.2.19+** for `ctx.channelRuntime`.
- Uses `channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher` as the inbound dispatch path. See `plugin-sdk/src/plugins/runtime/types-channel.d.ts` for the full runtime helper surface.
- No external dependencies beyond Node standard library.
- Session key construction delegates to `channelRuntime.routing.buildAgentSessionKey` when available, falls back to `agent:<recipient>:tps-mail:direct:<sender>` literal format.
