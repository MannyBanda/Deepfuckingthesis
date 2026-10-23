# Canary × Turnover Fuel — PHASE 0b (FINE ARENA) + AMENDMENT 2

**Date:** 2026-10-23
**Prereg:** `research/2026-10-23_canary_turnover_fuel_PREREG.md` @ `d7eb6e2` · Amendment 1 in `..._PHASE0.md` @ `8e9c670`
**Spec:** `FINE_NBA_ARENA_SPEC.md` v1 @ `723ced8` (PM go in chat: "Build A first, let's do this right")
**Outcome contact:** NONE. The Phase 0b script reads no `ctrl_won` / `winner` / `final_margin` field and prints no proxy rates.

---

## What was built (spec §1, all shipped)

| Artifact | Commit / file | Note |
|---|---|---|
| Walker schedule param + fine-only forced/unforced TO keys | `netlify/functions/backtest-nba-snapshots.mjs` @ `723ced8` | default call byte-identical; `bdlClassifyTOS` mirror byte-equal to production |
| `export_fine` phase | same | read-only, stable pagination, grain=0 = regression mode |
| Fine states | `research/2026-10-23_fine_nba_states.json.gz` | 1,235 games × 100 states (30s, Q1-Q4) = 123,500 states, 3.9 MB |
| Replay builder | `research/fine_nba_canary_replay.mjs` | slices `simulatePossessionMC`, `runMonteCarloSim`, `diffToRatesMC`, `estimateRemainingPossMC`, `classifyMCVerdict`, `classifyMCPattern` from `poll-live-bdl.mjs` at runtime |
| Fine fires | `research/2026-10-23_fine_nba_canary_fires.json.gz` | 2,385 investigations across 1,221 walk-ok games; seeded (mulberry32, seed+gid) |
| Fidelity set | `research/2026-10-23_fine_nba_fidelity_prod_states.json.gz` | 14 real production MC_COLLAPSE games adapted from the snapshot archive |

## Regression gate (spec §3)

`export_fine&grain=0` on 60 games (836 stored rows): **773/836 identical**; every one of the 63 differences is `hPOT`/`aPOT` off by ±1 (7 games, both directions), with `team_stats` and `runs6` identical. The pre-patch walker (`c0d33b8`) and the patched walker produce **14/14 identical** checkpoints on today's BDL plays for a differing game, and the pre-patch walker on today's plays also disagrees with the April row — so the delta is **upstream BDL play-sequence drift since April**, not a walker defect. Code gate: PASS. Data note: recorded; the fine arena is built on today's plays.

**Walk-integrity rule (declared):** a game is kept when no Q2+ state is 0-0 (missing PBP period) and |walked Q4_END − recorded final| ≤ 4 total points (Q4_END ties = OT, exempt). 1,221 of 1,235 kept; 14 excluded (4 missing periods, 10 larger deviations); 45 kept with a ≤4-point box-level deviation.

## Fidelity against real pushes (spec §4, substituted)

The canary shipped May 4, 2026 — after the backtest window (Oct 21 → Apr 15) — so no production push overlaps it. Substitute: the **same replay state machine run on production's own snapshots** for 14 games where production pushed MC_COLLAPSE (7 playoff games May 3-28, 7 games Oct 20-22). Result: **same-team CLEAN reproduced 11/14**; trigger and push both within ~1 minute on 7; same push 2-6 minutes later on 4 (production triggered at the halftime buzzer on three of them, the replay catches them early Q3); 3 misses, each traceable (an untracked team's FALSE_ALARM consuming the slot before the real Q4 trigger; an MC-threshold edge where the replay's verdicts never reached LIKELY; one May-3 push whose trigger text predates the current alert format). CLE@PHI: replay trigger Q3 11:33 vs production 11:09, push Q3 8:01 vs 6:58.

## Deviations from production (disclosed)

1. **Terminal per control SIDE, not per game.** Production holds one `lt.mc` slot per game and its tracked-team gate stops an untracked team's fire from consuming it. The gate is not reproducible; with per-game terminal, ORL's and NYK's early untracked fires blocked ATL's and PHI's real pushes in the fidelity set. Each side may now hold at most one terminal investigation; findings dedupe to one row per game.
2. **Tracked-team gate → `tracked_proxy` flag:** floor ≥ .65 with margin ≥ 2 at any of the 10 states (≈5 min) before trigger. Weak but principled (BWC-eligibility minus the price/LS gates). Primary stratum below.
3. **Not reproduced:** the XGB-drop trigger (no XGB at fine grain; 626/653 fine CLEANs triggered absolute anyway), per-team 3PT baselines (0.36 used), the ML > −250 and LS gates.
4. **Canary window:** production reads the last 20 possessions from the possession log; the replay uses the box diff to the latest state ≥ 20 combined possessions back, with production's ≥ 5 FGA-per-side gate.

## Phase 0b — counts and cut points (FINE)

Population: production-style CLEAN, ctrl margin ≥ 1 at trigger, **one row per game** (prefer `tracked_proxy`, then earliest push).

| | all | tracked_proxy |
|---|---|---|
| CLEAN rows (raw / margin ≥ 1 / one-per-game) | 797 / 709 / **653** | **586** |
| ctrl margin at trigger 1-3 · 4-8 · 9-15 · 16+ | 194 · 253 · 159 · 47 | 161 · 227 · 152 · 46 |
| ctrl **still leading at push** | **579 / 653** | **519 / 586** |
| ctrl margin at push 1-3 · 4-8 · 9-15 · 16+ · trailing/tied | 210 · 231 · 120 · 18 · 74 | 185 · 201 · 115 · 18 · 67 |
| push latency, game-minutes (median · p25 · p75) | 4.0 · 3.5 · 4.5 | 4.0 · 3.5 · 4.5 |
| trigger period Q2 · Q3 · Q4 | 419 · 202 · 32 | 380 · 180 · 26 |
| floor at trigger > .75 | 291 | 291 |
| games with a CLEAN on both sides | 56 | — |

Compare the coarse export: still leading at push **54/171 (32%)**, push ≥ 9 game-minutes after trigger. The fine arena puts the push where production puts it (≈4 minutes, lead intact 89% of the time). This is the instrument correction the build was for.

**Tercile cut points (tracked_proxy, n=586 → ≈195 per tercile = MED power):**

| Feature | lo cut | hi cut | read |
|---|---|---|---|
| F1 net POT (leader − trailer) at trigger | 0 | +5 | top tercile = leader POT edge ≥ 6 |
| F2 trailer TO rate at trigger | .139 | .182 | |
| F3 clean-up delta (trigger → push) | −.129 | −.028 | **window is only ≈7.4 trailer possessions (p25 6.3) — see A2.2** |
| F4 FTA edge at trigger (descriptive) | −2 | +3 | |
| F5 trailer unforced-TO share at trigger (descriptive, fine-only) | .167 | .333 | |

Chronological median trigger date: **2026-01-14**.

---

## AMENDMENT 2 (instrument swap, pre-Phase-1, 2026-10-23)

Permitted under prereg §9. Bars (8pp trailer-WIN **and** 8pp vs proxy, monotone, both halves, n ≥ 40/tercile), features F1-F4, and the ladder are **unchanged**.

- **A2.1 Instrument A = the fine arena** (`2026-10-23_fine_nba_canary_fires.json.gz`). The coarse export (`2026-10-23_canary_fuel_fires.json.gz`) stays committed as the record and is reported as a secondary read for H2 only.
- **A2.2 H2 is a bet-time read, and bet-time is ≈7 trailer possessions.** At production latency the trailer has had only ~7 possessions between trigger and push, so F3 is intrinsically noisy; that is the honest instrument, not a defect. H2 primary = fine (bet-time). The coarse 20-possession H2 is reported alongside as "would a longer look help" — it has no promotion authority because nobody can wait 9 minutes for it.
- **A2.3 Primary stratum = `tracked_proxy`** (n=586, the closest reproducible stand-in for production's position gate); all one-per-game CLEANs (n=653) reported alongside. Dedup rule: one row per game, prefer `tracked_proxy`, then earliest push.
- **A2.4 Replication halves** split at the fine population's median trigger date **2026-01-14** (replaces 2026-01-20 from A1.1).
- **A2.5 Proxy** = fine `base_rates` (leader holds by period × 2-minute bucket × leader-margin bucket, 88,583 states), evaluated at the push state with the A1.3 direction rule.
- **A2.6 F5 trailer unforced-TO share** is recorded as descriptive only (no bar). It exists only at fine grain (walker-derived, production-definition classifier) and was not in the prereg; it earns a bar in a future prereg or not at all.

Nothing else moves. Phase 1 runs on PM go.
