# CHECKPOINT-27 — Agent Backup & Restore

## Context
We have agent bootstrapping (`ops-4.3`), the runtime scaffold (`ops-4.5`), and office management (`ops-4.6`). The missing piece for operational resilience is the ability to back up an agent's full state and restore it — on the same host, a different host, or as a clone for a new role.

Currently if a host dies or an agent's workspace gets corrupted, there's no standardized way to recover. Everything is manual file copying.

## Objective
Implement `tps backup <agent-id>` and `tps restore <agent-id> <archive>` — commands that package an agent's portable state into a single archive and restore it cleanly.

## Requirements

### 1. Backup Scope
The backup archive must include:
- **Workspace files:** `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`
- **Memory journal:** `memory/*.md` (daily files)
- **OpenClaw config fragment:** The agent's entry from `openclaw.json` (not the full config — just the agent's own block)
- **Roster entry:** The agent's TPS report / persona file
- **Bootstrap state:** `.bootstrap-complete` marker status

The backup must **NOT** include:
- API keys, tokens, or vault secrets (these are host-specific and stored in the vault)
- Mail inbox/outbox (ephemeral, not portable)
- Gateway PID files or runtime state
- Other agents' data

### 2. Archive Format
- Use a tar.gz archive with a manifest JSON at the root
- Manifest includes: agent ID, backup timestamp, source host fingerprint, TPS CLI version, file checksums (SHA-256)
- Filename convention: `<agent-id>-<ISO-date>.tps-backup.tar.gz`

### 3. Restore Protocol
`tps restore <agent-id> <archive>`:
- Validate archive integrity (checksums)
- **[S27-A]** Validate that the archive manifest agent ID matches the target, OR allow `--force` to restore as a different agent (clone use case)
- **[S27-B]** Never overwrite existing workspace files unless `--overwrite` is explicitly passed. Default behavior: skip existing files (same as bootstrap idempotency)
- **[S27-C]** Restore must run under a `tps-restore` nono profile with filesystem write access scoped to the target agent's workspace only. Network access restricted to `127.0.0.1` for post-restore health check.
- After restore, run the bootstrap health check to verify the agent is operational
- Write a `.restore-complete` marker (outside workspace, in `~/.tps/restore-state/`) with source archive hash and timestamp

### 4. Backup Scheduling
- `tps backup <agent-id> --schedule daily` — registers a cron entry (via OpenClaw cron or system crontab) to run backup daily
- `tps backup <agent-id> --schedule off` — removes scheduled backup
- Backups stored in `~/.tps/backups/<agent-id>/` with automatic rotation (keep last 7 by default, configurable via `--keep <n>`)

### 5. Clone Use Case
- `tps restore new-agent-id --from <archive> --clone` — restores from another agent's backup as a new identity
- Strips the original agent's name from `SOUL.md` and `IDENTITY.md`, replacing with the new agent ID
- Keeps memory and tools (the "experience" transfers, the identity doesn't)

### 6. Nono Profiles
- `tps-backup` — read-only access to agent workspace + write to `~/.tps/backups/`
- `tps-restore` — write access to target agent workspace + `~/.tps/restore-state/`. Network: localhost only.

### 7. Security & Robustness Constraints (from K&S review)
- **[S27-D]** `tps backup` must warn if `TOOLS.md` contains patterns that look like IPs, hostnames, or credentials. Add `--sanitize` flag (default: warn).
- **[S27-E]** `tps backup --schedule` must verify a valid vault key is available to the cron environment before registering the schedule.
- **[ARCH-1]** `tps restore` must verify source host fingerprint matches current host, or require `--force` to acknowledge cross-host restore.
- **[ARCH-2]** Clone name replacement must use structured marker-based replacement (e.g., `**Name:**` in IDENTITY.md, `name:` fields), not naive find-and-replace.
- **[ARCH-3]** Archive must be scanned before finalization to ensure zero absolute paths leak into manifest or file contents.
- **[ARCH-4]** Restore must be transactional: move existing workspace to `.backup` suffix, restore into clean directory, run health check. Only delete `.backup` on success. On failure, roll back.
- **[ARCH-5]** Temp directories used during backup/restore must be cleaned up via `try/finally` even on failure.
- **[S27-F]** Tar extraction must validate every file path resolves within the target directory (Zip Slip prevention). Use `path.resolve()` and verify it starts with `targetDir + path.sep`.
- **[S27-G]** Backup archives must be written with `0600` permissions — memory files may contain sensitive context.
- **[S27-H]** Cron schedule registration must use sanitized agent IDs only (via `sanitizeIdentifier`) and strict string templating. Never pass raw input to `exec('crontab')`. Prefer OpenClaw cron over system crontab.

## Non-Goals
- Cross-host network transfer (use `scp`/`rsync` externally for now)
- Incremental/differential backups (full snapshot only for v1)
- Encrypted backups (the vault handles secrets separately; backup contents are non-secret workspace files)

## Success Criteria
- `tps backup flint` produces a valid archive with manifest and checksums
- `tps restore flint flint-2026-02-25.tps-backup.tar.gz` restores cleanly and passes health check
- `tps restore new-agent --from flint-backup.tar.gz --clone` creates a new agent with transferred experience
- Scheduled backups run automatically and rotate old archives
- Archive is portable across hosts (no host-specific paths embedded)
- All file paths in the archive are relative (no absolute paths)

## Output Contract
DONE 27: `<commit-hash>` @Flint — or BLOCKED: `<error + file + cmd>` @Flint
