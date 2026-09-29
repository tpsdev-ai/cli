# @tpsdev-ai/pi-tps-mail

TPS Mail watcher for Pi dispatch with launcher delegation and hard timeout.

## Overview

This package lifts the watcher logic from the Ember launcher's `tps-mail-watcher.mjs` into a publishable npm package. It watches `~/.tps/mail/{agent}/` for new mail, has the `tps` CLI verify it, and dispatches each verified message to Pi via the agent's launcher script.

## Two MANDATORY Invariants

### 1. Shell out to per-agent launcher script for model/provider/identity

The watcher **must never** directly invoke `pi` or configure provider/model/identity. Instead, it delegates to the per-agent launcher script (e.g., `~/agents/ember/bin/ember`) which owns that configuration.

```typescript
// ❌ WRONG — duplicate config logic
const child = spawn("pi", ["--model", "qwen3-coder", body]);

// ✅ CORRECT — delegate to launcher
const child = spawn(EMBER_LAUNCHER, [body], {
  env: process.env,
  cwd: `${HOME}/agents/ember`,
});
```

### 2. Hard timeout with SIGTERM + 5s grace + SIGKILL

Each dispatch must have a hard timeout (default 30 minutes). If the Pi process hangs, the watcher kills it and continues processing other messages.

```typescript
// Timeout kills with SIGTERM, then SIGKILL after 5s grace
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5_000);
}, DISPATCH_TIMEOUT_MS);
```

The loop **continues** after timeout — no silent stalls.

## API

### `WatchOptions`

```typescript
interface WatchOptions {
  agent?: string;              // Agent ID (default: "ember")
  inboxRoot?: string;          // Path to ~/.tps (default: process.env.HOME)
  launcher?: string;           // Path to launcher script (default: ~/agents/{agent}/bin/{agent})
  timeoutMs?: number;          // Dispatch timeout in ms (default: 1_800_000 = 30 min)
  pollIntervalMs?: number;     // Poll interval (default: 5_000)
  rescanIntervalMs?: number;   // Run the verified check at least this often (default: 60_000)
  retryBackoffMs?: number;     // First re-send delay after an unknown send outcome (default: 60_000)
  sendTimeoutMs?: number;      // Bound on one `tps mail send` (default: 30_000)
  ackTimeoutMs?: number;       // Bound on one `tps mail ack` (default: 10_000)
  checkTimeoutMs?: number;     // Bound on one `tps mail check` (default: 30_000)
}
```

### `Watch Mail`

```typescript
import { watchMail } from "@tpsdev-ai/pi-tps-mail";

const watcher = watchMail({
  agent: "ember",
  timeoutMs: 1_800_000,  // 30 minutes
});

// Watcher runs until stop() is called; drain() resolves when the poll in flight ends
process.on("SIGINT", () => watcher.stop());
process.on("SIGTERM", () => watcher.stop());
```

### `watchMail` behavior

Every `tps` invocation below runs as the agent (`TPS_AGENT_ID={agent}`,
`TPS_MAIL_DIR={inboxRoot}/.tps/mail`).

1. Every 5 seconds (`pollIntervalMs`) it first finishes any reply its journal
   still owes (step 3), then — when `new/` holds anything, or at least every
   `rescanIntervalMs` — runs **`tps mail check {agent} --json`**. That is the
   CLI's promotion path: it verifies each inbound's signed envelope (signature,
   sender, recipient, replay, id shape), moves it to `cur/`, and dead-letters
   what fails to `dlq/`; it also re-verifies and re-presents a `cur/` record
   whose processing lease expired without an ack. **The watcher acts only on the
   records that command returns** — never on a file it reads itself — so an
   unsigned or forged inbound is never dispatched and never answered, and the
   sender, the body and the thread all come from the verified envelope.
2. For each verified inbound:
   - Spawns the launcher script with the verified message body as its argument,
     with a hard timeout (SIGTERM → 5s grace → SIGKILL).
   - Journals the reply at `{inboxRoot}/.tps/mail/{agent}/.pi-tps-mail/replies/{id}.json`
     (0600): the verified sender and thread, the reply text, and the envelope
     `messageId` every attempt signs with. A journal entry that cannot be
     written blocks the send.
   - Sends it with `tps mail send {from} --stdin --reply-to {envelopeId}
     --message-id {journal messageId}`: the reply goes on **stdin** (never argv),
     `--reply-to` threads it to the inbound's verified envelope `messageId`, and
     `--message-id` makes every attempt the same message. The CLI signs it with
     the agent's key (`~/.flair/keys/{agent}.key` and/or
     `~/.tps/identity/{agent}.key` — two different keys are refused) and refuses
     to send (non-zero, nothing written) when it cannot.
   - Acknowledges with `tps mail ack {id}` **only after the send succeeded**.
3. Failures, and what the journal does with them:
   - **A send whose outcome is unknown** (a non-zero exit or a timeout — the CLI
     may have delivered before it failed) is re-sent after a backoff
     (`retryBackoffMs`, default 60 s, doubling to 30 minutes) with the same
     text, thread and `messageId`; the launcher is not re-run. If the first
     attempt had in fact been delivered, the recipient receives a second copy
     of the same message (same `messageId`), which a `promote()`-reading
     recipient dead-letters as a replay.
   - **An ack that fails** is retried on the next poll without re-sending.
   - **A restart** finishes the journal: a `sent` entry is acked, a `prepared`
     entry is re-sent as the same message.
   - **A crash while the launcher runs** (before the journal entry exists) leaves
     the inbound unacked in `cur/`; `tps mail check` re-presents it once its
     lease expires (30 minutes) and the launcher runs again — at-least-once.
4. Continues the loop on errors (a failed check, spawn failures, timeouts)
5. `stop()` starts nothing new; `drain()` resolves when the poll in flight ends

## CLI

```bash
# Watch ember's inbox with default 30-min timeout
npx @tpsdev-ai/pi-tps-mail

# Custom agent with 10-minute timeout
npx @tpsdev-ai/pi-tps-mail --agent flint --timeout 600000

# Custom inbox root (e.g., for testing)
npx @tpsdev-ai/pi-tps-mail --inbox /private/tmp/tps-mail-test
```

## Tests

```bash
cd packages/pi-tps-mail

# The verified inbound, the reply journal and recovery (real CLI + a stub Flair)
bun test test/reply-send.test.ts

# Round-trip dispatch (slow — 30 min timeout)
bun test test/roundtrip.test.ts

# Hung child timeout (fast — overrides timeout to 2s)
bun test test/timeout.test.ts

# Bad JSON handling (fast — no timeout)
bun test test/bad-json.test.ts
```

## Files

- `./src/index.ts` — Public API exports
- `./src/watcher.ts` — Core watcher logic with launcher delegation + timeout
- `./src/bin.ts` — CLI entrypoint
- `./src/types.ts` — TypeScript interfaces
- `./test/` — Test suite
