# TPS — Design Invariants

This is TPS's design DNA: the invariants that decide what we build and, just as
importantly, what we refuse to build — not a feature list (see [README.md](README.md))
and not an architecture reference (see [docs/architecture.md](docs/architecture.md)). If
you're adopting TPS, extending it, or wondering why it works a certain way, this is the
page that answers "why," not "what."

TPS exists to let a fleet of agents — on your workstation, in a Docker sandbox, on a
remote VM — coordinate without stepping on each other or on you. Every invariant below is
in service of that: agents you can trust because their actions are provably theirs,
infrastructure that recovers instead of quietly rotting, and a unit of work small enough
to review honestly.

## Signed everything

Every agent identity in TPS is an Ed25519 keypair, generated on the machine it belongs
to and never exported. Mail envelopes are signed. Branch Office pairing is a mutual
Noise_IK handshake between static keys, not a shared secret or a bearer token. When a
Branch relays mail back through the Host, the relay overwrites the `from` field with the
verified sender identity rather than trusting whatever the message claims — a compromised
Branch can flood or misbehave, but it cannot forge who it is.

This is the same principle applied consistently everywhere in the system: trust flows
from **verified provenance** — a signature that checks out, a handshake that completed —
never from "who claims what." An agent proves itself cryptographically or it doesn't get
to act as itself. There is no middle tier of "probably fine, no key required."

## Self-healing over keepalive

A stuck mail consumer, a stale watcher, a failed delivery — these are expected failure
modes in a system with this many moving daemons, not exceptions. The invariant is that
the system detects and recovers from them **itself**, and does so loudly: an alert plus a
recurrence count, so a restart never quietly papers over a root cause that's getting
worse each time it fires.

A `KeepAlive: true` plist entry that respawns a crashed process is not the same thing as
self-healing — it hides the failure instead of surfacing it. The bar is higher: watchers
that notice their own staleness and kick themselves, daemons that drain a backlog on
reconnect instead of losing it, connection state that's inspectable so "is this actually
healthy" is a `status` command, not a guess. A fix that needs a human to notice something
is broken before it can be applied isn't done — it's deferred, and deferred failures in
an agent fleet compound.

## Idempotent + verifiable

Every action in TPS is safe to retry. Mail delivery is deduplicated and replay-safe —
messages carry an issuing UUID and timestamp, subscribers catch up via cursor-based
replay, and re-running a drain doesn't double-deliver. Nothing in the critical path
assumes it will only ever run once.

Retry-safety only matters if you can tell whether the retry — or the original action —
actually worked, and that confirmation has to come from a channel that can't lie. A
GitHub PR's review state, a `tps office status` health probe, an actual served response
— these are ground truth. An agent's own "done" is not: agents self-report success on
work that's stubbed, partial, or silently failed, and a design that takes a self-report
at face value is building on sand. Verification through an independent channel is not an
optional nicety layered on top of the CLI — it's the property that makes autonomy safe to
extend in the first place.

## The dispatch → review → merge loop is the unit of work

Work moves through TPS as: one task, dispatched with everything the recipient needs to
execute it (a spec, a branch, an output contract) — never a vague pointer requiring
back-and-forth to clarify. The agent does the work and opens a PR; it does not merge its
own change. An independent review — architecture on one lane, security on another — is
the gate, not a courtesy step. Only a change that clears CI and clears review merges.

This loop is deliberately small and deliberately serial: one task in flight per agent,
not a queue of half-started work. The unit of work is the whole loop, not the code —
a task without its review isn't finished, it's paused mid-flight, and pretending
otherwise is how unreviewed shortcuts accumulate in a fleet no single human is reading
line-by-line.

## Trust boundaries

TPS draws one hard line: the **Host** (where your identity, mail, and context live) and
everything else. A Branch Office — Docker sandbox or remote VM — is untrusted by design,
even though it's running your own agent. Three rules enforce that boundary, and they are
non-negotiable regardless of what's convenient at the call site:

- **Never expose the Host's private key.** It is generated once, lives only on the Host,
  and every cross-boundary interaction is a signature or a handshake, never a
  key handoff.
- **Always validate input at the boundary.** Every message crossing from a Branch into
  the Host's mail relay passes a validation gate — identity is overwritten to the
  verified sender, origin is stamped, size and quota are enforced — before it's ever
  written to a recipient's inbox. Nothing from an untrusted side is trusted just because
  it parsed as JSON.
- **Fail closed.** An authentication failure, a permission error, a malformed
  cross-boundary message — any of these abort the operation. TPS never falls back to an
  unauthenticated or partially-validated path to keep something moving; a blocked
  action is recoverable, a silently-downgraded trust boundary is not.

A Branch has no direct access to the Host's filesystem, its `~/.tps/context`, or another
agent's mail — the Mail Bridge is the only door, and it's the door these three rules
guard.
