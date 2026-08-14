# EUROLEAGUE SCOUTING PLAN — Aug 14 session

**Question (PM, Aug 13):** can EuroLeague deliver a CONSISTENT FEED of sweet-spot positions? Data availability confirmed Aug 13 (BDL: no — live 404 probe; SR Global Basketball API: yes, separate package/trial key; EuroLeague official API: yes, real-time + historical + shot data; The Odds API: yes, `basketball_euroleague` on existing plan). Scouting only — NO engine build; parameterization gated on a later pre-registered edge-vs-line study.

## Deliverable: SPOT-DENSITY STUDY (the "consistent feed" answer)
Build a lightweight historical states extraction from the EuroLeague official API for 2024-25 + 2023-24 (both-seasons rule) and measure the fired-comparable shape (leader below ~.400 EUROLEAGUE-ONLY record, gap ≥.15, in-band deficit, catchable time — thresholds re-derived natively, never transplanted):
- spot-games per round / per calendar week / per season phase
- vs the WNBA baseline (20-30% of games mid-season → EuroLeague at ~10-11 games/wk implies ~2-3 spots/wk if the rate transfers; the study measures the real number)
- win% distribution check: are sub-.400 teams leading in-band vs .55+ teams often enough?
- gp-guard decision: 34-round season → gp≥10 blinds ~5-6 weeks; evaluate gp≥8 tradeoff and STATE it

## Session checklist
1. Identify official API hosts + endpoint shapes (web search; euroleaguer R package docs are the map), then probe: one season schedule, one game's pbp/box/shot feed. Verify five-component feasibility: eFG components, POT derivable from pbp, paint from shot coords, timeline granularity (instrument-grain rule: measure the feed's true cadence before trusting any prior built on it).
2. SR Global Basketball trial probe (needs key — PM signup): EuroLeague competition coverage LEVEL, timeline/summary fields, historical season depth.
3. The Odds API: GET /sports for `basketball_euroleague` (off-season may show inactive — fine); check whether the current plan tier exposes HISTORICAL odds for it (yes → edge study can run on historical arena + historical odds immediately; no → forward logging from October, the WNBA Test-#1 pattern).
4. Write findings: spot-density verdict + data-feasibility verdict + go/no-go recommendation for the October read-only logging phase.

## PM prep items (blocking)
- **Sandbox network allowlist** currently has NONE of: `api.sportradar.com`, The Odds API host, EuroLeague official API hosts. Add before the session: `api.sportradar.com`, `api.the-odds-api.com`, and the EuroLeague candidates `api-live.euroleague.net`, `live.euroleague.net`, `feeds.incrowdsports.com` (exact host confirmed at session start — over-adding is harmless).
- **SR Global Basketball trial key** — register at the SR developer portal (same flow as the WNBA/NCAAMB trial keys) if we want the SR lane probed tomorrow; the official-API lane needs no key.

## Standing cautions carried in
Market sharpness is the gating unknown, not data. Priors re-derived natively (pace ~72 poss → band/cliff sit elsewhere; eFG bands re-derived). EuroLeague-only records (domestic-league games excluded). Method transfers; numbers never do.
