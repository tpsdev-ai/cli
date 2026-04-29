# @tpsdev-ai/pi-tps-mail

TPS Mail watcher for Pi dispatch with launcher delegation and hard timeout.

## Overview

This package lifts the watcher logic from the Ember launcher's `tps-mail-watcher.mjs` into a publishable npm package. It watches `~/.tps/mail/{agent}/new/` for new messages and dispatches them to Pi via the agent's launcher script.

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
}
```

### `Watch Mail`

```typescript
import { watchMail } from "@tpsdev-ai/pi-tps-mail";

const watcher = watchMail({
  agent: "ember",
  timeoutMs: 1_800_000,  // 30 minutes
});

// Watcher runs until stop() is called
process.on("SIGINT", () => watcher.stop());
process.on("SIGTERM", () => watcher.stop());
```

### `watchMail` behavior

1. Polls `~/.tps/mail/{agent}/new/` every 5 seconds
2. For each JSON file:
   - Parses as `MailMessage` (id, from, body)
   - Moves file to `~/.tps/mail/{agent}/cur/`
   - Spawns launcher script with message body as argument
   - Enforces hard timeout with SIGTERM → 5s grace → SIGKILL
   - Sends reply via `tps mail send {from} {stdout}` on success
   - Sends ack via `tps mail ack {id} {agent}` on success
3. Continues loop on errors (bad JSON, spawn failures, timeouts)
4. Gracefully exits on SIGINT/SIGTERM

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
