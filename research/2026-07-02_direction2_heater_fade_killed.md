# Direction-2 Phase-2 — Individual-Heater Fade: KILLED (within-game PBP backtest)

**Date:** 2026-07-02
**Author:** Claude (lead eng), greenlit by Manny
**Scope:** Within-game test of the individual-heater fade layer (3rd fade type, shelved pending
OOS validation). Pre-registered bar: heater-dependence of the leader must erode the lead MORE
than baseline / more than the line implies. **Result: it does not. At halftime it erodes LESS;
at end-Q3 it is null. The layer is dead.** This replicates the team-level eFG-heat null
(NBA n=1,200; WNBA artifact) at the player level — third consistent kill of the "hot = mirage"
family.

---

## Hypotheses (stated before data)

- **H1 (core):** Halftime leads that are heater-dependent (top scorer ≥~35% of team pts AND
  running hot vs own season TS norm, esp. from 3PT/mid) collapse at a higher rate than same-size
  structural leads.
- **H2 (mechanism):** The hot player's 2nd-half efficiency regresses to norm within the game
  (within-game analog of the between-game β≈0 finding).
- **H3 (the bar):** The effect adds separation beyond deficit + quality gap (LOCKED signal),
  else it's redundant and stays dead.

## Method

- **Data:** BDL `/wnba/v1/plays` for all 720 completed games 2024–2026 (one request per game —
  no cursor; text carries shot distance; running home/away scores on every play). Slim per-game
  event extraction (player, team, period, ft/2/3, made, distance) + period-end scores (`pend`).
  Cached `/tmp/wnba_pbp_{season}.json` (~5MB total).
- **Validation vs `/player_stats` truth:** player-name match 99.4% (scorers ≥6 pts), player pts
  97.4% exact / 100% within 2. Team-score exact only 51.7% but misses are uniform −1 pt
  (goaltending/awarded points with no "makes" play) → leads/deficits/finals taken from the feed's
  own `pend` scores (exact); PBP events used only for player state (validated).
- **State at checkpoint (end-Q2, robustness at end-Q3):** leader's per-player pts / FGA / FTA /
  3PA; TS vs own season norm (phase-1 baselines, ≥15 g); unsustainable share of top scorer's pts
  (3PT + mid ≥10 ft); top-scorer share of team pts.
- **Heater-dependent lead:** top-scorer share ≥ .30 AND TS dev ≥ +.10 vs own norm AND
  unsustainable share ≥ .50 (top scorer FGA ≥5 at half / ≥7 through Q3).
- **Quality gap:** entering-game win% from date-ordered PBP finals (≥5 games played each).
- **Band:** checkpoint margin 1–9 (catchable, matches LOCKED band).

## Results

### H2 — mechanism CONFIRMED: hot halves fully revert
n=574 leader-top-scorers (1H FGA ≥5, 2H FGA ≥3). corr(1H dev, 2H dev) = **−0.000**, slope β =
**−0.000**. A scorching 1H (+30pp TS over norm) → 2H at **+0.6pp** — complete reversion, mirroring
the between-game β = −0.037. **The regression is real. The inference from it was wrong:** the
points are already banked; a 2H at the star's *norm* preserves the margin on average. Rented-lead
assumption ≠ reality.

### H1 — INVERTED at halftime, null at Q3
Comeback rate vs the leader, margin 1–9:

| Checkpoint | Heater-dependent lead | Non-heater lead | Δ |
|---|---|---|---|
| Halftime | **26.2%** (n=80) | 35.5% (n=330) | **−9.3pp** |
| — margin 1–4 | 27.5% (n=40) | 44.4% (n=160) | **−16.9pp** |
| — margin 5–9 | 25.0% (n=40) | 27.1% (n=170) | −2.1pp |
| End-Q3 | 28.6% (n=49) | 29.9% (n=318) | −1.3pp (null) |

Every single component points the same (wrong-for-the-thesis) direction at half:
dev ≥ +.10 → −6.6pp, share ≥ .35 → −6.0pp, unsust ≥ .60 → −7.4pp comeback.
**Heater-carried leads are stickier, not softer — especially small ones.**

### H3 — no information beyond quality gap
Within quality-gap spots (trailer entering win% ≥ .10 better), band 1–9:
- Halftime: heater 52.2% comeback (n=23) vs non 53.3% (n=90) → **Δ −1.2pp, nothing.**
- Q3: heater 50.0% (n=14) vs non 38.8% (n=67) → +11.2pp on n=14, noise.

In NO-gap spots at half, heater-dependence predicts the lead **holds** (comeback 10.9% (n=46)
vs 28.0% (n=182)) — the opposite of a fade signal.

### Bonus — LOCKED signal triangulated a 4th time, independently
Quality-gap (≥.10) trailers at halftime deficit 1–9 come back **52–53%** (n=113) vs ~33% base —
reproduced through an entirely independent path (PBP period-end scores + entering win%), no
snapshots, no XGB, no MC.

## Verdict & implications

1. **Individual-heater fade layer (Direction 2, 3rd fade type): KILLED.** Failed its
   pre-registered bar decisively. Do not build; remove from the horizon list.
2. **Coherent family-level conclusion:** hot-shooting fade fails at team level (NBA eFG null),
   at player level between games (full reversion but no bet), and at player level within games
   (leads hold). The edge in this system is the **quality gap**, not heat.
3. **4c analyst prompt framing (for when we build it, no code now):** "who's carrying" context
   must NOT be narrated as fragility. Data-backed framing: *a heater-carried lead is banked, not
   rented; expect the scorer to regress to norm WITHOUT the margin eroding; small heater-carried
   leads hold at ~73%.* Feeding Opus the opposite intuition would inject a validated-false prior
   into every alert.
4. **Sweet Spot dual-gate unaffected:** gate (a) leader bad + (b) lead unsustainable at the TEAM
   level (variance share of the lead) was validated on its own track; nothing here touches the
   team-level variance-share check. What died is the *player-level heater* as a fade trigger.

## Caveats (honest ledger)

- No historical live lines in the join — the bar was tested vs raw outcome rates, not vs line.
  Given the sign is inverted, line-relative rescue is implausible.
- Heater cells are n=40–80; but sign-consistency across every component cut + two checkpoints +
  agreement with the NBA team-level null gives the kill good footing.
- TS at checkpoint is a PBP proxy (no in-play FTA splits beyond FT events; distance regex).
- Entering win% requires ≥5 games; early-season games drop out of H3 cuts only.

## Artifacts

`/tmp/wnba_pbp_{2024,2025,2026}.json` (slim PBP events + period-end scores, resumable puller in
session), `/tmp/wnba_d2p2_recs.json` (per-game halftime state + outcomes), phase-1 files per
`research/2026-06-28_player_data_assessment.md`.
