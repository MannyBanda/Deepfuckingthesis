# OVERRIDE_LANE_SPEC — Discretionary WATCHLIST sizing lane + digest surfacing

**Born:** Jul 15, 2026 (PM decision, post row-20 MIN bet) · **Status:** §1 CONVENTION ADOPTED Jul 15; §2/§3 builds DEFERRED (PM call Jul 15 — LOE not justified at one lane member). BUILD TRIGGER: a second team enters the lane (membership stops being obvious). Until then, membership checked on demand by Claude (nightly ritual / session startup / on ask) from team_profiles.
**Layer:** discretionary/narrative only — NEVER gates, never touches signal ledger or tier caps for A/B fires.

## 1. The lane (convention, effective immediately — no code needed)
WATCHLIST sizing cap ($300) may be overridden up to **$600 (B-tier parity)** when the TRAILER is
a lane member. Hierarchy preserved: A fire $1,400 > B fire $600 ≥ lane $600 > plain WATCHLIST $300.
A discretionary review never out-sizes a system fire.

**Membership (mechanical, from team_profiles at evaluation time):**
- `infl < 0` (infl = rest_wp − top_wp, from profile.tiers; tiers re-cut nightly, strict >.600 opp)
- `season win% ≥ .600` (top team, same cut the tiers use — self-consistent)
- `vs-top games ≥ 5` (n-guard: rigor principle, no precision in underpowered splits)

Today: **MIN only** (−.11, 5-1 vs top). Nearest: IND +.01 (watch for flap-in), LV +.19.

**Rules:** declared-before-entry (the push/digest states membership — no post-hoc claims);
max ONE open lane position at a time (single-team concentration guard);
lane bets tagged `LANE` in bets.system_state → separately measurable discretionary stream
(evaluate at n≥15: lane realized win% + ROI vs non-lane WATCHLIST bets).

## 2. Build A (DEFERRED) — nightly digest line (~15 lines, post-game-agent.mjs)
Pure composer `ssOverrideLaneLine(profiles)` → one plain-English line in the digest:
- members: `Override lane (WATCHLIST cap $600): MIN — record understates them (infl −.11, 5-1 vs top).`
- empty: `Override lane: empty — no top team currently under-rated by record.`
- degraded (profiles missing/stale >48h): omit line entirely, log warning. Never guess.
Pinned copy fixture added to digest fixtures. Reads team_profiles only — zero new queries on poll path.

## 3. Build B (DEFERRED) — push-time tag (~8 lines, ssComposePush)
WATCHLIST mechanical push appends one line when trailer ∈ lane:
`Override lane: MIN qualifies — discretionary cap $600.`
This is the moment of action (digest = daily awareness; push = decision point). Touches pinned
push copy → fixture update in ss_tier_bc_fixtures. Recompute membership from cached team ctx
(ensureTeamCtx already loaded at fire site) — no extra DB round trip.

## 4. Non-goals
- No gating, no gap modification (honest-gap rejection Jul 14 stands — inflation is narrative-only)
- No auto-sizing output — the lane sets a CAP, Manny sets the size
- No membership hysteresis/deadband v1 — digest prints the number; revisit only if flapping observed

## 5. PM decisions — RESOLVED Jul 15
1. Cap: $600 (B-parity) — adopted
2. Builds A/B: deferred, trigger = second lane member
3. One-open-position rule: adopted
4. Convention home until next project-doc refresh: this spec + Claude memory (tiered sizing entry)
