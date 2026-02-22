# TPS (Team Provisioning System)

> "Yeah... I'm gonna need you to go ahead and come in on Saturday. We lost some people this week and we need to sort of play catch-up."

**TPS is an Agent OS CLI for managing isolated AI agents in remote branch offices.** It provides the secure primitives for agents to exist, discover each other, communicate asynchronously, and run in isolated environments (Docker sandboxes or remote VMs).

If you want your AI agents to stop stepping on each other's toes and actually get some work done, you're going to need them to file their TPS reports.

![Lumbergh Agent](docs/media/lumbergh-agent.png)

## Why TPS?

Most agent frameworks assume all agents run in the same memory space. TPS assumes agents are employees: they work in different offices, they have different security clearances, and they communicate via mail.

- **The Branch Office**: Agents run in secure, remote sandboxes (VMs or Docker). Host keys never leave the host.
- **The Mailroom**: Async, persistent, cross-boundary messaging.
- **Wire Security**: All traffic over `wss://` is E2E encrypted and mutually authenticated using the **Noise_IK** protocol.
- **The TPS Report**: One `tps.yaml` file defines an agent's identity, capabilities, and mail handlers.

> "I have eight different bosses right now. So that means that when I make a mistake, I have eight different people coming by to tell me about it." — Make your agents communicate through a single, auditable mail interface instead.

## Quickstart

```bash
# 1. Install
npm install -g @tpsdev-ai/cli

# 2. Init your host identity
tps identity init

# 3. Create a branch office on a remote VM
# (On the VM)
npm install -g @tpsdev-ai/cli
tps branch init --listen 6458 --host my-vm.example.com

# 4. Join the branch office
# (On your host)
tps office join my-vm "tps://join?host=my-vm.example.com..."

# 5. Connect the persistent relay
tps office connect my-vm &

# 6. Send a memo
tps mail send my-vm "Did you get the memo about the TPS reports?"

# 7. Check the branch status
tps mail send my-vm "status"
tps mail check
```

## The Three-Channel Model

Agents shouldn't do everything over a single chat thread. TPS enforces:
1. **Mail** for messages (commands, status, notifications).
2. **Git** for artifacts (code, specs, docs).
3. **APIs** for external data.

![The Mailroom](docs/media/mailroom.png)

## Plugins & Handlers

Agents can declare `mailHandlers` in their `tps.yaml` manifest. The TPS branch daemon will automatically route incoming mail to the right handler based on regex patterns or sender allowlists.

```yaml
name: deploy-bot
capabilities:
  mail_handler:
    exec: ./handler.sh
    match:
      bodyPattern: "^(deploy|status)"
```

## Architecture

Read [ARCHITECTURE.md](ARCHITECTURE.md) for details on the Noise_IK implementation, hub-and-spoke topology, and security boundaries.

## License

Apache 2.0
