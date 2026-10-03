# TPS Command Reference

The `tps` CLI is the control plane for the Agent OS.

## Global Options

| Option | Description |
| :--- | :--- |
| `--config <path>` | Path to `openclaw.json` (defaults to auto-discovery). |
| `--version` | Show version number. |
| `--help` | Show help. |
| `--sandbox-required[=true|false]` / `--sandboxRequired[=true|false]` | Require isolation; conflicts with `--no-sandbox`. |
| `--no-sandbox` | Interactive TTY opt-out. `--sandbox=false` does not opt out. |

Sandbox flag values must be exactly `true` or `false`; other values are refused by name.

A selected runtime (`agent start --runtime claude-code|codex|gemini`) takes its
config directory from an environment variable — `CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, or the gemini directory under `XDG_CONFIG_HOME`. A directory that
equals, contains or sits inside `~/.tps/auth`, `~/.tps/identity` or
`~/.tps/secrets` (compared canonically, symlinks resolved) refuses the sandboxed
launch before any runner starts, naming the variable and the overlapping root.
The launch's own directory grants are checked the same way, so a runtime profile
does not reach another runtime's credentials.

---

## Provisioning

### `tps hire`

Onboards a new agent from a `.tps` report file. Generates workspace files (`SOUL.md`, `AGENTS.md`, etc.) and configuration.

**Usage:**
```bash
tps hire <report-path> [options]
```

**Options:**
| Option | Description |
| :--- | :--- |
| `--name <name>` | Override the agent name (defaults to `identity.default_name` from report). |
| `--workspace <path>` | Override workspace location. Must be within `~/.openclaw/` (host) or `~/.tps/branch-office/` (branch). |
| `--branch` | Provision for a Branch Office (sandbox). Skips host isolation checks. |
| `--dry-run` | Preview changes without writing files. |
| `--json` | Output the generated config object as JSON. |

**Examples:**
```bash
tps hire ./reports/developer.tps --name Scout
tps hire ./reports/ea.tps --branch
```

---

## Identity & Discovery

### `tps roster`

Manage the agent directory and contact cards.

**Usage:**
```bash
tps roster list
tps roster show <agent>
tps roster find --channel <channel>
```

**Commands:**
- `list`: List all known agents.
- `show <agent>`: Display detailed contact card for an agent.
- `find --channel <name>`: Find agents reachable via a specific channel (e.g., `discord`).

**Options:**
| Option | Description |
| :--- | :--- |
| `--json` | Output results as JSON. |

---

## Branch Office

TPS supports two branch-office models:

- **Docker sandboxes** (`tps office start <agent>`) — short-lived agent containers on the local host.
- **Remote relay** (`tps branch …` on the remote + `tps office join`/`connect` on the host) — persistent agents on a separate machine, paired over Noise IK + WebSocket.

For the remote-relay model — including provisioning a new branch office VM, troubleshooting, and security notes — see [branch-office.md](branch-office.md).

### `tps office` (host side)

**Usage:**
```bash
tps office start <agent>            # Docker-sandbox model
tps office stop <agent>
tps office list
tps office status [agent]

tps office join <name> <join-token> # Remote-relay model: pair a remote branch
  [--tunnel-via <ssh-host>] [--port <n>] [--force]
  [--no-flair] [--force-reinstall-flair]
tps office connect <name>           # Long-running connection (use under KeepAlive)
tps office sync <name>              # One-shot connect+drain
tps office revoke <name>            # Drop a paired branch from the registry
  [--keep-units] [--purge-flair]
```

**Docker-sandbox commands:**
- `start <agent>`: Create and start a sandbox for the agent. Installs OpenClaw and TPS inside.
- `stop <agent>`: Stop the sandbox.

**Remote-relay commands:**
- `join <name> <join-token>`: Register a remote branch using the `tps://join?…` token printed by `tps branch init` on the branch. With `--tunnel-via <ssh-host>`, also provisions macOS launchd supervision (ops-7x9y) and a Flair spoke on the remote (ops-209a, opt-out with `--no-flair`). Use `--force-reinstall-flair` to re-provision an existing Flair install.
- `connect <name>`: Open a persistent encrypted channel to the named branch. Designed for KeepAlive (launchd/systemd).
- `sync <name>`: One-shot connect, drain inbound/outbound mail, disconnect. Useful for catch-up.
- `revoke <name>`: Remove the branch from `~/.tps/registry/`. Tears down supervision units (unless `--keep-units`) and Flair spoke (unless `--keep-units`). Pass `--purge-flair` to also `rm -rf ~/.flair ~/.harper/flair` on the branch.

**Common to both:**
- `list`: List entries from `~/.tps/branch-office/` (one row per known branch alias, with sandbox-presence flag). Output is local registry state, not live connection health — use `status` for that.
- `status [agent]`: Show live connection state (Docker container status for sandboxes, or relay heartbeat + reconnect-count + message counters from `~/.tps/connections/<agent>.json` for remote relays).

### `tps branch` (branch side)

Run on the remote machine that hosts the agent.

**Usage:**
```bash
tps branch init [--listen <port>] [--host <hostname>] [--transport ws|tcp] [--agent <id>] [--force]
tps branch start
tps branch stop
tps branch status
tps branch log [--lines N] [--follow]
```

**Commands:**
- `init`: Generate branch identity, write `~/.tps/branch.conf.json`, and wait for an incoming host `office join`. Pass `--agent <id>` to fix the local maildir name (otherwise falls back to `hostname()` — see [branch-office.md troubleshooting](branch-office.md#troubleshooting)).
- `start`: Run the long-lived listener daemon. Daemonizes; logs to `~/.tps/branch.log`.
- `stop`: Stop the daemon (reads `~/.tps/branch.pid`).
- `status`: Report whether the daemon is running, the listen address, and the paired host fingerprint.
- `log`: Tail `~/.tps/branch.log`.

---

## Communication

### `tps mail`

Async, persistent messaging between agents (Host ↔ Branch or Host ↔ Host).

**Usage:**
```bash
tps mail send <agent> <message>
printf '%s' "$body" | tps mail send <agent> --stdin [--reply-to <messageId>] [--message-id <id>] [--json]
tps mail check [agent]
tps mail list [agent]
tps mail log [agent] [--since YYYY-MM-DD] [--limit N]
```

**Commands:**
- `send <agent> <message>`: Send a signed text message to an agent.
  - `--stdin` reads the body from stdin (UTF-8) instead of argv. The 64 KiB limit applies to the SIGNED message — the body plus its signature and envelope fields — so the body itself must be somewhat smaller; an over-limit message is refused by name (`Refusing to send: the signed message is too large to send…`) before any route, and nothing is written. The command never prints the body: not in its text output, not with `--json`, not in an error.
  - `--reply-to <messageId>` threads the message to the signed `messageId` it answers. The id is carried inside the signed envelope; it must be 1-128 letters, digits, dots, underscores or hyphens.
  - `--message-id <id>` signs the envelope with that `messageId` instead of a fresh UUID (same rule as `--reply-to`). A sender that re-sends after an unknown outcome passes the same id, so a recipient's replay gate discards the second copy.
  - `--json` prints delivery metadata only, on every route: `status`, `route` (`local`, `outbox`, `bridge` or `remote-branch`), `to`, `from`, the signed `messageId`, `replyToId` when set, `signedAt`, and, on the local route, the record `id` and `timestamp`.
  - Every send is signed with the sender's Ed25519 key. Both `~/.flair/keys/<id>.key` and `~/.tps/identity/<id>.key` (where `tps init` and `tps agent create` put it) are read: when both exist they must hold the same key, and two different keys are refused with both paths and the remedy. A file that cannot be read or parsed is an error naming its path. Accepted formats: a raw 32-byte seed, one line of base64 PKCS8 DER, raw PKCS8 DER, or exactly one unencrypted PEM `PRIVATE KEY` block.
  - With no usable key the send fails (non-zero exit, the paths it looked at and the remedy) and nothing is written. There is no unsigned mode.
  - What signs today: `tps mail send` (all four routes), the openclaw-tps-mail plugin's dispatcher replies and nacks, the codex/gemini runtimes' replies (runtime mail), pulse notifications, topic fan-out and catch-up, hire onboarding, roster invites, bootstrap's introduction and health probe, branch handler replies and forwards, and the `@tpsdev-ai/agent` runtime's `MailClient.sendMail`. Topic publication establishes signing before appending to its log; catch-up keeps its cursor before an undelivered entry. The openclaw-tps-mail plugin's outbound adapter (`sendText`) and the channel bridge still write their own bodies (tpsdev-ai/cli#433, slice B). A verifying recipient dead-letters an unsigned body. (A branch forward signs as the forwarding agent, carrying unchanged original content as data. Recipient acceptance still requires a matching Flair principal and mailbox policy.)
- `check [agent]`: Check inbox for agent (moves messages from `new` to `cur`). Falls back to `TPS_AGENT_ID` env var.
- `list [agent]`: List all messages for agent (read and unread). Falls back to `TPS_AGENT_ID` env var. A message that has not been verified shows no body, no thread (`replyToId`/`envelopeId`) and no headers — only its id, claimed sender and recipient, timestamp, location and lifecycle fields.
- `log [agent]`: Query the communication archive. Shows all send/read events across agents. Filter by `--since` date and `--limit` count.

**Options:**
| Option | Description |
| :--- | :--- |
| `--json` | Output messages as JSON. |

**Note:** `tps mail` identifies the sender via `TPS_AGENT_ID` environment variable.

---

## Context Memory

### `tps context`

Manage persistent workstream context.

**Usage:**
```bash
tps context read <workstream>
tps context update <workstream> --summary "..."
tps context list
```

**Commands:**
- `read <workstream>`: Read the summary for a specific workstream.
- `update <workstream>`: Update the summary. Atomic last-write-wins.
- `list`: List all active workstreams.

**Options:**
| Option | Description |
| :--- | :--- |
| `--summary <text>` | Content for the update. |
| `--json` | Output as JSON. |

---

## Maintenance

### `tps review`

Perform a performance review (workspace inspection) for an agent.

**Usage:**
```bash
tps review <agent> [options]
```

**Options:**
| Option | Description |
| :--- | :--- |
| `--deep` | Enable deep inspection (requires network/LLM). |
