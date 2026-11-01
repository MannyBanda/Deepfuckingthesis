# PREREG — MC-favored trailer × paint control → TOUCH the lead (NBA), on a fresh instrument

**Date:** 2026-10-31 · **PM:** Manny · **Executor:** this session on PM go · **Status:** PRE-REGISTERED. Instrument does not exist yet (FINE_NBA_ARENA_SPEC Amendment 1 builds it); no 2024-25 outcome has been read by anyone. Attestation = this file's commit SHA.

**Why this exists:** the PM's cash-out trade needs the trailer to *take the lead*, not win. The Oct 31 exploratory appendix (`8e218ba`) found, on the contaminated 2025-26 arena, one coherent split — paint control — and a compound cell (paint gap ≥ +2 × deficit 1–6) with TOUCH +9.1pp (±5.3, n=233). That cell was picked from 204 after looking; this prereg tests it once, on a season no one has cut.

**Stakes:** if PASS, this is the candidate A-tier selector for the NBA Sweet Spot port (`NBA_SWEETSPOT_PORT_SPEC.md` §5) — the thing eFG-heat is for the WNBA. If NOT PROMOTED, the NBA engine runs without an A-tier until something else earns it.

---

## 1. Definitions
- **Windowed MC:** `runMonteCarloSim` on each team's last ~20 possessions (box-diff window, FGA ≥ 5 both sides), control = trailer → P(trailer wins). Production field `mc_win_prob`.
- **First perception:** first 30s state in the game where the condition holds; one row per game.
- **Paint gap:** trailer's cumulative points in the paint − leader's, at the fire state (`pd.hPaint`/`pd.aPaint`).
- **TOUCH:** the trailer leads (margin > 0) at any later regulation state.
- **Cell base (fair):** TOUCH rate over *all* Q3+ states in the same period × 2-min clock bucket × deficit bucket (1–3 / 4–8 / 9–15), built on the same instrument. **Edge = TOUCH − cell base.** WIN uses the leader-holds table the same way.
- Power: HIGH ≥ 200 · MED 80–200 · LOW < 80; below MED, ordering only.

## 2. Hypotheses
- **H1 (verdict).** Primary stratum = trailer windowed MC ≥ .55 at first perception · Q3+ (Q4 ≥ 1:00) · deficit **1–6** · **paint gap ≥ +2**. TOUCH edge ≥ **+8pp**, in each chronological half, n ≥ 40 per half. Any clause missed → NOT PROMOTED.
- **H2 (mirror, report-only).** Same MC stratum, deficit 1–9, paint gap ≤ −6 → WIN edge ≤ −5pp in each half. This is the avoid-filter; it decides copy ("leader owns the paint — pass"), never a gate.
- **H3 (transfer, report-only).** H1 definition on the 2025-26 arena (contaminated, the cell's origin) and on the 2026-27 production tape (`mc_win_prob` + `raw_stats_json` paint). Reported as transfer, never as verdict.
- **Report-only descriptives:** WIN edge on the H1 stratum; TOUCH by deficit band 1–3 / 4–6; time-to-touch distribution; touched-then-lost share; paint gap ≥ +2 *without* the MC condition (is the MC doing anything, or is it paint alone?).

**No searched cuts.** .55, +2, −6 and 1–6 are the only values that can pass or fail. Any other threshold is a new prereg.

## 3. Contamination disclosed
2025-26 arena, exploratory (`research/2026-10-31_mc_trailer_buy_EXPLORATORY_touch.md`): MC ≥ .55 fires n=895 → TOUCH −1.2pp; paint ≤ −6 → WIN −8.2 (−8.4 / −7.9); paint ≥ +2 → WIN +3.5 / TOUCH +4.7; paint ≥ +2 × deficit 1–6 → TOUCH +9.1 ±5.3 (78% vs 69%), WIN +4.8 ±6.4, halves +6.7 / +3.1. 34 variables × 2 outcomes × 3 terciles were scanned; paint was the only both-halves coherent split. The 2024-25 season has never been walked at fine grain or read for any outcome.

## 4. Instrument
**A (verdict):** FINE NBA ARENA 2024-25 per `FINE_NBA_ARENA_SPEC.md` Amendment 1 — same walker, same 30s grain, same walk-integrity rule, `research/…_fine_nba_states_2024.json.gz`. Replay = `research/2026-10-31_mc_trailer_buy_replay.mjs` extended with `--states` (already supported) and paint fields on the row (additive). **Halves split rule:** the date that divides walk-ok regular-season games into two equal halves (the date is reported in Phase 0, not chosen).
**B (transfer):** 2025-26 arena (contaminated) and 2026-27 production snapshots.

## 5. Cash-out economics (report-only, no bar)
At each TOUCH row, record the cell-base win probability at the touch state (the fair price a book would show). Cash-out return ≈ stake × (p_touch_state / p_entry) − 1, net of a declared 5% vig haircut. EV of "buy at fire, cash at first lead, else hold" is reported for the H1 stratum and for its cell base. **This is descriptive until the NBA stale-quote filter ships** (`NBA_SWEETSPOT_PORT_SPEC.md` §4.3); no ROI claim is made from stamps.

## 6. Promotion ladder
- **NOT PROMOTED** → paint joins the do-not-revisit list for trailer selection; the NBA SS engine ships with no A-tier.
- **PASS** → becomes the NBA SS engine's **A-selector candidate**: runs as a **WATCHLIST-class review cue** (dark-log row under `NBA_PAUSED`, pinned line, $300-class cap when live) until a forward, price-joined n ≥ 20 replicates TOUCH ≥ +8pp; only then A-tier behavior and sizing. Never jumps straight to A.

## 7. Phases
- **Phase 0a — feasibility (no outcomes):** BDL plays coverage for 2024-25 (5 spot games across Oct 2024–Apr 2025: play counts, paint/rim fields present); `collect_regular&season=2024` row counts; `export_fine&season=2025` regression on 60 games must reproduce the committed 2025-26 states byte-for-byte.
- **Phase 0b — build + counts:** full 2024-25 export, walk-integrity pass rate, halves date, first-perception n by half / deficit band / paint band; TOUCH base table n per cell. Committed before Phase 1.
- **Phase 1 — outcomes:** H1–H3 as declared; findings + script + fires file committed; verdict first.
