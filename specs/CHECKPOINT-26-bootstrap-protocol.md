# CHECKPOINT-26 — Bootstrap Protocol

## Context
We have the agent runtime scaffold (`ops-4.5`) and the Office Manager (`ops-4.6`) for environment provisioning. The missing piece is a standardized protocol for onboarding a new agent — from zero to operational — without manual hand-holding.

Currently, new agents get a `BOOTSTRAP.md` dropped into their workspace, which triggers an identity conversation. This works but is ad-hoc and undocumented. We need a repeatable, verifiable process.

## Objective
Implement `tps bootstrap <agent-id>` — a single command that takes an agent from "just hired" to "fully operational" with all required files, configs, and verification checks in place.

## Requirements

### 1. Required File Checklist
The bootstrap command must verify (and scaffold if missing) these workspace files:
- `SOUL.md` — agent identity, role, communication style
- `IDENTITY.md` — name, emoji, creature type
- `USER.md` — who the agent serves
- `AGENTS.md` — workspace conventions and rules
- `TOOLS.md` — local environment notes
- `HEARTBEAT.md` — periodic task config
- `memory/` directory — daily journals

### 2. Config Generation
- Generate or validate `openclaw.json` fragment for the agent
- Set model, workspace path, channel bindings
- Wire up Discord bot token and channel mappings if provided

### 3. Team Introduction Protocol
- After bootstrap completes, send an introduction mail to the team mailbox
- Include: agent name, role, model, capabilities summary
- Other agents can discover the new agent via `tps roster`

### 4. Operational Verification
After bootstrap, run a health check:
- Can the agent read/write its workspace?
- Is the gateway reachable?
- Can it send/receive mail?
- Is it registered in the roster?

Write a `.bootstrap-complete` marker with timestamp on success.

### 5. Nono Profile
Create `tps-bootstrap` profile — needs workspace write access and network access for gateway verification, but should NOT have broad system access.

## Non-Goals
- Automated Discord bot creation (requires human OAuth flow)
- Model selection AI (agent picks its own model) — future work
- Multi-host orchestration — single host only for now

## Success Criteria
- `tps bootstrap <agent-id>` takes a freshly hired agent to operational in one command
- All required files exist and are valid after bootstrap
- Health check passes
- Agent appears in roster
- Team introduction mail is sent
- 0 manual steps required after running the command

## Output Contract
DONE 26: `<commit-hash>` @Flint — or BLOCKED: `<error + file + cmd>` @Flint
