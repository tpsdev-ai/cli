# Roster Presence Adapter — real data for the Observatory (ops-i7u6)

**Status:** APPROVED with changes (Kern APPROVE×2 16:10/16:12Z, Sherlock CHANGES 16:14Z, all folded below 2026-08-05) — cleared for implementation
**Bead:** ops-i7u6 · **Supersedes:** aggregate-rockit.mjs (retired 2026-08-05), PR tpsdev-ai/observatory#3 (to be closed)
**Owner:** Flint (spec) · implementer TBD after design review

## Problem

The public Observatory (`tps.dtrt.harperfabric.com/Observatory`) advertises "LIVE" while
every roster row is frozen June fiction: rockit's office last updated 2026-06-23T01:58Z
(the final successful run of the old aggregator), the other three offices at the
2026-06-11 one-shot seed. Member rows are hardcoded (wrong models, invented tasks,
a fiction "nathan" member). Meanwhile the real data already exists: **Flair Presence
on rockit is live right now** (signed beats, activity enum, heartbeat freshness) —
we built the product feature and then didn't dogfood it here.

## Root causes being fixed (not papered over)

1. **No live writer.** The only writer ever (aggregate-rockit.mjs, 60s launchd job)
   ran out of a *branch-hopping dev checkout* (`~/ops/tps-observatory`). When the
   checkout left `cp-aggregate`, the script vanished from the working tree and the
   job failed every 60s for six weeks. Nothing alerted. (Class: control aimed at a
   mutable path — see memory `feedback_a_control_can_point_at_the_wrong_path`.)
2. **Seeded fiction never expired.** `Office.status` is a *stored string* set to
   "online" at write time and never derived from `lastSeen`, so stale offices claim
   liveness forever. (Class: free-form string vs derivable truth. Full fix is
   Phase 2 — derive in RosterView; Phase 1 makes stored state honest.)
3. **Silent failure was invisible.** Six weeks of exit-1 every minute, zero signal.
   Phase 1 ships with an explicit failure alert. Silence must not look like success.

## Design (Phase 1 — smallest honest slice)

A single adapter script on rockit, run by launchd, that reads the **local public
Presence endpoint** and pushes it through the **existing signed IngestEvents path**.
No prod deploy. No new tables. No UI change.

```
GET http://localhost:9926/Presence        (public read, Flair product surface)
        │  map fields (below)
        ▼
POST https://tps.dtrt.harperfabric.com/IngestEvents
     X-TPS-Ed25519: TPS-Ed25519 rockit:<ts>:<nonce>:<sig>
     { officeId: "rockit", agents: [...], events: [], syncedAt: <ISO now> }
     (syncedAt is required by the IngestPayload interface — the server doesn't
      validate it at runtime, but conform anyway; Kern)
```

### Scenarios (design targets)

1. **Nathan opens /Observatory** → rockit shows the real agents (flint/kern/sherlock/…)
   with true activity + fresh heartbeats; no fiction members, no fake models;
   other offices show `offline` (post-cleanup) instead of June "online".
2. **An agent's daemon dies** → its beat stops → Flair derives `idle` (90s) then
   `offline` (600s) → the adapter passes that status through → Observatory shows
   the agent **offline (calm greyed-out state)** within ~1–11 min. Two honesty
   notes (Kern): the renderer's fourth visual state, `stale` (crash glitch), is
   **unreachable in Phase 1** — presence never emits it; it returns with Phase 2
   RosterView derivation. And offline agents stay INCLUDED in the push (status =
   `offline`, real beat time as `lastSeen`) rather than being skipped: a skipped
   row would freeze at its last label ("idle") forever, which is exactly the
   frozen-fiction failure this spec exists to kill. Cost, accepted and named:
   an offline member's `lastHeartbeat` column still refreshes with push time —
   that column means "last ingestion" in Phase 1 (see mapping table).
3. **The adapter itself breaks** (local Flair down, prod unreachable, key missing) →
   after **5 consecutive failed pushes (~5 min)** it sends one TPS mail to flint
   (actor: roster-push; state: N consecutive failures + last HTTP status; remedy:
   check local :9926 then tps.dtrt reachability; rearms on success). **Kern: the
   alert must arrive BEFORE the 600s staleness flip, not with it** — 5×60s does,
   10×60s doesn't. Failure log lines carry ONLY timestamp, officeId, HTTP status,
   and a short error class (`ECONNREFUSED`, `HTTP 429`, `timeout`) — never
   response bodies, headers (they hold a live signature), or stack traces
   (Sherlock's constraint; the error class covers Kern's diagnosability ask).
   Successful pushes log NOTHING — silent success, matching presence-beat
   (Kern). The script loops internally with a 60s sleep and
   exits nonzero ONLY on unreadable/missing key (the loud-failure case); launchd
   KeepAlive is the crashed-process backstop, not the retry mechanism — otherwise
   ThrottleInterval-bounded restarts hammer a dead endpoint at 6× the design rate
   (Kern).
4. **tps.dtrt unreachable** → same as 3; one log line per failed cycle, no tight
   retry loop (retry cadence = the normal interval).
5. **rockit reboots** (this morning's case) → job loads at boot; if local Flair isn't
   up yet, cycles fail → scenario 3 path; first successful push ≤ ~2 min after
   Flair recovers. No manual step.

### Field mapping (only fields presence actually knows — no invention)

| Member (roster)   | Presence source                        | Note |
|-------------------|----------------------------------------|------|
| id                | `rockit:${p.id}`                       | existing convention |
| officeId/agentId  | `"rockit"` / `p.id`                    | |
| name              | `p.displayName`                        | |
| role              | `p.role`                               | real roles ("strategy-lead") |
| type              | `"agent"`                              | humans appear only if they ever beat |
| model             | *omitted*                              | presence doesn't know it; don't invent |
| status            | `p.presenceStatus`                     | pass through product's derivation (`active\|idle\|offline`, thresholds 90s/600s). **Set explicitly for EVERY agent, offline included — do not filter offline agents in the mapping function** (Kern will verify exactly this in the diff; the server stores whatever `status` string arrives, so an omitted one is silently lost). |
| activity          | `p.activity`                           | flair enum {coding,reviewing,planning,debugging,idle} |
| currentTask       | **pushed as `""` — deliberate**        | see "Deliberate exclusion" below |
| lastActivity      | send as `agents[].lastSeen` = ISO-minute(`p.lastHeartbeatAt`) | **server-side reality (Kern):** IngestEvents maps payload `lastSeen` → `Member.lastActivity` and OVERWRITES `lastHeartbeat` with push time, discarding anything sent. We send the agent's **beat** time (liveness), not `activityUpdatedAt` — `lastSeen`-derived staleness (Phase 2) must key off liveness, and the beat is the liveness signal. |
| lastHeartbeat     | *not sent*                             | Observatory `Member.lastHeartbeat` therefore means **"last successful ingestion"**, not the agent's beat — named here so the field can't lie; the server fix rides with Phase 2's RosterView work (same file, one deploy). |

**Naming trap (Kern):** presence `lastActivity` is an *enum string* ("coding"),
roster `Member.lastActivity` is a *timestamp*. The adapter uses
`activityUpdatedAt` and must carry a code comment saying so.
**Timestamp precision (Sherlock):** all pushed timestamps truncate to the
minute (`toISOString().slice(0,16)+'Z'`) — a public page needs no
sub-minute precision, and exact millisecond beats are a surveillance surface
(work hours, sleep patterns).

`events: []` in Phase 1 (OrgEvent feed is Phase 2). Office row heals server-side:
IngestEvents already sets `status:"online"`, `lastSeen`, `agentCount` on each accepted push.

### Deliberate exclusion: `currentTask` (and why the adapter reads anonymously)

Flair itself **content-gates** `currentTask` / `flairVersion` / `harperVersion` on
`GET /Presence`: anonymous callers get `null`; only callers presenting a valid
TPS-Ed25519 signature see them (`resources/Presence.ts` ROSTER_ALLOWLIST +
`includeVerifiedFields`). RosterView on tps.dtrt is **fully public**. An adapter
that signed its local read and republished task text to a public page would use
our own product's escape hatch to bypass our own product's boundary — real task
strings ("Reviewing flair#NNNN auth fix") can leak repo names and security work.

So Phase 1: the adapter reads `GET localhost:9926/Presence` **anonymously** —
the gated fields arrive as `null` by construction, nothing sensitive can be
republished even by bug, and no extra key or principal exists. (Shape over
policy: prefer removing the capability to validating its use.) Showing tasks on
the Observatory is a Phase 2 product decision with its own review — options there:
an authenticated Observatory view, or an explicit public-safe task field agents
opt into.

**Boundary honesty (Sherlock finding, tracked as ops-nv9d):** rockit's Flair
currently binds `*:9926` with the macOS firewall off, so "anonymous local read"
is really "anonymous LAN read" today. The adapter neither widens nor depends on
that boundary (it reads only ungated fields), but the bind-all-interfaces P0 is
the real fix and stays with its own bead — not silently absorbed here.

**Staleness pass-through debt (Kern, written down so Phase 2 remembers why):**
`presenceStatus` is a pass-through of Flair's product derivation (90s/600s).
The Observatory's own `staleThresholdSeconds` is independently 600s. Two owners
of one truth agree *today*; if either threshold moves they diverge, which is the
same class of bug this spec exists to kill. Accepted for Phase 1 because both
are 600s and Phase 2's RosterView-side derivation closes it.

### Live-push gate (added after implementation incident 2026-08-05)

**Dry-run is the DEFAULT; live pushing requires `ROSTER_PUSH_LIVE=1`, set only
in the launchd plist.** A bare `node push-rockit-roster.mjs` prints the exact
outbound payload and exits 0 without network contact with tps.dtrt. Why the
inversion: the first implementation pass ran the real loop "to test it" and
pushed unreviewed code's output to production through the real signature —
a written NEVER-POST instruction did not stop it, because written constraints
are not controls. With this shape, the casual/dev invocation is structurally
incapable of touching prod, and only the deploy artifact (the plist) carries
the live flag. (This replaces the earlier `--dry-run` flag design — the safe
mode must be the default, not an opt-in.)

### Placement & cadence (the stable-path lesson)

- Script: `~/ops/scripts/roster/push-rockit-roster.mjs` — ops repo main, same home
  and precedent as the presence scripts (ops-i3vw). **Never** inside
  `~/ops/tps-observatory` (branch-hopping checkout — that's root cause #1).
- Plist: `~/ops/launchd/ai.tpsdev.roster-push.plist`, installed to
  `~/Library/LaunchAgents`, KeepAlive, no inline env secrets (key is read from
  file path at runtime).
- Interval **60s** (server rate limit 10s → 6× headroom; office stale threshold
  600s → 10× headroom; ~5 agents ≪ batch limit 100).

### Signing & secrets (Sherlock)

- Reuses the exact proven signer from push-roster.mjs: payload
  `rockit:<ts>:<nonce>:POST:/IngestEvents`, header `X-TPS-Ed25519` (gateway strips
  `Authorization`), nonce = 8 random bytes hex per push, ts freshness window ±(5m/30s)
  enforced server-side, nonce replay 401 server-side.
- Key: `~/.tps/secrets/rockit-office.key` (already registered as rockit's
  Office.publicKey since June). Never printed, never in argv, never in the plist.
  Missing/unreadable key ⇒ log + exit nonzero (loud), not skip (silent).
- **The daemon holds no admin credential.** Admin Basic
  (`~/.tps/secrets/flair.dtrt.fabric`) is used once, by Flint's hand, for the
  one-time cleanup below — it never enters the adapter or the plist.
- Reads only a public local endpoint; pushes only to the office's own row-space
  (server enforces office scoping via the signature).

### One-time cleanup (scripted, dry-run first — Sherlock override of "by hand")

Not freehand curl: a script `~/ops/scripts/roster/cleanup-fiction.mjs` with the
explicit ID list below, `--dry-run` (default: prints what it WOULD delete) and
`--execute`, using the REST resource paths (`DELETE /Member/{id}`, `/Event/{id}`,
admin `PUT /Office/{id}`) — never raw SQL. Flint runs it; the dry-run output and
the execute output both go in the bead. Reviewable, repeatable, auditable.
1. `newton`, `pulse`, `tps-anvil` offices: `status` → `"offline"` (they have no
   live writer yet; honest state until their hosts get adapters).
2. Delete their June-fiction Member rows (`newton:quill`, `newton:reed`,
   `pulse:pulse`, `tps-anvil:anvil`) and the rockit fiction rows the adapter
   won't re-create (`rockit:nathan`; stale seeded models get overwritten by
   the first real push).
3. Delete the two June seed Event rows (`rockit:e1`, `rockit:e2`, `tps-anvil:e1`).

### Verification (before calling it done)

- Positive: `curl RosterView` shows rockit members matching live `GET /Presence`
  within one interval; kill test — stop an agent's beat, watch staleness propagate.
- **Fiction-model check (Kern):** after the first real push, confirm the old
  seeded `model` strings are gone from rockit Member rows, not retained by a
  partial put — if Harper keeps unspecified fields, the cleanup script must
  delete the rockit fiction rows too, and this test is what decides it.
- Key-unreadable path: chmod the key away in a scratch copy → script exits
  nonzero loudly (Sherlock: never skip-and-continue).
- Negative (the check must be able to fire): block prod URL (or run with bad key)
  → observe failure log lines, and the 10-failure TPS mail actually arrives.
  A guard test needs its positive control.
- Reboot lane: `launchctl kickstart` after unload/load; confirm recovery per scenario 5.

## Phase 2 (separate beads, not this slice)

- **Derive office/member display status from `lastSeen` vs `staleThresholdSeconds`
  in RosterView** — kills the stored-"online" lie class permanently.
- OrgEvent → roster Event feed (real events instead of `[]`).
- Adapters for tps-anvil / pulse / newton hosts (needs per-office keys registered).
- Repo hygiene: merge PR #2 (roster-cp2 — prod currently runs it via tarball,
  unmerged), close PR #3 (cp-aggregate — superseded by this), commit the
  tarball-deployed `office-space.html` into the repo.
- End-state: when federation carries Presence hub-ward, RosterView reads presence
  directly and the adapter is deleted. The adapter is a bridge, not the destination.
  Ground truth today: prod `/Presence` returns 0 agents; federation syncs exactly
  four tables (Memory, Soul, Agent, Relationship — `resources/Federation.ts`),
  OrgEvent is registry-marked `federation: "excluded"`, and Presence isn't in the
  registry at all. Flair's own `doctor` docs state spoke heartbeats are invisible
  to the hub unless agents beat straight to it. Extending federation to presence
  is a flair product decision (and interacts with P0s ops-xllz/zu5x), not
  something this slice reaches around.

## Explicitly out of scope

Prod code deploys, UI changes, TPS CLI subcommands, other hosts, federation work.
