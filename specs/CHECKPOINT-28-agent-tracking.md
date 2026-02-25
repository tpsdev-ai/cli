# CHECKPOINT-28 — Agent Tracking & Operational Dashboard

## Context
We now have the full agent lifecycle covered: hiring (`tps hire`), bootstrapping (`tps bootstrap`), office management (`tps office`), and backup/restore (`tps backup`/`tps restore`). The missing piece is visibility — knowing which agents are alive, healthy, and productive at any given moment.

Currently there's no centralized way to answer: "Which agents are running? When did they last respond? Are any stuck or erroring?"

## Objective
Implement `tps status` — a command that provides a real-time operational dashboard for all agents in the team, plus `tps heartbeat` for agents to self-report their health.

## Requirements

### 1. Agent Status Registry
- **[S28-C] Directory-based registry** at `~/.tps/status/nodes/<agent-id>.json` — each agent writes ONLY its own file. `tps status` aggregates all files in the directory on read. No shared JSONL file.
- Each agent's status file includes:
  - `agentId` — who
  - `host` — hostname/fingerprint
  - `model` — current LLM model
  - `status` — `online` | `idle` | `error` | `offline`
  - `lastHeartbeat` — ISO timestamp of last check-in
  - `lastActivity` — ISO timestamp of last meaningful action (commit, mail, command)
  - `sessionCount` — number of sessions today
  - `errorCount` — errors in last 24h
  - `uptime` — seconds since last restart
  - `version` — TPS CLI version
  - `pid` — agent process ID (for passive verification)

### 2. Heartbeat Protocol
- `tps heartbeat <agent-id>` — agents call this periodically (via OpenClaw heartbeat or cron) to update their status file at `~/.tps/status/nodes/<agent-id>.json`
- If an agent hasn't checked in within a configurable threshold (default: 30 min), `tps status` marks it as `stale`
- If > 2h since last heartbeat, marked as `offline`

### 3. Dashboard Command
- `tps status` — renders a table of all agents with their current state (reads all files in `~/.tps/status/nodes/`)
- `tps status <agent-id>` — detailed view for a single agent (last 10 heartbeats, recent errors, activity log)
- `tps status --json` — machine-readable output for integration
- **[S28-A]** Output must never include API keys, vault contents, or sensitive config values. Only operational metadata.
- **[ARCH-1] Passive verification:** When displaying status, `tps status` must cross-check the self-reported PID against the process table. If the PID is dead but status says `online`, display `zombie` state with a warning.
- **[ARCH-2] Registry cleanup:** `tps status --auto-prune` moves status files for agents that haven't heartbeated in >7 days to `~/.tps/status/archive/`. Separate `tps status prune` subcommand also supported.
- **Security visibility:** If an agent is running with `--nonono` (unrestricted sandbox) or a non-standard nono profile, `tps status` must flag it with a ⚠️ security warning in the output.

### 4. Health Checks
When `tps heartbeat` runs, it also checks:
- Can the agent read/write its workspace?
- Is the gateway reachable?
- **[S28-E]** Is the local credential proxy/gateway responding? (ping the **local proxy**, never the external provider IP directly — sandboxes must have zero direct internet access)
- Are there unprocessed mail messages > 1h old? (possible stuck queue)

Failed checks set `status: error` with a `lastError` field describing the issue.

### 5. Cost Tracking (Lightweight)
- Track token usage per agent per day via a simple append-only log at `~/.tps/status/nodes/<agent-id>/usage.jsonl`
- Each entry: `{ ts, provider, model, inputTokens, outputTokens, estimatedCostUsd }`
- `tps status <agent-id> --cost` shows daily/weekly/monthly rollups
- **[S28-B]** Usage log must be writable only by the agent itself (or the host process). Other agents cannot inflate another agent's usage stats.
- **[S28-F] Size cap:** Per-agent `usage.jsonl` must be capped at 1MB. When exceeded, rotate to `usage.jsonl.1` (keep max 3 rotations). Prevents disk exhaustion from looping agents.
- **Provider multi-tenancy:** `tps status --cost --shared` aggregates usage across all agents sharing the same provider API key for a total burn view.

### 6. Nono Profile
- `tps-status` — **[S28-D]** Must use dynamic path variables: agent gets `readwrite` access ONLY to `~/.tps/status/nodes/${TPS_AGENT_ID}.json` and `~/.tps/status/nodes/${TPS_AGENT_ID}/`. Read access to all of `~/.tps/status/nodes/` for dashboard aggregation. Network: localhost only for health checks.
- If dynamic nono path variables are not yet supported, status updates must be routed through the host relay process which writes on behalf of the agent after validating identity.

## Non-Goals
- Web-based dashboard (CLI only for v1)
- Real-time push notifications (poll-based for now)
- Cross-host aggregation (single host registry for v1)
- Gateway-level usage metering (noted as long-term improvement per ARCH-1 cost tracking — v1 uses self-reporting)

## Security Constraints Summary
| ID | Severity | Description |
|---|---|---|
| S28-A | HIGH | No sensitive data in dashboard output |
| S28-B | HIGH | Agents can only write own usage logs |
| S28-C | CRITICAL | Directory-based registry, no shared JSONL |
| S28-D | HIGH | Dynamic nono paths for write isolation |
| S28-E | HIGH | Health checks ping local proxy only |
| S28-F | MEDIUM | 1MB cap + rotation on usage logs |
| ARCH-1 | MEDIUM | Passive PID verification for zombie detection |
| ARCH-2 | LOW | Auto-prune stale entries >7 days |

## Success Criteria
- `tps status` shows all team agents with accurate state (aggregated from per-agent files)
- Stale/offline/zombie detection works based on heartbeat threshold + PID verification
- Health checks catch common failure modes (workspace, gateway, proxy)
- Cost tracking captures per-agent token usage with rotation
- Zero sensitive data leakage in dashboard output
- All agents can self-report without interfering with each other's entries (filesystem isolation)
- Agents running with `--nonono` are visually flagged

## Output Contract
DONE 28: `<commit-hash>` @Flint — or BLOCKED: `<error + file + cmd>` @Flint
