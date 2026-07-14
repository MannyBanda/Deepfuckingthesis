# Team Profiles v1 — Launch Findings & Usage Playbook

**Date:** 2026-07-14 · **Source:** team_profiles / team_game_stats (178 games, 356 rows,
season 2026 through Jul 14) · **Status of layer:** context-only, non-gating, pending backtest
(TEAM_PROFILES_SPEC §1). Tier slices are n=5-12 → LOW power under rigor cutoffs — direction, not probabilities.

## League table (sorted by record)

| Team | Rec | Arch | eFGd | TOm | vs Top | topEFGd | vs Rest | Infl* | L5 | Form tags |
|------|-----|------|------|-----|--------|---------|---------|-------|----|-----------|
| MIN | 18-6 | SHOTMAKER | +6.2 | +1.4 | 5-1 | +5.2 | 13-5 | −.11 | 3-2 | OPPONENTS_HOT (+10.3, margin −11) |
| GS | 17-7 | POSS_LEAN | +1.2 | +3.0 | 2-6 | −5.8 | 15-1 | +.69 | 5-0 | OPPONENTS_COLD (−4.1) |
| LV | 17-8 | SHOTMAKER | +3.5 | +0.1 | 5-4 | +0.6 | 12-4 | +.19 | 3-2 | own −2.9 |
| DAL | 16-8 | POSS_LEAN | −0.1 | +2.6 | 3-5 | −2.0 | 13-3 | +.44 | 5-0 | own +2.4 (earned) |
| IND | 14-9 | SHOTMAKER | +4.0 | −2.2 | 3-2 | +5.2 | 11-7 | +.01 | 4-1 | own +3.4, margin +9.8 (hottest true form) |
| ATL | 14-10 | POSS_BULLY | −5.7 | +3.5 | 5-6 | −5.4 | 9-4 | +.24 | 2-3 | OPPONENTS_HOT |
| NY | 14-11 | SHOTMAKER | +3.6 | −3.1 | 4-5 | +0.5 | 10-6 | +.18 | 2-3 | |
| WSH | 11-10 | FLAT | −0.2 | −3.0 | 2-4 | +2.1 | 9-6 | +.27 | 3-2 | OPPONENTS_COLD |
| LA | 10-12 | SHOT_DEF | −2.1 | 0.0 | 2-7 | −7.3 | 8-5 | +.39 | 2-3 | |
| TOR | 10-13 | FLAT | 0.0 | −0.4 | 0-5 | −6.2 | 10-8 | +.56 | 1-4 | own +3.7 but losing — bounce-back shape |
| POR | 10-14 | FLAT | −1.6 | −1.2 | 2-5 | −1.3 | 8-9 | +.18 | 2-3 | OPPONENTS_COLD |
| PHX | 8-17 | SHOT_DEF | −4.2 | −0.3 | 2-10 | −5.6 | 6-7 | +.29 | 1-4 | |
| CHI | 7-16 | FLAT | −0.9 | 0.0 | 2-8 | −3.3 | 5-8 | +.18 | 1-4 | OPPONENTS_HOT |
| CON | 6-18 | SHOT_DEF | −5.5 | +1.1 | 1-7 | **−10.9** | 5-11 | +.19 | 2-3 | |
| SEA | 6-19 | FLAT | +0.9 | −1.7 | 0-7 | −3.7 | 6-12 | +.33 | 1-4 | OPPONENTS_COLD |

*Infl = rest win% − top win%. Tier splits re-tier nightly against current opponent win% (strict >.600).

## Key findings

1. **Record inflation is real and large.** GS +.69 (2-6 vs top, eFG −5.8 vs top; 15-1 vs rest),
   TOR +.56 (0-5 vs top), DAL +.44. The mechanical quality gap uses RAW win% — gaps involving
   these teams are distorted: an inflated trailer's edge is overstated; an inflated team as a
   near-band leader looks stronger (smaller gap) than it is.
2. **MIN is the only negative-inflation team** (better vs good teams, +5.2 eFGd vs top) and is
   currently a variance victim (L5 opponents +10.3pp hot, margin −11, own eFG only −1.1).
   MIN-trailing spots = highest-conviction profile shape; live prices may be soft on them now.
3. **The <.40 leader pool differs internally.** CON leads over elite trailers are sand
   (−10.9 vs top). SEA hangs legitimately with mid teams (+2.8 eFGd vs rest) — a SEA lead over
   a mid trailer is less rotten than .240 suggests. PHX/CHI intermediate.
4. **POR@CON Jul 14 (WATCHLIST L, POR lost by 3)** — the worked example: gap .217 passed
   correctly, but trailer POR profiles FLAT / eFGd −1.6 / 2-5 vs top — "less-bad", not "better".
   The discretionary layer's job is sizing down this shape, NOT gating it. n=1, direction only.
5. **Form separation:** IND (own +3.4, margin +9.8) and DAL (own +2.4) heaters are earned;
   GS 5-0 is partly opponent-cold (−4.1). TOR losing while shooting +3.7 above baseline.

## Usage playbook (at push time — bet/pass + size within tier cap)

| Check | Green (toward full tier size) | Red (size down / pass) |
|-------|-------------------------------|------------------------|
| Trailer archetype | SHOTMAKER/DUAL_EDGE, +eFGd vs top | FLAT / SHOT_DEFICIT trailer |
| Trailer vs-top record | Beats good teams | Record built vs weak slate |
| Leader rot | <.40 AND ugly vs-top eFGd | SEA-shape leader vs mid trailer |
| Form overlay | Trailer intact + opponents hot (market soft) | Trailer own-eFG COLD ≥4pp |

Disciplines: (a) tier slices = direction only (LOW power); (b) record the profile read in the
nightly bet log so profile-informed bet/pass can be backtested inside the discretionary-alpha
stream before anything ever becomes a gate; (c) eFG-heat remains NON-operative as signal — this
layer is season identity, not live shot-making machinery.

## Open research question (flagged, not asserted)

POSSESSION_BULLY trailers (ATL) catch up on levers the WNBA framework weights lower (I3 shot
quality anchors; paint/possession noisier). Do possession-archetype trailers convert comeback
spots at a lower rate? Backtestable against 524 hist + 95 live once profile joins exist
(dft_game_id is populated for this).

## Provenance notes

Player-sum OREB excludes team rebounds (±0.25 fixture tolerance). eFG = attempt-weighted
aggregate per slice. Tier cutoff strict >.600 (§2a adjudications). Schedule.road_streak =
consecutive away games ending at last game; rest days computed at consumption.
