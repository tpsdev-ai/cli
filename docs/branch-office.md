# Branch Office — remote agents on the TPS bus

A **branch office** is a remote machine running an agent identity that participates in the TPS mail bus as if it were local. The host (your workstation) maintains a persistent encrypted channel to each branch; mail addressed to `tps mail send <branch-agent>` is delivered over that channel and stored in the branch's local maildir.

This doc covers the relay model — a TPS-native CLI daemon paired over Noise IK + WebSocket transport, typically reached through an SSH tunnel. (The Docker-sandbox office model used by `tps office start <agent>` is documented in [commands.md](commands.md).)

## When to use a branch office

| Scenario | Why a branch office helps |
|---|---|
| You want an agent to run on a separate VM/box (different OS, different network, dedicated GPU) | Agent runs there with its own identity; host mails it the work; replies come back |
| You can't or don't want to keep an agent process running on your workstation | Branch office is the operational home for the agent; host stays light |
| You need a clean filesystem boundary between agents | Each branch is a separate machine — no shared `~` |
| The agent needs cloud LLM access without sharing your local API keys | Run on an exe.dev VM and use [the gateway](https://exe.dev/docs/shelley/llm-gateway) — VM-authenticated, no key plumbing |

If the agent is short-lived and just needs filesystem isolation, prefer `tps office start <agent>` (Docker sandbox). The branch office described here is for **persistent remote agents** with their own home dir, network, and process lifecycle.

## Architecture

```
┌──────────────────┐                              ┌──────────────────┐
│  host (rockit)   │                              │  branch (exe.dev VM) │
│                  │                              │                      │
│  tps office       │   SSH tunnel                │  tps branch          │
│  connect <name>  ├───-L <p>:127.0.0.1:<p>──────►│  start (listens     │
│  (KeepAlive)     │   (encrypted by SSH)         │   on 127.0.0.1:<p>) │
│                  │                              │                      │
│                  │   Inside the SSH tunnel:     │                      │
│                  │   WebSocket + Noise IK       │                      │
│                  │   handshake (E2E             │                      │
│                  │   encrypted on top of SSH)   │                      │
│                  │                              │                      │
│  ~/.tps/mail/   │                              │  ~/.tps/mail/        │
│  flint/, etc.    │                              │  <agentId>/          │
└──────────────────┘                              └──────────────────┘
```

The transport is **defense-in-depth-encrypted**: Noise IK protects the WebSocket payload regardless of whether the underlying TCP is SSH-tunneled, public internet, or a LAN. The SSH tunnel is operational convenience — it gives you a stable `localhost:<port>` to point at instead of exposing the branch's listener directly to the network.

## Provisioning a new branch office

This recipe was validated end-to-end on `tps-reed.exe.xyz` (an exe.dev Ubuntu VM) 2026-05-16. The branch alias on the host is `reed`; the local agent identity on the branch is also `reed`.

### 1. VM-side prereqs

Install Node 22+ and Bun, then `tps`:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
curl -fsSL https://bun.sh/install | bash
sudo npm install -g @tpsdev-ai/cli
```

> **Known issue on Linux**: the `@tpsdev-ai/cli-linux-x64` standalone binary (bundled as an optional dep) currently ships without a working `sodium-native` prebuild and crashes any command that touches branch crypto. Until that's fixed upstream, run `tps` from source:
> ```sh
> mkdir -p ~/src && cd ~/src
> git clone --depth 1 https://github.com/tpsdev-ai/cli.git
> cd cli && bun install
> mkdir -p ~/bin && cat > ~/bin/tps <<'EOF'
> #!/bin/sh
> exec ~/.bun/bin/bun run ~/src/cli/packages/cli/bin/tps.ts "$@"
> EOF
> chmod +x ~/bin/tps
> # Add ~/bin to PATH ahead of /usr/bin
> ```

### 2. Initialize the branch

Pick a free port (the example uses `33744`) and assign the agent identity:

```sh
tps branch init \
  --listen 33744 \
  --host localhost \
  --transport ws \
  --agent reed \
  --nonono
```

What this does:
- Generates a fresh branch keypair under `~/.tps/identity/`.
- Writes `~/.tps/branch.conf.json` with the listen port, advertised host, transport, and `agentId`.
- Listens on `0.0.0.0:33744` for an incoming join handshake.
- Prints a `tps://join?…` token. **Keep the listener running** while you complete step 3.

The `--agent reed` flag is the load-bearing piece for maildir consistency: without it, the branch daemon falls back to `hostname()` and produces a `tps-reed/` vs `reed/` split on the maildir (see [Troubleshooting](#troubleshooting)).

### 3. Open the SSH tunnel and join, on the host

On the host machine:

```sh
# Open a persistent SSH tunnel from host to branch on the same port:
ssh -fN -o ExitOnForwardFailure=yes -L 33744:127.0.0.1:33744 tps-reed

# Then, while the branch's `tps branch init` is still listening, complete the join:
tps office join reed "tps://join?host=localhost&port=33744&transport=ws&pubkey=…&sigpubkey=…&fp=sha256:…"
```

Output should be:
```
Connecting to localhost:33744…
Noise_IK handshake OK — branch fingerprint verified: sha256:…
Branch 'reed' registered.
Host pubkey sent to branch.
```

The `host=localhost` in the join token is what the host will use as its connect target — the SSH tunnel is what makes `localhost:33744` actually reach the branch. The host persists the pairing under `~/.tps/branch-office/reed/remote.json` and the branch persists the host record under `~/.tps/identity/host.json`.

### 4. Start the branch daemon (long-running)

Back on the branch VM:

```sh
nohup tps branch start --nonono > /tmp/branch-start.log 2>&1 &
```

For production, supervise it. On Linux with systemd (root-installed):

```ini
# /etc/systemd/system/tps-branch.service
[Unit]
Description=TPS branch office daemon
After=network-online.target

[Service]
Type=simple
User=exedev
ExecStart=/home/exedev/bin/tps branch start --nonono
Restart=always
RestartSec=10
Environment=HOME=/home/exedev
Environment=PATH=/home/exedev/bin:/home/exedev/.bun/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
```

### 5. Persistent host-side connections (launchd or systemd)

On macOS, install two LaunchAgents to keep the SSH tunnel and the office-connect daemon alive across reboots:

```xml
<!-- ~/Library/LaunchAgents/ai.tpsdev.tunnel-tps-reed.plist -->
<key>ProgramArguments</key>
<array>
  <string>/usr/bin/ssh</string>
  <string>-N</string>
  <string>-o</string><string>ServerAliveInterval=30</string>
  <string>-o</string><string>ServerAliveCountMax=3</string>
  <string>-o</string><string>ExitOnForwardFailure=yes</string>
  <string>-L</string><string>33744:127.0.0.1:33744</string>
  <string>tps-reed</string>
</array>
<key>KeepAlive</key><true/>
```

```xml
<!-- ~/Library/LaunchAgents/ai.tpsdev.office-tps-reed.plist -->
<key>ProgramArguments</key>
<array>
  <string>/path/to/bun</string>
  <string>run</string>
  <string>/path/to/tps.js</string>
  <string>office</string>
  <string>connect</string>
  <string>reed</string>
</array>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/Users/you/.tps/logs/office-tps-reed.log</string>
<key>StandardErrorPath</key><string>/Users/you/.tps/logs/office-tps-reed.log</string>
```

Then `launchctl load` both. `tps office connect` itself writes to stdout/stderr; the `StandardOutPath` keys above are what materialize it as `~/.tps/logs/office-tps-reed.log`. Connection state (last heartbeat, reconnect count, messages sent/received) is written by the daemon to `~/.tps/connections/reed.json`.

### 6. Verify round-trip mail

From the host:
```sh
tps mail send reed "PING from host"
```

On the branch:
```sh
tps mail check reed   # if --agent reed was set during init
```

The reply path:
```sh
# From the branch:
TPS_AGENT_ID=reed tps mail send flint "PONG from branch"
# From the host:
tps mail check flint
```

The branch daemon log (`~/.tps/branch.log`) shows `MAIL: Received message for reed` and `SYNC: Heartbeat received — drained outbox` events.

## Operational commands

### On the branch

| Command | Purpose |
|---|---|
| `tps branch init [--listen <port>] [--host <hostname>] [--transport ws\|tcp] [--agent <id>] [--force]` | Generate keys, persist conf, wait for host join. `--force` to re-initialize. |
| `tps branch start` | Run the long-lived listener daemon. Reads `~/.tps/branch.conf.json`. |
| `tps branch stop` | Stop the daemon. |
| `tps branch status` | Report daemon state, listen address, paired host fingerprint. |
| `tps branch log [--lines N] [--follow]` | Tail `~/.tps/branch.log`. |

### On the host

| Command | Purpose |
|---|---|
| `tps office join <name> <join-token>` | Register a remote branch using the token printed by `tps branch init`. |
| `tps office connect <name>` | Long-running connection to a joined branch. Use under launchd/systemd KeepAlive. |
| `tps office list` | List registered branches and their workspace state. |
| `tps office status [name]` | Report current connection health, message counters. |
| `tps office sync <name>` | One-shot connect+drain — useful for catch-up after a long outage. |
| `tps office revoke <name>` | Drop the branch from the registry. Does not remove launchd/systemd units. |

## Troubleshooting

### Branch daemon crashed silently mid-traffic

**Symptom:** Mail to a branch stops being delivered. `~/.tps/connections/<name>.json` heartbeats stop updating. No clear error.

**Cause:** Before [cli#281](https://github.com/tpsdev-ai/cli/pull/281) (merged 2026-05-17), the outbox-drain loop could race with concurrent writers, hit a partial JSON file, and throw. The unhandled exception killed the daemon. Fixed by atomic writes + defense-in-depth try/catch.

**Action:** Upgrade `@tpsdev-ai/cli` to the latest. If the daemon is already down, `tps branch start` again drains the outbox cleanly.

### Mail addressed to `<branch-alias>` lands in `~/.tps/mail/<hostname>/` instead

**Symptom:** First message to a freshly-paired branch lands at e.g. `~/.tps/mail/tps-reed/` while subsequent messages land at `~/.tps/mail/reed/`. Mail-consuming watcher sees only half.

**Cause:** Without `--agent <id>` at init, `localAgentId` falls back to `hostname()`. The branch daemon's mail handler uses `inboxExists(body.to) ? body.to : localAgentId` — so the first message gets the fallback, subsequent ones route to the existing maildir.

**Action:** Either (a) re-init with `tps branch init --agent <id> --force`, or (b) patch the conf in place:
```sh
jq '. + {agentId: "reed"}' ~/.tps/branch.conf.json > /tmp/c.json \
  && mv /tmp/c.json ~/.tps/branch.conf.json
tps branch stop && tps branch start
```
Then `mv ~/.tps/mail/<hostname>/cur/* ~/.tps/mail/<agentId>/cur/` to consolidate any stranded messages.

### Linux `tps` errors with `Cannot find addon '.' imported from … sodium-native/binding.js`

**Cause:** The `@tpsdev-ai/cli-linux-x64` standalone binary is missing its sodium-native prebuild ([tracked upstream](https://github.com/tpsdev-ai/cli/issues)). The Bun `--compile` step doesn't bundle the .node addon alongside.

**Action:** Run `tps` from cloned source via a shim, per the prereqs in [Provisioning](#1-vm-side-prereqs).

### `tps office join` says "Connecting to localhost:<port>…" then times out

**Cause:** The SSH tunnel isn't up, or the branch isn't listening yet.

**Action:** Verify in order:
1. `nc -z localhost <port>` from the host succeeds.
2. `ps -ef | grep "ssh.*-L <port>"` shows the tunnel process.
3. The branch's `tps branch init` is still running (`Waiting for host to connect…`).

If step 1 fails, restart the SSH tunnel. If step 3 has timed out (after ~2 minutes), re-run `tps branch init --force` on the branch.

### `office connect` reconnects in a loop

Look at `~/.tps/logs/office-<name>.log`. Common causes:
- SSH tunnel flapping (look at `~/.tps/logs/tunnel-<name>.log` for `Connection reset` or `Broken pipe`).
- Branch daemon crashed (see above).
- Fingerprint mismatch — branch identity rotated without re-join. `tps office revoke <name>` then `tps office join <name> <new-token>`.

## Security model

- **Branch identity** is a long-lived keypair (Ed25519 for signing + X25519 for encryption) generated by `tps branch init` and stored under `~/.tps/identity/` on the branch. Persisted across daemon restarts.
- **Host identity** is similarly long-lived (Ed25519 + X25519) on the host and stored under `~/.tps/identity/` on the host.
- **Pairing** uses Noise IK: the host pre-knows the branch's static encryption key (from the join token's fingerprint), and the branch learns the host's static key in the first round-trip. Any future reconnect verifies both.
- **Trust radius**: the SSH tunnel is operational, not a trust boundary. Compromise of the SSH key does **not** compromise mail content — the Noise IK channel inside the tunnel is independently encrypted.
- **Mail content is at rest in plaintext** on both sides (`~/.tps/mail/<agent>/`). Treat those directories as you would `~/.ssh/`: mode-700, owned by the agent's user.
- **Replay & forgery** are protected by the Noise IK per-message AEAD; outside the channel, the maildir filenames include the issuing UUID and timestamp so duplicates are detectable.

## See also

- [`docs/commands.md`](commands.md) — full TPS CLI surface
- [`docs/architecture.md`](architecture.md) — broader system model
- [exe.dev LLM Gateway](https://exe.dev/docs/shelley/llm-gateway) — credential-free Claude API access for branch-office agents
