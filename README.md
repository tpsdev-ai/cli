# TPS (Team Provisioning System)

> "Yeah... I'm gonna need you to go ahead and come in on Saturday. We lost some people this week and we need to sort of play catch-up."

**TPS is an Agent OS for managing isolated AI agents.** It provides the primitives for agents to exist, discover each other, communicate asynchronously, and run in sandboxed environments.

If you want your AI agents to stop stepping on each other's toes and actually get some work done, you're going to need them to file their TPS reports.

## Why TPS?

Most agent frameworks assume all agents run in the same memory space. TPS assumes agents are employees: they work in different offices, they have different security clearances, and they communicate via mail.

> "I have eight different bosses right now. So that means that when I make a mistake, I have eight different people coming by to tell me about it." — Make your agents communicate through a single, auditable mail interface instead.

### What You Get

- **Identity & Keys** — Ed25519 keypairs per agent. Agents prove who they are cryptographically, not by env var.
- **Branch Offices** — Docker containers with four layers of isolation: Docker → Linux users → [nono](https://github.com/lukehinds/nono) Landlock → BoundaryManager
- **The Mailroom** — Async, persistent, cross-boundary Maildir-based messaging with pub/sub topics
- **Agent Runtime** — Native runtime with tool use, multi-provider LLM support, and session management
- **CLI Runtime Providers** — Plug in coding CLIs (Claude Code, Codex, Gemini CLI) as agent runtimes via OAuth — no API keys needed
- **Flair Integration** — [Flair](https://github.com/tpsdev-ai/flair) provides persistent identity, soul, and memory backed by HarperDB
- **TPS Reports** — YAML-based agent configuration — identity, capabilities, LLM provider, tools

## Quickstart

```bash
# Install
npm install -g @tpsdev-ai/cli

# Create an agent
tps agent create my-agent

# Verify
tps --help
tps roster list
```

### Run an agent locally

```bash
# Create an agent config
mkdir -p my-agent/.tps
cat > my-agent/.tps/agent.yaml << 'EOF'
id: my-agent
name: MyAgent
workspace: ./my-agent
systemPrompt: "You are a helpful assistant. Use your tools to complete tasks."
tools: [read, write, edit, exec, mail]
maxTurns: 8
llm:
  provider: ollama          # or: anthropic, openai, google
  model: qwen3:8b
  baseUrl: http://localhost:11434
EOF

# Run a one-shot task
tps agent run --config my-agent/.tps/agent.yaml \
  --message "Write a hello.txt file with a greeting"

# Or start as a daemon (waits for mail)
tps agent start --config my-agent/.tps/agent.yaml
```

### Run with a CLI runtime

```bash
# Uses OAuth — no API key needed. Supports: claude-code, codex, gemini-cli
tps agent run --config my-agent/.tps/agent.yaml \
  --runtime claude-code \
  --message "Implement the feature described in TASK.md"
```

CLI runtimes stream output in real-time, auto-commit on turn limits, write task memories to Flair, and catch up on missed pub/sub messages at boot. Claude Code is shipped; Codex and Gemini CLI are planned.

### Run agents in a Docker office

```bash
# Start an office for an agent
ANTHROPIC_API_KEY=sk-... tps office start my-agent

# Check status
tps office status my-agent
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Host Machine                                       │
│                                                     │
│  tps identity    ← Ed25519 keys, vault, agent IDs   │
│  tps mail        ← Maildir messaging + pub/sub      │
│  tps agent       ← Runtime (native / claude-code)   │
│  tps flair       ← Identity & memory service         │
│  tps office      ← Docker isolation                  │
│                                                     │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │  Agent Office     │  │  Flair (HarperDB)        │ │
│  │  Docker + nono    │  │  Soul, Memory, Learning  │ │
│  │  Per-agent UIDs   │  │  Vector search, HNSW     │ │
│  │  Landlock sandbox │  │  Ed25519 auth             │ │
│  └──────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Mail & Pub/Sub

Agents communicate asynchronously via Maildir + topic-based pub/sub:

```bash
# Direct messaging
tps mail send coder "Review the PR and fix any issues"
tps mail check                    # Read new messages

# Pub/sub topics
tps mail topic create pr-reviews --desc "PR approval notifications"
tps mail subscribe pr-reviews
tps mail publish pr-reviews "PR #42 approved — ready to merge"
```

Messages fan out to all subscribers. Agents catch up on missed messages at boot via cursor-based replay. Delivery is idempotent.

### Identity

Every agent gets an Ed25519 keypair at creation. Keys never leave the host — agents prove identity through signatures, not shared secrets.

```bash
tps identity show              # Show host identity
tps identity show --agent ember  # Show agent identity
```

### Flair (Memory & Soul)

[Flair](https://github.com/tpsdev-ai/flair) is the persistence layer. Agents load their soul (personality, role, mission) and memories from Flair at startup. Task completions and failures are written back automatically.

```bash
tps flair status               # Check Flair health
tps soul show                  # Show agent's soul
tps memory list                # List memories
tps memory write "Learned that X causes Y"
```

## Agent Runtime

The native runtime provides:

- **5 built-in tools**: `read`, `write`, `edit`, `exec`, `mail`
- **4 LLM providers**: Anthropic, OpenAI, Google, Ollama
- **Tool-use loop**: Task → LLM → tools → result
- **Daemon mode**: Watches mailbox for incoming tasks
- **Graceful turn limits**: Auto-commits WIP and notifies supervisor on turn limit
- **Session storage**: JSONL conversation history

### Agent Config (`agent.yaml`)

```yaml
id: coder
name: Coder
workspace: /workspace/coder
systemPrompt: "You are a coding agent."
tools: [read, write, edit, exec, mail]
maxTurns: 8
llm:
  provider: anthropic
  model: claude-sonnet-4-20250514
  apiKey: ${ANTHROPIC_API_KEY}    # env var interpolation
flair:
  url: http://localhost:9926      # optional — enables soul & memory
```

## Docker Office Architecture

Each office is a Docker container running agents with layered isolation:

```
┌─────────────────────────────────────────────┐
│  Docker Container                           │
│  ┌──────────────────┐ ┌──────────────────┐  │
│  │ agent-lead       │ │ agent-coder      │  │
│  │ UID 1001         │ │ UID 1002         │  │
│  │ nono Landlock    │ │ nono Landlock    │  │
│  │ /workspace/lead  │ │ /workspace/coder │  │
│  └──────────────────┘ └──────────────────┘  │
│                                             │
│  tps-office-supervisor (PID 1)              │
│  · Creates per-agent Linux users            │
│  · Starts each agent under nono sandbox     │
│  · Drops privileges after setup             │
└─────────────────────────────────────────────┘
```

## Commands

```
tps agent create <id>          Create a new agent with identity
tps agent run --config <yaml>  One-shot agent task
tps agent start --config <yaml> Start agent daemon
tps office start <agent>       Start a Docker office
tps office stop <agent>        Stop an office
tps mail send <agent> <msg>    Send mail
tps mail check                 Read new messages
tps mail topic create <name>   Create pub/sub topic
tps mail publish <topic> <msg> Publish to topic
tps identity show              Show identity
tps flair status               Check Flair connection
tps soul show                  Show agent soul
tps memory list                List memories
tps roster list                List configured agents
tps status                     System status
```

## Development

```bash
git clone https://github.com/tpsdev-ai/cli.git
cd cli
bun install
bun run build
bun test        # 430+ tests
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
