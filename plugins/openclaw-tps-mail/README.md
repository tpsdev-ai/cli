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

## Obligation record retention (cli#401)

Every inbound opens a durable obligation record at
`<mailDir>/<agent>/.obligations/<inboundId>.json` (the ack key). Left alone they
accumulate forever (one ~600 B file per inbound), so at **startup recovery** the
plugin sweeps the store:

- **Only TERMINAL records** (`acked`, `failed`) are deletable. `pending`,
  `posted` and `yielded` are NEVER deleted, at any age — restart recovery reads
  them to re-arm deadlines.
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
- **Nothing after a delivery commits fails a delivered reply.** Once a delivery
  call has returned it has committed, so the plugin guards the failure verb
  itself: a throw from ANY step that runs after the commit — the ACK transition,
  the receipt scan, the posted transition, the receipt write, the failedCounts
  log — is logged by name (`post-commit-error:<step>`, or `receipt-write-failed`
  for the receipt) and does **not** fail the obligation or nack the inbound,
  whichever catch it lands in. For the wire route the receipt is the only local
  evidence, so the residual is this: a replying host that cannot write its own
  receipt (a full disk, for example — the bridge still has its sandbox record,
  the wire does not) resolves that obligation at its **deadline** instead of
  immediately. A committed reply whose own posted record cannot be read back as
  a valid receipt resolves at its deadline the same way.

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
