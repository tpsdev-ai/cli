# TPS Command Reference

The `tps` CLI is the control plane for the Agent OS.

## Global Options

| Option | Description |
| :--- | :--- |
| `--config <path>` | Path to `openclaw.json` (defaults to auto-discovery). |
| `--version` | Show version number. |
| `--help` | Show help. |

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
tps office connect <name>           # Long-running connection (use under KeepAlive)
tps office sync <name>              # One-shot connect+drain
tps office revoke <name>            # Drop a paired branch from the registry
```

**Docker-sandbox commands:**
- `start <agent>`: Create and start a sandbox for the agent. Installs OpenClaw and TPS inside.
- `stop <agent>`: Stop the sandbox.

**Remote-relay commands:**
- `join <name> <join-token>`: Register a remote branch using the `tps://join?…` token printed by `tps branch init` on the branch.
- `connect <name>`: Open a persistent encrypted channel to the named branch. Designed for KeepAlive (launchd/systemd).
- `sync <name>`: One-shot connect, drain inbound/outbound mail, disconnect. Useful for catch-up.
- `revoke <name>`: Remove the branch from `~/.tps/registry/`. Does not remove launchd/systemd units — clean those up separately.

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
tps mail check [agent]
tps mail list [agent]
tps mail log [agent] [--since YYYY-MM-DD] [--limit N]
```

**Commands:**
- `send <agent> <message>`: Send a text message to an agent.
- `check [agent]`: Check inbox for agent (moves messages from `new` to `cur`). Falls back to `TPS_AGENT_ID` env var.
- `list [agent]`: List all messages for agent (read and unread). Falls back to `TPS_AGENT_ID` env var.
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
