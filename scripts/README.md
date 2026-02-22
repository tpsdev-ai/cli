# TPS Scripts

Standalone operational scripts for branch VMs.

## deploy-bot.ts

Mail-driven command dispatcher (no LLM):
- `deploy`
- `status`
- `run <cmd>` (allowlisted)

### Quick start

```bash
export DEPLOY_BOT_AGENT=austin
export DEPLOY_BOT_TPS_DIR=~/tps
export DEPLOY_BOT_HOST_AGENT=rockit

tmux new-session -d -s deploy-bot 'cd ~/tps && bun scripts/deploy-bot.ts'
```

Trigger from host:

```bash
tps mail send austin "status"
tps mail send austin "deploy"
```
