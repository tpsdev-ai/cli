# @tpsdev-ai/cli

> TPS (Team Provisioning System) — an Agent OS CLI for managing isolated AI agents.

Hire agents, provision secure branch offices, manage identity and encrypted comms, track operational health — all from the command line.

## Install

```bash
npm install -g @tpsdev-ai/cli
```

## Commands

| Command | Description |
|---------|-------------|
| `tps hire <report>` | Onboard a new agent from a TPS report |
| `tps roster` | List all agents and their status |
| `tps bootstrap <agent>` | Run first-boot health checks and workspace scaffolding |
| `tps office setup` | Configure sandbox environment from workspace manifest |
| `tps backup <agent>` | Create encrypted, checksummed workspace backup |
| `tps restore <agent> <archive>` | Restore agent workspace with transactional rollback |
| `tps status` | Operational dashboard — health, uptime, cost tracking |
| `tps heartbeat <agent>` | Agent self-reports health (workspace, gateway, provider) |
| `tps identity init` | Generate Ed25519 host keypair |
| `tps branch init` | Initialize a remote branch office |
| `tps office join` | Join a branch to the head office via Noise_IK handshake |
| `tps office connect` | Establish persistent encrypted relay channel |
| `tps mail send` | Send async mail to a branch agent |
| `tps mail check` | Check for incoming mail |
| `tps secrets set/get` | Encrypted vault for API keys and credentials |

## Architecture

TPS treats AI agents like employees in an organization:

- **Branch Offices** — isolated sandboxes (Docker, VMs, or `nono` process isolation)
- **The Mailroom** — async, persistent, cross-boundary messaging via Maildir
- **Wire Security** — Noise_IK protocol over WebSocket for E2E encrypted transport
- **Identity** — Ed25519 keypairs with signed join tokens

Agents communicate through three channels:
1. **Mail** for messages (tasks, status, coordination)
2. **Git** for artifacts (code, reports, generated files)
3. **APIs** for external data

## Security

- All inter-office traffic is E2E encrypted (Noise_IK + MessagePack)
- Sandbox profiles enforce filesystem, network, and exec boundaries
- Encrypted secrets vault (Argon2id key derivation)
- Audit trail with append-only logging and search
- Path traversal protection on all user-supplied identifiers

See [SECURITY.md](https://github.com/tpsdev-ai/cli/blob/main/SECURITY.md) for responsible disclosure.

## Links

- [GitHub](https://github.com/tpsdev-ai/cli)
- [Runtime Library](https://www.npmjs.com/package/@tpsdev-ai/agent)
- [Contributing](https://github.com/tpsdev-ai/cli/blob/main/CONTRIBUTING.md)

## License

Apache-2.0
