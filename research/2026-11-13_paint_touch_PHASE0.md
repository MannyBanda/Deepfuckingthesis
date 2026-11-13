# PHASE 0b — paint × TOUCH prereg: build + counts (no outcomes read)

**Prereg:** `research/2026-10-31_paint_touch_PREREG.md` (`48318f2`) · **Instrument A:** `research/2026-11-13_fine_nba_states_2024.json.gz` (`a3a8a0b`; 1,237 games, 1,234 walk-ok, export code `a033df7`, BDL vintage 2026-11-13) · **Replay:** `research/2026-10-31_mc_trailer_buy_replay.mjs --states … --split 2025-01-19` → `research/2026-11-13_mc_trailer_buy_fires_2024.json.gz` (1,000 sims, seed 20261031) · **Reader:** `research/2026-10-31_paint_touch_phases.py --phase 0`.

## Phase 0a (feasibility) — PASS
BDL 2024-25 regular season present (1,237 games); five spot games Oct 2024 → Apr 2025 return 442–503 plays each with the identical 17-key schema and type vocabulary as 2025-26 (coordinates, team, shooting_play present). The `'Bad Pass\nTurnover'` newline-in-type exists in both seasons and the classifier lowercases + `includes()` — already handled.

## Regression gate — WALKER PASS, DATA DRIFT REPORTED (see `a3a8a0b`)
Walker code unchanged since `723ced8` (diff = the season WHERE clause). 64 re-exported 2025-26 games: states byte-equal 14/64; the differences are upstream BDL play corrections, and today's vintage is the more accurate one against the official box (FGM |err| 2 vs 33; FG3M 0 vs 11; FGA 58 vs 134; AST 3 vs 20). Walk block reproduces 62/64 (2 data-driven flips). **The 2024-25 arena is built on the better vintage; the 2025-26 arena (Oct 23) is on the older one** — a decision for the PM, not taken here.

## Halves split (by rule, not chosen)
The date dividing walk-ok games into equal halves: **2025-01-19** (H1 617 / H2 617).

## Coverage
1,234 games · 61,700 Q3+ states · 27,818 eligible · 27,650 trailer evaluations · FGA<5 168 · 214 games never within 1–9 in the second half.

## Counts
- MC ≥ .55 first-perception rows: **903** (73% — matches 2025-26's 895/1,221). MC ≥ .70: 838.
- Paint bands over all rows: ≤ −6 **298** · −5…+1 **221** · ≥ +2 **384** (2025-26: 309 / 226 / 360).
- **H1 stratum (paint ≥ +2 × deficit 1–6): n = 260 · H1 137 / H2 123 · bands 1–3 154 / 4–6 106.** n-clause (≥ 40/half) **MET**, HIGH.
- H2 avoid cell (paint ≤ −6, deficit 1–9): n = 298 · 151 / 147.
- Touch-base cells at H1 fires: median n 987, min 307; none under 30.

No outcome field has been read. Phase 1 next.
