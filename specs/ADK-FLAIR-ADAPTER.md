# adk-flair — Flair as the memory backend for Google ADK (ops-gbsy)

**Status: DESIGN APPROVED — Kern APPROVE (verdict held through compound-tag pivot), Sherlock APPROVE on re-review (STOP lifted), 2026-08-05 17:40Z.** Cleared for implementation; repo creation awaits PAT rotation.
**Bead:** ops-gbsy · **Owner:** Flint (spec) · implementer TBD after design review
**Research base:** google/adk-python v2.6.2 (clone-verified 2026-08-05), OpenMemory precedent (adk-python#3387 → community#20), Memory Bank ADK quickstart.

## Why (positioning, one paragraph)

Vertex AI Memory Bank is the managed `memory.load(userId)` — the assumption we
position against. ADK's memory layer is a **designed third-party seam**
(`BaseMemoryService` + a documented `services.py`/`services.yaml` scheme
registry), and Google's maintainers have ruled that non-Google backends live
outside core (OpenMemory's core PR was closed with "move to community repo").
An `adk-flair` package makes the pitch concrete: run your agent on Google's
stack, keep your memory yours — self-hosted, federated, portable to your
non-ADK agents. Their consolidation runs server-side in Memory Bank; ours runs
in the user's own memory (REM nightly). Consolidation belongs to the memory,
not the vendor.

## Scenarios (design targets)

1. **Quickstart parity:** a dev on the Memory Bank ADK quickstart swaps ONLY
   step 2 (provision) and step 6 (`FlairMemoryService(...)` instead of
   `VertexAiMemoryBankService(...)`). Steps 3–5, 7 unchanged. Cross-session
   recall works on the second session.
2. **CLI/dev-UI path:** `adk web --memory_service_uri="flair://localhost:9926"`
   works via the documented registry (`services.py` registering the `flair://`
   scheme). The dev UI's `PATCH .../memory` ingestion endpoint works unchanged.
3. **Flair unreachable:** ADK swallows `search_memory` exceptions on the
   every-turn path (PreloadMemoryTool) — failure is *silent recall loss by
   ADK's design*. The adapter must therefore fail FAST (connect/read timeout
   ~2s total, one attempt, no retry storm on the turn path) and log one
   structured warning naming host + remedy. A hung Flair must never add
   seconds to every turn.
4. **Portability proof (the demo):** a memory written via an ADK session is
   readable outside ADK with no export step — the flair CLI authenticating
   **as the same app principal** (`FLAIR_AGENT_ID=<app agent>`) searches and
   finds it. (Kern's catch: with `private` visibility, cross-AGENT reads
   don't happen — so the demo is honestly framed as "your app's memory,
   inspectable by you from any tool," same principal, not cross-agent magic.
   True cross-agent sharing is Flair visibility/org semantics — phase 2.)
5. **Eval:** `LocalEvalService(memory_service=FlairMemoryService(...))` runs
   `adk eval` unchanged (ADK's eval harness accepts an injected service).

## Design

**Package:** `packages/adk-flair` in the flair monorepo — the established home
of every adapter (langgraph-flair, pi-flair, n8n-nodes-flair, hermes-flair,
openclaw-flair all live there; langgraph-flair is the Python/pip precedent).
Published to PyPI as `adk-flair`. Depends on `google-adk` + `httpx`. No new
repo (corrected 2026-08-05 — Nathan's catch; the standalone-repo idea was
OpenMemory's shape, not ours). Phase 2 (separate decision): PR the same class
into `google/adk-python-community` for discoverability — never a fork, never
a core PR (maintainer policy, verified).

**Class:** `FlairMemoryService(BaseMemoryService)` implementing all four
methods (two required + two optional):

| ADK call | Flair mapping |
|---|---|
| `add_session_to_memory(session)` | batch-write session events (filter no-text events, as Vertex impl does) |
| `add_events_to_memory(app_name, user_id, events, …)` | incremental per-turn writes (the quickstart's `after_agent_callback` path) |
| `add_memory(app_name, user_id, memories, …)` | direct `POST /Memory` writes |
| `search_memory(app_name, user_id, query)` | Flair semantic search; map hits → `MemoryEntry(content=text, timestamp=ISO 8601, author=record author)` |

Empty result list is valid and common — return it, never raise, on 0 hits.
No consolidation logic in the adapter: Flair REM owns it (positioning point,
and it keeps the adapter ~small).

**Scope mapping (K&S both re-derived; verdict: right trade, wrong mechanism as
first drafted — fixed here):**
The ADK contract scopes everything by `{app_name, user_id}`. Flair's model is
agentId-keyed. The ADK app authenticates as ONE Flair agent (its service
identity); per-user principals rejected by both reviewers (key sprawl at user
cardinality — the agent table is an org directory, not a user database; no
offline story; and it's the same trust-boundary choice Vertex Memory Bank
itself makes: one agent_engine_id, user_id as scoping data).

**Mechanism (Sherlock's STOP, resolved):** Flair's Memory schema has NO
`app_name`/`user_id` fields, and search filters exist for **tags and subject
only** — so "structured metadata filtering" as first written required server
changes this spec forbids. Adopted: a **single compound tag** —
`adk:<app_name>:<user_id>` on every record, filtered on every search.
Compound, not two tags, for two verified reasons: `POST /SemanticSearch`
accepts exactly ONE `tag` string, and a per-user compound tag is selective by
construction, which matters below. Rules that make it defensible:
- `user_id` is **mandatory** in the search path — missing/empty ⇒ return
  empty, never search unscoped (Kern). It comes from ADK's session context,
  never from caller-supplied input (Sherlock's forgeability question:
  framework-derived, and the adapter exposes no way to override it).
- **Verification gate: CLOSED (source-read of Flair + pinned harper 5.1.22).**
  Flair never tag-filters in JS after ranking — the tag rides inside the
  engine query on every retrieval leg. But Harper's cost planner decides the
  driver per query: a **selective** tag wins the planner race, drives the
  index seek, and yields exact cosine ordering over exactly the tag-matching
  set (true pre-filter, exhaustive). A **non-selective** tag loses to the
  HNSW pseudo-condition and degrades to engine-level post-filtering over a
  global ≤512-candidate set — other users' records transit that in-memory
  candidate set before the condition drops them, and result starvation is
  possible (hybrid's BM25 leg, which pre-filters exhaustively, mitigates).
  Consequences adopted: (1) the compound per-user tag keeps multi-user
  corpora in the selective regime; (2) **the adapter re-verifies the
  compound tag on EVERY hit before mapping it out** — the client-side
  analogue of Flair's own `isAllowed` defense-in-depth, killing the
  one-bug-away class at the adapter boundary for ~zero cost; (3) the
  integration test asserts via Harper's `explain` support that the tag
  drives the plan on a representative multi-user corpus — the check can
  fire, not just a comment. Note: MCP `memory_search` exposes no tag
  parameter at all — the adapter speaks REST `POST /SemanticSearch`
  directly, never the MCP tool.
- README Security section, verbatim commitment: "All users of one ADK app
  share one Flair principal. Per-user isolation is enforced by tag-based
  server-side filtering, not cryptographic key separation. A bug in that
  filter would leak cross-user memories. For key-level isolation, use
  per-org Flair principals (the org layer)."

**Auth & config:** env-first, no secrets in code or YAML:
`FLAIR_URL` (or the `flair://host:port` URI), `FLAIR_AGENT_ID`,
`FLAIR_KEYFILE` (path to Ed25519 key; value never read into config, never
logged). Constructor contract (Sherlock): missing config ⇒ ValueError naming
the VARIABLE; keyfile present but invalid ⇒ **parse and validate the key
material in the ctor** and raise — deferring the parse to first use lands the
failure inside ADK's exception-swallowing path as permanent silent empty
recall. Error messages name variables, never filesystem paths.

**Wrong-URL protection (Sherlock: "loud README language is documentation,
not a control"):** a typo'd `FLAIR_URL` ships every user query to a stranger,
every turn, silently. Controls, safe-path-easy-path ordered: (1) localhost /
127.0.0.1 / ::1 targets construct freely — the common self-hosted case has
zero friction; (2) any NON-local host refuses to construct unless
`FLAIR_ALLOW_REMOTE_URL=1` is set, the error naming the exact URL it refused
— pointing at remote infra becomes a deliberate act (this replaces Sherlock's
confirm-everything interlock: same protection, no tax on the default case);
(3) the resolved URL is logged once at WARNING on first request either way.
README warning stays, as backup.

**Timeouts & failure visibility (Kern + Sherlock, merged):** search path
budget 2s TOTAL covering the full lifecycle including DNS —
`httpx.Timeout(connect=0.5, read=1.5, write=1.0, pool=0.5)`; one attempt, no
retry on the turn path. The swallowed-exception warning includes host,
elapsed_ms, and which phase died (connect vs read). **Write paths too**
(Sherlock): `add_session_to_memory`/`add_events_to_memory` failures log a
structured warning (session id, event count, HTTP status) — silently lost
memories are the write-side twin of silent recall loss.

**Idempotent writes (Kern, both replies converged):** deterministic record id
`${app_name}:${user_id}:${session_id}:${event.id}` — re-ingestion upserts the
same record, statelessly. REM consolidates content; it never sees duplicates.
**`custom_metadata`:** never silently dropped — unsupported keys log
"custom_metadata ignored by adk-flair" once per session (a user setting
TTL must not believe it worked).

**MemoryEntry mapping (Kern):** `MemoryEntry.content` is
`google.genai.types.Content`, not a string — the adapter constructs
`types.Content(parts=[types.Part(text=<flair hit text>)])` per hit, with
`author` and ISO `timestamp` carried from the record. Spelled out here so the
implementer doesn't discover it at the type checker.

**Verification (before done):**
- Unit tests mirroring ADK's own patterns (mock backend; assert scope
  propagation, event filtering, MemoryEntry mapping, ISO timestamps).
- Behavioral: Flair-down ⇒ fast empty + one warning (test asserts elapsed
  time < timeout budget — the guard must demonstrably fire); 0-hit search ⇒
  empty response, no exception.
- Scenario 4 as an integration test against a real local Flair.
- Quickstart-parity doc tested by actually running the swapped quickstart.

## Explicitly out of scope (phase 1)

`retrieve_profiles` parity, TTL/revision semantics, community-repo PR,
Long Horizon-specific wiring (repo not yet located — the seam covers it
regardless), per-user Flair principals, any Flair server changes.

## Formerly-open questions — ALL RESOLVED by K&S review (2026-08-05)

1. Scope mapping: compound-tag mechanism under one principal — approved by
   both reviewers; README security language mandated above.
2. Timeout: 2s total, split connect 0.5 / read 1.5, full lifecycle incl. DNS.
3. Re-ingestion: stateless idempotency via deterministic record ids
   (`${app}:${user}:${session}:${event.id}`); REM consolidates content, never
   sees duplicates.

## Implementation notes from final review (Sherlock)

- **Sanitize `user_id` (and `app_name`) before compounding**: a value
  containing `:` breaks the tag delimiter (`user_id="org:admin"` →
  four-segment tag). Encode or replace colons; document the rule in README.
- The free-construct localhost set includes bracketed IPv6: `[::1]`.
- Hardening follow-up (phase 2, not a gate): `FLAIR_ALLOW_REMOTE_URL=<exact
  URL>` compared against the resolved URL, instead of `=1` — kills the
  "set the flag, then typo'd the URL" mode.

---

## TypeScript adapter addendum (2026-08-06, seam verified against adk-js v1.6.0)

Everything above ports except as noted. Source-verified facts: `@google/adk`
(github.com/google/adk-js) defines `BaseMemoryService` as a two-method TS
interface (`addSessionToMemory`, `searchMemory`) — stable since inception;
`PreloadMemoryTool` behaves like Python's (every-turn, exception-swallowing,
`parts[0].text` query, text-only injection); `Runner({memoryService})` and
`AdkApiServerOptions.memoryService` accept third-party implementations with
zero forking.

**Package:** `packages/adk-flair-js` in the flair monorepo, npm name
`@tpsdev-ai/adk-flair`. Being a normal npm workspace package, it rides the
release train — Nathan's minor-match policy costs nothing here; version
alignment is automatic.

**Deltas from the Python design:**
1. **Registration story changes** — adk-js has NO memory URI registry (its
   session/artifact URI resolvers are closed if-chains; no memory flag on the
   dev CLI at all). Ship: exported `FlairMemoryService` class + README showing
   `new Runner({ memoryService })` and a ~10-line `AdkApiServer` wrapper entry
   for dev-UI use. No `flair://` scheme.
2. **Interface surface is exactly two methods** — `addEventsToMemory`/
   `addMemory` may exist as extra methods (Vertex parity) but nothing in ADK
   calls them; document that.
3. **Timestamp units:** adk-js `Event.timestamp` is epoch MILLISECONDS
   (Python: seconds). `MemoryEntry.timestamp` out is an ISO string. Do not
   port Python's seconds assumption.
4. Everything else ports verbatim: compound tag `adk:<app>:<user>` with colon
   sanitization, mandatory-userId-or-empty, per-hit tag re-verification,
   timeout budget (2s lifecycle: connect 0.5/read 1.5), localhost-free /
   `FLAIR_ALLOW_REMOTE_URL=1` gate, key parse-and-validate in ctor with
   variable-named errors, deterministic record ids, silent-degrade health
   warning. The 9-test integration suite is the conformance spec — the TS
   package implements the same tests (explain-plan via the same server
   support, portability, quickstart-parity with a real model).
