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

## Branch Office (Sandboxing)

### `tps office`

Manage Docker-based sandboxes ("Branch Offices"). Requires Docker Desktop.

**Usage:**
```bash
tps office start <agent>
tps office stop <agent>
tps office list
tps office status <agent>
```

**Commands:**
- `start <agent>`: Create and start a sandbox for the agent. Installs OpenClaw and TPS inside.
- `stop <agent>`: Stop the sandbox.
- `list`: List all branch office workspaces.
- `status <agent>`: Show sandbox status and mail relay details.

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
