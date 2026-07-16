# KILLER_FLAG_SPEC — season-profile flag: nightly compute, GAP_BASE dimension, dashboard badge

**Born:** Jul 16, 2026 (PM go: "spec that") · **Status:** spec, awaiting build go
**Evidence:** research/2026-07-16_beatable_leader_definitions.md + _killer_mechanism_addendum.md
**Layer:** descriptive + measurement ONLY. No gating, no tier changes, no sizing automation.

## §1 Nightly computation (team-profiles-nightly.mjs, ~15 lines + fixture)
One computation, three consumers. Pure fn `computeKillerFields(rows)` over team_game_stats:
- `ever600` (bool): reached win% ≥.600 with ≥15 GP at any point this season (walk of results)
- `killer` {flag(bool), scalps(int)}: flag = season wp < .450 AND scalps ≥ 2, where scalps =
  wins vs opponents who were ever600 **as of that game date** (strictly causal, matches research)
Written as top-level fields in profile JSONB. Fixture: 2026 golden = flag set {POR(5), LA(3),
CHI(2), SEA(2), PHX(2)}; CON(1)/TOR(1) excluded; WSH excluded (wp .545). All-Star phantom
guard already upstream.

## §2 GAP_BASE dimension (db-api + fire site, ~10 lines)
- Cols on sweetspot_alerts via `?action=init`: `leader_killer BOOL`, `leader_scalps INT`
  (new isolated ALTERs; never added to existing SELECTs on polling paths — fetch separately
  where needed, per critical-path rule)
- Fire time: GAP_BASE (and all SS subtypes, cost-free) stamp the leader's killer fields read
  from the cached team ctx (ensureTeamCtx already loaded at fire site; if ctx missing → NULL,
  never computed inline)
- `ss_ledger_summary` gains an optional per-flag split for GAP_BASE, reported only when both
  cells have n ≥ 8 (power rule); digest copy untouched in v1

## §3 Back-tag one-off (research script, run once post-§2)
Script over existing resolved GAP_BASE rows (n=5): recompute leader_killer/scalps as-of each
row's fire date from team_game_stats, UPDATE rows, print the split. Committed to research/
with output pasted into the doc. Not a recurring job.

## §4 Dashboard badge (wnba-bdl.html, ~25 lines)
- On load: single `get_team_profiles&league=wnba` fetch (15 rows), build killer set,
  cache 6h (profiles only change nightly)
- Render: amber "EK" chip next to the team name on game-card headers when that team is
  killer-flagged. Tooltip: "Elite killer — sub-.450 team with N wins over teams that were elite AT THE TIME.
  Their LEADS fade harder (hist 67% vs 53% trailer conversion)." (at-the-time wording is the
  §7 alignment contract — scalp denominators differ from current def-A tier records)
- Chip renders on the TEAM, wherever they appear (leading or trailing) — it is identity, not
  a live read. Muted styling (no red; red is reserved for live alerts)
- Degraded: fetch fails → no chips, no error surface
- v1 non-goal: NO verdict-strip copy change (pinned fixtures untouched); revisit only if the
  ledger split earns promotion

## §5 Measurement & promotion (pre-registered, from addendum)
Forward bar: killer-tagged GAP_BASE rows hold ≥60% at n≥15 → flag promotes to a sizing-
confidence input WITHIN tier caps (playbook green/red). Tier elevation: never from this flag
(A/B ladder = live machinery; cross-signal combination belongs to the unified EV layer, #6).
Manny's bet log: note flag status on band bets now (discretionary-alpha stream).

## §6 Estimates & order
Nightly fields+fixture ~15 lines → init cols ~4 → fire-site stamp ~6 → back-tag script ~30 →
ledger split ~12 → dashboard ~25. Data-layer parts are poll-safe anytime; the fire-site stamp
is 2 lines inside fireSweetSpotAlert — deploy in a slate gap. Total ≈ 90 lines + 2 fixtures.

## §7 DEFINITION ALIGNMENT (cascade trace, Jul 16 — PM-requested)
Two elite definitions now co-reside. The contract that keeps them from cross-contaminating:
- **`tiers` (def A, current >.600 strict)** feeds: gating context, override lane infl, honest-gap
  forward registration, all narration/brief prompt copy ("vs top(>.600)"), pending BRIEFING
  block. NEVER feeds killer/scalps.
- **`ever600` + `killer` (this spec)** feed: EK chip, GAP_BASE dimension, descriptive reads.
  NEVER feed infl, lane membership, or tier gates.
- `computeKillerFields` is a SEPARATE pure fn — computeProfiles untouched → ATL golden cannot
  break. Killer fixture adds: as-of replay case (date-filtered rows ⇒ ever600-as-of falls out
  of the walk for free — same property the back-tag §3 relies on), WSH/CON/TOR exclusions,
  POR(5) golden.
- **Dashboard coherence:** EK tooltip uses "elite at the time"; when the team-ctx BRIEFING
  block ships (spec 7e3cd65, pending), it carries a one-line legend distinguishing "vs current
  top (>.600)" from "scalps (at-the-time elite)". Cross-note added to that spec.
- **Narration untouched v1:** prompts keep def-A copy; any future flag mention in narration is
  its own fixture-updating change gated on §5 promotion.
- **Chip flapping accepted:** membership recomputes nightly (LA one result from the .450 edge);
  no hysteresis v1, matching lane precedent.
- **Scope:** WNBA only (no NBA/NCAAMB profiles exist); inherits with profiles extension.
- Project-doc next refresh: record the two-definition contract in ANALYTICAL FRAMEWORK.
