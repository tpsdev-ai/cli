# CHECKPOINT-28 — Agent Tracking & Operational Dashboard

## Context
We now have the full agent lifecycle covered: hiring (`tps hire`), bootstrapping (`tps bootstrap`), office management (`tps office`), and backup/restore (`tps backup`/`tps restore`). The missing piece is visibility — knowing which agents are alive, healthy, and productive at any given moment.

Currently there's no centralized way to answer: "Which agents are running? When did they last respond? Are any stuck or erroring?"

## Objective
Implement `tps status` — a command that provides a real-time operational dashboard for all agents in the team, plus `tps heartbeat` for agents to self-report their health.

## Requirements

### 1. Agent Status Registry
- A shared JSONL file at `~/.tps/status/registry.jsonl` where each agent writes its own status entry
- Each entry includes:
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

### 2. Heartbeat Protocol
- `tps heartbeat <agent-id>` — agents call this periodically (via OpenClaw heartbeat or cron) to update their registry entry
- If an agent hasn't checked in within a configurable threshold (default: 30 min), `tps status` marks it as `stale`
- If > 2h since last heartbeat, marked as `offline`

### 3. Dashboard Command
- `tps status` — renders a table of all agents with their current state
- `tps status <agent-id>` — detailed view for a single agent (last 10 heartbeats, recent errors, activity log)
- `tps status --json` — machine-readable output for integration
- **[S28-A]** Output must never include API keys, vault contents, or sensitive config values. Only operational metadata.

### 4. Health Checks
When `tps heartbeat` runs, it also checks:
- Can the agent read/write its workspace?
- Is the gateway reachable?
- Is the configured LLM provider responding? (minimal ping, zero tokens)
- Are there unprocessed mail messages > 1h old? (possible stuck queue)

Failed checks set `status: error` with a `lastError` field describing the issue.

### 5. Cost Tracking (Lightweight)
- Track token usage per agent per day via a simple append-only log at `~/.tps/status/<agent-id>/usage.jsonl`
- Each entry: `{ ts, provider, model, inputTokens, outputTokens, estimatedCostUsd }`
- `tps status <agent-id> --cost` shows daily/weekly/monthly rollups
- **[S28-B]** Usage log must be writable only by the agent itself (or the host process). Other agents cannot inflate another agent's usage stats.

### 6. Nono Profile
- `tps-status` — read access to all agent registry entries + write access to own entry only. Network: localhost for health checks.

## Non-Goals
- Web-based dashboard (CLI only for v1)
- Real-time push notifications (poll-based for now)
- Cross-host aggregation (single host registry for v1)

## Success Criteria
- `tps status` shows all team agents with accurate state
- Stale/offline detection works based on heartbeat threshold
- Health checks catch common failure modes (workspace, gateway, provider)
- Cost tracking captures per-agent token usage
- Zero sensitive data leakage in dashboard output
- All agents can self-report without interfering with each other's entries

## Output Contract
DONE 28: `<commit-hash>` @Flint — or BLOCKED: `<error + file + cmd>` @Flint
