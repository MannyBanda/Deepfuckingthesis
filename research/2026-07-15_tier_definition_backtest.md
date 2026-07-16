# Tier Definition Backtest — what is "elite"? (Jul 15, 2026)

**Question (Manny):** Is the production top-tier cut (current record >.600) the best definition
of an elite team? Suspicion: it misclassifies (GS 1-5 vs top under it; NY/ATL were .600+ when
GS beat them; IND's drop tonight retroactively relabeled GS's two IND wins as vs-rest).

**Candidates:** A = current-record >.600 (production) · ASOF575/ASOF600 = opponent record
entering the game · EVER600 = has reached ≥.600 with ≥15 games played (sticky, Manny's def).
Opponent needs ≥8 games for as-of tiers. vs-top split shrunk toward overall wp (k=3).

**Data:** team_game_stats 2024 (263 g) + 2025 (311) + 2026 (182). Eval: walk-forward, both
teams ≥10 games. Predictor = vs-top split diff; target = winner; metric AUC.

## Results
ALL games (n=547, HIGH power): G0 raw-wp 0.708 > EVER600 0.680 > A 0.670 > ASOF575 0.660 >
ASOF600 0.652. Raw record beats every split (consistent with honest-gap rejection).

GOODvGOOD, both ≥.550 as-of (n=116, MED; per-season LOW):
| def | pooled | 2024 (39) | 2025 (54) | 2026 (23) |
|---|---|---|---|---|
| G0 raw | .509 | .551 | .480 | .469 |
| A | .510 | .602 | .449 | .485 |
| ASOF575 | .521 | .586 | .516 | .492 |
| EVER600 | .532 | .612 | .463 | .554 |
eFGd-based variants: same ordering 2024/2026, all collapse in 2025 (.31–.37).

**Predictive verdict: NO definition demonstrates a robust elite-vs-elite predictive edge.**
EVER600 best pooled and in 2/3 seasons; 2025 reverses everything (only ASOF575 >.500).
Per rigor rules (LOW per-season n, sign flip): ordering only, no deployment claim. Raw record
remains the only gap input (registration unchanged).

## Measurement verdict (the actual question)
"Best definition" is a measurement choice, not a prediction one. Criteria: causality, stability,
construct validity.
- **A fails causality**: tiers use future info; 104 retroactive label flips across weekly 2026
  checkpoints; IND's Jul 15 loss relabeled GS's history. Boundary-flappy.
- **Pure as-of is causal + zero-churn** but credits early mirages (a 6-3 team tiers top) and
  was the weakest pooled predictor.
- **EVER600: adopted as the DESCRIPTIVE definition of elite.** Earned membership (15+ games of
  evidence, no mirages), monotonic (90 one-way flips, all at membership onset), best pooled
  ordering, passes construct validity (2026 tier: MIN GS LV DAL IND ATL NY).

## GS under EVER600 (the motivating case)
8-6 vs elite (2nd best in league behind MIN 7-3), eFGd −0.1, own 2P 47.3. Against the .575-band
(IND/ATL/NY/DAL): 8-1, +4.6. Against the MIN/LV core: 0-5, −8.5, opp 3P 44.3%. **GS is an elite
team with a super-elite problem** — the "paper tiger" read was substantially a def-A artifact.

## Dispositions
- Production tier cut: def A UNCHANGED (PM call; honest-gap registration stays clean).
- EVER600 = narrative/descriptive lens (team ctx discussions, "elite" claims, GS-type reads).
  NOT wired into gates, inflation index, or lane (lane stays def-A; note: under EVER600 MIN's
  inflation flips positive — redefinition would empty the lane).
- Deeper 2025-reversal investigation: not pursued (n=54, expectable noise; revisit only with
  a specific hypothesis).
