# Beatable-Leader Definition Backtest (Jul 16, 2026)

**Question (Manny):** mirror of the elite-tier work — what's the best definition of a team to
bet AGAINST (the "beatable leader" in the trailing-buy signal)? Candidates incl. as-of record
cuts, sticky-bad, margin-based, and Manny's proposal: exclude "elite-killers" (bad teams that
beat elite teams) as untrustworthy fade targets.

**Frame (matches honest-gap):** export_xgb_training 5,260 cps → Q2/Q3, trailer down 1–9, first
cp per game-quarter, both teams ≥4 GP, strictly as-of records. n=744 (2024=297, 2025=447),
baseline trailer-win 34.1%. Elite (for killer flag) = EVER600-as-of. Killer = ≥2 as-of wins
vs elite. Pre-registered L1–L7 before running.

## Standalone (full pool)
| def | n | trailerW | non-q | 2024/2025 |
|---|---|---|---|---|
| L1 asof <.400 (prod analog) | 177 | 50.3 | 29.1 | 51/49 |
| L2 asof <.450 | 210 | 48.6 | 28.5 | 51/46 |
| L3 asof <.350 | 150 | 50.0 | 30.1 | 49/51 |
| L4 ever ≤.400 @15+ (sticky-bad) | 169 | 48.5 | 29.9 | 51/44 |
| **L5 <.450 MINUS killers (Manny's)** | 143 | **44.1** | 31.8 | 49/39 |
| L6 margin/g ≤ −4 (record-free) | 146 | **51.4** | 29.9 | 49/54 |
| L7 <.450 AND margin/g ≤ −2 | 186 | 50.5 | 28.7 | 49/52 |

## Within the system band (gap ≥ .15; n=188, base 56.4%)
Leader definitions add little (57.9–59.1 vs 51–54 non-q) — the gap already encodes leader
badness. L5 is the only one that INVERTS (qualifying 54.4 < non-q 58.2). The standout cell:
**killer-flagged leaders <.450: 58.2% standalone (n=67, 54/63 by season); within band 64.7%
(n=51, 60/69) — best cell in the study, consistent both seasons.**

## Verdicts
1. **Elite-killer exclusion is BACKWARDS.** Bad teams that beat elite teams are variance-profile
   teams — exactly whose leads collapse ("whose variance is it?" at season scale). They are the
   BEST fade targets, not traps. Manny's gut conflated "can beat anyone" with "holds leads."
2. **Best standalone definition: L6 margin/g ≤ −4** (record-free, most season-consistent). L1
   (<.400 production) is fine and near-equal — no change to production warranted.
3. **Sticky-bad does NOT mirror EVER600's success** (48.5, inconsistent 51/44). Bad is better
   measured continuously (margin) than by membership.
4. n=51 for the star cell = LOW power → direction only. **Action: KILLER_LEADER forward ledger
   stream** (GAP_BASE-style, log-only): band spots where leader <.450 + killer flag. Predicted
   ~65%. Zero-risk measurement; no gate changes.

**2026 killer-flagged (fade-harder leaders): LA, CHI, SEA, PHX. Never-beats-anyone: CON, TOR.**
Production <.400 cut unchanged. Note: this is leader-side; trailer-side quality defs unchanged.
