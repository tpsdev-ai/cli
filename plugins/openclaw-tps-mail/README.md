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
