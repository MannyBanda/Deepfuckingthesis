# KILLER_FLAG_SPEC — season-profile flag: nightly compute, GAP_BASE dimension, dashboard badge

**Born:** Jul 16, 2026 (PM go: "spec that") · **Status:** spec, awaiting build go
**Evidence:** research/2026-07-16_beatable_leader_definitions.md + _killer_mechanism_addendum.md
**Layer:** descriptive + measurement ONLY. No gating, no tier changes, no sizing automation.

## §1 Nightly computation (team-profiles-nightly.mjs, ~15 lines + fixture)
One computation, three consumers. Pure fn `computeKillerFields(rows)` over team_game_stats:
- `elite` (bool): HYSTERESIS state machine (PM decision Jul 16) — ENTER at win% ≥.600 with
  ≥15 GP; DEMOTE on crossing <.550; RE-ENTER at ≥.600. Validated: identical 2026 membership
  and identical killer cells (67/45, 53/76) vs pure sticky — adopted at zero evidentiary cost.
- `killer` {flag(bool), scalps(int)}: flag = season wp < .450 AND scalps ≥ 2, where scalps =
  season wins vs opponents in ELITE state AS OF THE EVALUATION (recompute) DATE — causal at
  fire time, captures early-season scalps once the opponent's eliteness is established.
  Validated on the 2024-25 pool: 66% (n=59) vs 50% (n=62), seasons 64/69 — same edge as
  scalp-date semantics with 30% more flagged spots. Side effect (accepted): scalp counts can
  move when OPPONENTS enter/demote elite, not only when the team plays.
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
  killer-flagged. Tooltip: "Elite killer — sub-.450 team with N wins vs elite teams. Their LEADS fade harder
  (hist 67% vs 53%)." (PM decision A: no definitional wording — Manny knows the definition)
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

## §7 DEFINITION ALIGNMENT (cascade trace, Jul 16 — PM-requested; rev 2 post-§8)
Two elite definitions co-reside. The contract that keeps them from cross-contaminating:
- **`tiers` (def A, current >.600 strict) — INTERNAL-ONLY:** feeds override-lane infl and the
  honest-gap forward registration. Nothing user- or agent-facing reads it (per §8). NEVER
  feeds killer/scalps.
- **`elite` (hysteresis) + `tiers_elite` + `killer` — ALL consumer-facing surfaces:** EK chip,
  GAP_BASE dimension, teamCtx prompt copy, BRIEFING block, descriptive reads. NEVER feed infl,
  lane membership, or gates.
- `computeKillerFields` is a SEPARATE pure fn — computeProfiles untouched → ATL golden cannot
  break. Killer fixture adds: as-of replay case (date-filtered rows ⇒ elite-state-as-of falls
  out of the walk for free — same property the §3 back-tag relies on), WSH/CON/TOR exclusions,
  POR(5) golden, IND-at-.583-still-elite hysteresis case.
- **Dashboard coherence:** one definition everywhere consumer-facing (§8) — no legends needed.
- **Narration:** migrates to "vs elite" copy via §8's composeTeamContext swap; prompt-builder
  fixtures unaffected (synthetic ctx injection). Any future KILLER-flag mention in narration is
  its own fixture-updating change gated on §5 promotion.
- **Chip flapping accepted:** killer membership recomputes nightly (LA one result from the .450
  edge); no hysteresis on the .450 side v1, matching lane precedent. (Elite membership itself
  IS hysteretic per §1.)
- **Scope:** WNBA only (no NBA/NCAAMB profiles exist); inherits with profiles extension.
- Project-doc next refresh: record the one-consumer-definition contract in ANALYTICAL FRAMEWORK.

## §8 ELITE LANGUAGE MIGRATION (PM decision C, Jul 16)
Consumer-facing surfaces stop saying "vs top(>.600)" and adopt the ELITE hysteresis definition;
def A becomes invisible internal plumbing.
- Nightly computes a second split `tiers_elite` {top:{w,l,efg_diff}, rest:{...}} bucketing every game by the opponent's elite state AS OF THE EVALUATION DATE (one membership set per recompute — matches the tier backtest and the scalp semantics).
  `tiers` (def A) remains computed but is INTERNAL-ONLY: override-lane infl + honest-gap
  registration. Nothing user- or agent-facing reads it anymore.
- `composeTeamContext` swaps to `tiers_elite`, phrased "vs elite W-L (eFG ±X.Xpp), vs rest
  W-L", and the ctx block header supplies the definition once for the agent: "elite = reached
  .600 with 15+ games; demoted below .550; re-admitted at .600." Agent is never confused by a
  currently-sub-.600 elite (Manny's exact concern — e.g. IND at .583).
- test-fable.mjs pinned sample updated to the new copy. Narration prompt-builder fixtures
  UNAFFECTED (they inject synthetic teamCtx strings). Profiles fixtures: new tiers_elite cases
  (IND-at-.583-still-elite is the golden; DAL-at-exactly-.600 REST adjudication stays pinned
  on the def-A fn).
- BRIEFING block (TEAM_CTX_SURFACING_SPEC) ships on `tiers_elite`; its legend cross-note is
  replaced accordingly.
- Sequencing: §8 lands WITH §1 (same nightly touch, one deploy); composeTeamContext swap is
  poll-adjacent — deploy in a slate gap alongside the §2 fire stamp.
