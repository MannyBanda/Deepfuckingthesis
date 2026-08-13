# 2026-08-13 — comebackProb recalibration vs FINE ARENA: FINDINGS

**Prereg:** `2026-08-13_comebackprob_recal_PREREG.md` (sha256 a2e8186e…, commit 6c3ed3b — committed before any data cut).
**Scripts:** `2026-08-13_cb_recal_phase1.mjs`, `2026-08-13_cb_recal_phase2.mjs`. **Scored states:** `2026-08-13_cb_recal_scored_states.json.gz`.
**Instruments:** fine arena matched states (3,113; window 750-2250s; 2024+2025), fadeRead + port-gate joined from `fixtures_tier_replay_states.json` (2,728/3,113 joined; unjoined worst-case effect on H1 = 0.39pp, immaterial). Port fixture gate: my comebackProb port matched the replay's `coll` tier on **2,728/2,728** states. Fired-shape population reproduces SS_STRUCT ldrBad **exactly** (54.3/370).

## VERDICT 1 — H1 CONFIRMED: the stamp is miscalibrated, and it is TOO HIGH

Band stampable population (leader <.400, gap ≥.10, deficit 1-9; n=421, HIGH):
mean signed error (realized − stamped) = **−9.6pp** (realized 53.4 vs mean stamp 63.1); gid-cluster 95% CI [−17.9, −0.2]; **2024 −3.6 (n=188, MED) / 2025 −14.5 (n=233, HIGH) — same sign both seasons**, clearing the pre-registered bar (pooled |mse| ≥ 4pp + sign consistency). First-stampable-per-game sensitivity: −5.1pp (−0.9 / −8.4), same sign. Honest caveats: the 2024 leg's magnitude alone sits under 4pp, and the cluster CI clears zero narrowly — the miscalibration is real in sign both seasons but concentrated in 2025.

**The benchmark that hurts:** M0's band Brier = **0.2597**, worse than stamping a constant 53.4% on every state (0.2489). At the state level, the current stamp's variation carries **negative information** — the deficit table and gap treatment move the number in ways that anti-correlate with truth as often as not.

## VERDICT 2 — H1a INVERTED: the "stamps are lowballing" framing is DEAD

Fired-comparable shape (leader <.400, gap ≥.15, band): mse = **−10.7pp** (n=370, HIGH; 2024 −4.7 / 2025 −16.2); pre-Q4 −6.3 (n=266). The stamps OVERSTATE structural truth on exactly the shape the engine fires on. **The PK v5.4 calibration caveat's direction is RETRACTED** (shipped this morning at a3f885a, inverted by this study tonight): the A-tier +30.4pp over-performance is **era + selection riding over an inflated baseline**, not instrument lowball. Second-order correction: a structural recalibration would LOWER stamps ~5-10pp and **TIGHTEN the edge gate** — the opposite of the caveat's "opens on more prices."

**Where the miscalibration lives (signed-error map, band):** the ×0.75 haircut over-punishes modest gaps at shallow deficits (d13 haircut pre-Q4 **+12.6pp**, stamp 51 vs realized 64, n=44) while the lean cells run high everywhere and collapse in Q4 that the time-blind stamp cannot see (d13 lean Q4-late **−35.3pp** n=25; d46 lean Q4-late **−56.4pp** n=8 LOW; d79 lean pre-Q4 **−22.4pp** n=46). Mechanism: two defects — time-blindness (period is a dead parameter) and a gap treatment whose base levels were hand-set in June from client-era intuition (provenance: 6fae745, ported verbatim from wnba-bdl.html, pre-dating both arenas).

## VERDICT 3 — H2 NOT PROMOTED: the refits fail the pre-registered bar, and the failure is the finding

Model ladder per prereg (M1 = same form, values refit; M2 = M1 + Q4e/Q4l multipliers), Brier-min on train season, holdout on the other:

| direction | M0 band Brier | M1 | M2 |
|---|---|---|---|
| fit 2024 → test 2025 | **0.2876** | 0.2889 | 0.2893 |
| fit 2025 → test 2024 | **0.2252** | 0.2581 | 0.2512 |

**Neither candidate beats M0 in either direction.** The pooled-|mse| leg passes spectacularly (M1 0.3pp, M2 0.1pp vs M0's 9.6) — the refits fix the *bias* — but the conjunction fails, so per prereg **nothing is promoted and no code change is proposed.**

**Mechanism (the real finding):** the two seasons demand incompatible parameters — fit-on-2024 wants b5=.72/h=.64/s=0; fit-on-2025 wants b5=.41/h=1.50/s=.10 (the haircut *inverts*). Season-level conversion regimes swing harder (base-gates 71.6% in 2024 vs 47.5% in 2025) than the structural miscalibration itself (−9.6pp). **At n≈200/season, any absolute-probability recalibration chases regime.** The gap staircase is season-invariant in ordering; its *level* is not — and an absolute stamp is a claim about level.

Consistency check worth keeping: the full-sample M2's fitted time multipliers (**m4e .78, m4l .56**) independently recover the SS_STRUCT time-decay ratios (44.7/55.3 = .81, 31.5/55.3 = .57) — the fit re-discovered the arena's time structure. The structure is real; the level is regime.

## VERDICT 4 — H3 DISSOLVED: the fadeRead bump is unpowered AND immaterial

STRONG FADE incidence on stampable states: **1.1% (n=6)** — three orders below the MED bar. Per prereg: retained-but-flagged. Practical resolution of the locked signal's "candidate to drop": at 1.1% incidence × +.03 magnitude, the bump moves nothing measurable in either direction — the question dissolves rather than resolves. Dropping it remains a harmless simplification whenever the function is next touched for other reasons; it justifies no commit of its own.

## PHASE 3 — 2026 transfer (report-only, as pre-registered)

Resolved stamped SS rows: **n=41 (23 deduped per game, LOW)** — realized 82.9% vs M0 mean stamp 68.1 (+14.8pp) vs full-sample-M2 restamp 63.2 (**+19.8pp**). Deduped: 78.3 vs 66.0 vs 61.4. In the current era, realized exceeds BOTH stamps, and the structurally honest number is *further* from 2026 truth than the legacy heuristic — because 2026 is a hot regime (deficit26 62.9/60.0/40.7 vs fine bases 54.9/52.2/35.8) and the era belongs in riders, not calibration. The edge that has been cashing is carried by the era and by Manny's selection, not by the stamp's accuracy.

## WHAT CHANGES

**Code: nothing.** H2 failed its bar; no build, no proposal. Ledger of record unchanged; no restamping. Consequences for PM awareness, none of which ship without separate go-ahead:
1. **PK errata at next bump:** correct the v5.4 calibration-caveat direction (stamps HIGH vs structure; recal would tighten the gate; era carries realized).
2. **Predicted-column reading:** treat `collapse_true` as a legacy heuristic — known ~10pp high vs structural truth, time-blind, state-level information content below a constant. The realized-vs-predicted delta is a regime gauge more than a calibration gauge.
3. **Graduation bar:** "realized within ~5pp of predicted" is measured against this heuristic; the bar's meaning is weaker than assumed and the graduation decision should weigh that explicitly.
4. **Future direction (own prereg required, backlog #6 territory):** stop asserting an absolute probability — take *shape* from structure (deficit × time × gap, which is season-invariant) and *level* from the live market or an online season anchor. A line-relative stamp cannot chase regime because the line already carries it.

## POWER & PROVENANCE LEDGER

All structural cells: fine arena, 2024+2025, committed substrate, regenerable. Band pooled n=421 HIGH; per-season 188 MED / 233 HIGH; map cells MED to LOW as annotated; H3 n=6 UNPOWERED; Phase 3 n=41/23 LOW, 2026-production transfer, era-confounded by design and reported as such.
