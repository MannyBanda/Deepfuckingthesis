# PREREG — Windowed-MC trailer BUY at first perception (NBA)

**Date:** 2026-10-31 · **PM:** Manny · **Executor:** this session, on PM go · **Status:** PRE-REGISTERED, no arena outcome contact for this population before this commit. Attestation = this file's commit SHA.

**One line:** when the trailer's *windowed* Monte Carlo (last ~20 possessions' rates, projected to the final) first crosses .55 in the second half with the deficit at 1–9, does the trailer win more often than the scoreboard says it should?

---

## 1. Definitions (explain-it-fresh)

- **Windowed MC (`mc_win_prob` in production):** `runMonteCarloSim` fed with each team's rates over the last ~20 possessions (`extractMCRatesFromPossLog(…, 20)`, FGA ≥ 5 both sides, 500 sims, control-relative). It reads *who is outplaying whom right now*. Distinct from **MC Cum** (`mc_cum_win_prob`), which uses cumulative rates and is anchored to the score.
- **Trailer:** the team behind on the scoreboard at the state. **Deficit:** points behind.
- **Trailer-relative MC:** P(trailer wins) = sim.winProb when the sim's `ctrlTeam` is the trailer.
- **First perception:** the first 30s state in a game at which the signal condition is true. One row per game. This is the moment production would perceive it (~26s median poll grain, per the fine-arena granularity study), not a parked state.
- **Fair proxy:** 1 − (leader-holds rate) from the arena's base-rate table keyed by period × 2-min clock bucket × leader-margin bucket (`1-3 / 4-8 / 9-15 / 16+`), built over every Q2+ state of every walk-ok game — the same proxy the Oct 23 study used. **Edge = trailer-WIN − fair proxy.**
- **Power tags:** HIGH ≥ 200 · MED 80–200 · LOW < 80. Below MED: ordering only, no directive language.

## 2. Hypothesis and why it exists

**H1.** At first perception of trailer windowed MC ≥ .55 (Q3+, deficit 1–9), the trailer converts ≥ 8pp above the fair proxy, in both chronological halves of 2025-26 independently.

**Mechanism claimed.** The windowed MC sees a possession-level run before the scoreboard reflects it. The spread study found the market re-prices *confirmation* within minutes; the Oct 23 study found the *confirmed* canary moment (CLEAN pattern) is market-fair. If there is anything left, it is at first perception, before confirmation — the sampling-moment lesson applied to the entry side.

**Why it might be noise (disclosed before the cut).** The only HIGH-power measurement in this family says the canary-as-buy is fair (42.1% vs 41.9%, n=653). The motivating cut's floor split is non-monotone and inverts the one locked positive cell (§3). A +16pp at n=52 in-sample is ~2 SE from zero.

## 3. Data contact disclosure (contamination)

**Exploratory cut, Oct 31, 2026, on the 2026-27 production tape (80 games, 9,137 snapshots — `research/2026-10-31_nba_season_audit.py` lineage).** Trailer `mc_win_prob` ≥ .55, Q3+, deficit 1–9, first perception, ESPN WP as fair line:

| cell | n | trailer-WIN | ESPN fair | edge |
|---|---|---|---|---|
| all | 52 | 50% | 34% | +16pp |
| deficit 1–3 / 4–6 / 7–9 | 17 / 16 / 19 | 53 / 75 / 26% | 41 / 35 / 25% | +12 / +40 / **+1** |
| first half / second half of tape | 26 / 26 | 46 / 54% | 35 / 33% | +11 / +21 |
| trailer holds floor / leader holds | 7 / 45 | 71 / 47% | 39 / 33% | +32 / +14 |
| leader-holds, control floor < .60 / .60–.75 / > .75 | 13 / 13 / 19 | 62 / **23** / 53% | 39 / 36 / 27% | +23 / **−13** / +26 |
| MC ≥ .70 and persisted one snapshot | 20 | 40% | 31% | +9 |

These numbers set the hypothesis; they do not count toward it. The same cut showed **MC Cum** favoring a Q4 trailer in 2 of 80 games (both 1-point deficits) and leader MC Cum ≥ .80 in Q4 winning 81% vs ESPN 83% — MC Cum is a scoreboard reader late and is not a candidate.

**Arena outcome contact:** 2025-26 arena outcomes have been read for the canary population (control-team triggers, CLEAN/WAVE patterns; Oct 23). The trailer-first-perception population defined in §5 has never been cut. Base rates (§1) were read Oct 23 as counts of leader-holds; they are reused unchanged.

## 4. Prior art and conflicts (bar is set with these in mind)

- **Canary-as-buy market-fair (Oct 23, HIGH):** production-style CLEAN trailer-WIN 42.1% vs proxy 41.9%. Different moment (confirmation vs first perception); same engine. If H1 passes, the difference must be explainable by timing, and §8 H3 measures it.
- **Floor at trigger (Oct 23, HIGH):** control floor .60–.75 = 50.9% (+6.7pp) is the only positive cell; > .75 = 32.0% (−4.7pp). The motivating cut shows the opposite ordering at LOW n. Reported, not barred (§8 H4).
- **MC-vs-market divergence:** not promoted (playoff-only). Not used here.
- **NBA A-gate (Oct 19):** accurate, no edge — accuracy ≠ edge is the standing NBA rule. The primary metric here is edge vs proxy, never raw conversion.
- **Stale pregame quotes (Oct 23 prereg §8; re-found Oct 31 audit §8a):** the NBA price stamp is a live/pregame mix. No price-joined claim is made in this prereg; the ladder (§9) requires the stale-quote filter before sizing.
- **Spread lane closed:** the market re-prices within minutes — the reason first perception is the only defensible moment.

## 5. Instruments

**Instrument A (verdict source) — FINE NBA ARENA 2025-26.** `research/2026-10-23_fine_nba_states.json.gz` (1,235 games, 30s grain, walk-ok filter), replayed by a new read-only script `research/2026-10-31_mc_trailer_buy_replay.mjs` that slices `runMonteCarloSim`, `diffToRatesMC`, `estimateRemainingPossMC` from `poll-live-bdl.mjs` at runtime (the `fine_nba_canary_replay.mjs` pattern, byte-faithful by construction). Per state Q3+: window = walk back until ≥ 20 combined possessions (`estPoss`), rates via `diffToRatesMC` (box-diff), FGA ≥ 5 both sides, sim 1,000 seeded (`mulberry32(SEED + gid)`, SEED 20261031), `ctrlTeam` = trailer side. Chronological halves split **2026-01-14** (the arena's established split). Deviations from production, disclosed: box-diff window vs PBP possession-log window; league 0.36 3PT baseline vs per-team; 1,000 vs 500 sims.

**Instrument B (transfer check only) — 2026-27 production snapshots** (`mc_win_prob`, the exact production field). Contaminated by §3; reported alongside A for transfer, never as a verdict.

## 6. Population (primary stratum)

All states with `p ≥ 3`, clock ≥ 1:00 remaining in the period for Q4 states (production `MIN_REMAIN_MIN`), scoreboard deficit 1–9, window available, trailer-relative windowed MC ≥ **.55**. **First perception per game = one row per game.** A game whose first qualifying state is in Q4 is a Q4 row; Q3 vs Q4 is a reported split, not a filter.

**No threshold search.** .55 is the only threshold that can pass or fail. MC ≥ .70 is reported as a secondary row for ordering only. If the signal lives at a cut point this prereg does not expose, that is a new prereg, not an amendment.

## 7. Metrics

- **Primary:** edge = trailer-WIN − fair proxy (§1), averaged over rows; and raw trailer-WIN with n.
- **Secondary (report-only):** the same by deficit band 1–3 / 4–6 / 7–9; by period of first perception; by floor holder; by control-floor band (< .60 / .60–.75 / > .75) when the leader holds the floor; by persistence (MC ≥ .55 on the next state, 30s later, yes/no).

## 8. Hypotheses and bars (pre-declared)

- **H1 (the verdict):** edge ≥ **+8pp** over the fair proxy on the primary stratum, **and** ≥ +8pp in each chronological half independently, **and** n ≥ 40 per half, **and** the 7–9 deficit band is the *lowest*-edge band (the monotone-ish shape every trailer signal in this project has shown; a 7–9 band that leads is a red flag, not a bonus). Any clause missed → **NOT PROMOTED**.
- **H2 (persistence, report-only):** persisted vs faded first perceptions. No bar — it decides the *shape* of a forward row (whether the log should wait one state), not whether the signal exists.
- **H3 (timing reconciliation, report-only):** for games that also produce an Oct 23-style canary CLEAN on the leader, the gap in game-minutes between first perception and CLEAN, and trailer-WIN at each. This is the test of the mechanism in §2: if first perception ≈ CLEAN in time, the +16pp was noise.
- **H4 (floor reconciliation, report-only):** control-floor bands. If .60–.75 is again the inverted band at MED+, the Oct 23 cell and this one are measuring different things and the findings must say which to trust.

Power language: H1 clauses are judged at the power of their own n; any clause below MED is reported as ordering and H1 is NOT PROMOTED regardless of magnitude.

## 9. Promotion ladder (pre-committed)

- **NOT PROMOTED:** findings committed; nothing ships; the family (windowed-MC trailer entries) joins the do-not-revisit list absent a genuinely new hypothesis.
- **PASS:** a forward log row only — `MC_TRAILER_BUY`, mechanical, written through the dark-log path (`PAUSED_LOG`-compatible), carrying the pinned trailer line at fire. **Never a gate, tier or push** from this prereg.
- **Sizing confidence:** only after a forward, price-joined n ≥ 20 **and** the NBA stale-quote filter has shipped (stamp implied vs ESPN WP |Δ| > 25pp → STALE, or bookmaker `last_update` inside the game window). Without that filter the price join is fiction.

## 10. Phases

- **Phase 0 (counts only, no outcomes read):** replay coverage — games processed, window-availability share at Q3+, first-perception n by season half, by period, by deficit band, by floor holder, by control-floor band; proxy-cell n's. Committed as `…_PHASE0.md` before Phase 1. If any H1 half has n < 40, Phase 1 still runs and reports, but H1 is already NOT PROMOTED on the n clause.
- **Phase 1 (outcomes):** H1–H4 as declared. Findings committed as `…_FINDINGS.md` with the regenerable script and the fires file; verdict first.
- **Transfer check:** Instrument B rows at the same definition, reported in the findings as "transfer", with the contamination note.

## 11. What this prereg does not do

No code touches production. No threshold, deficit band, period or floor cut is searched. No price-joined edge is claimed. No sizing. The question is narrow on purpose: is there anything at the first moment the possession-level sim flips to the trailer, measured out-of-sample at HIGH power, before a single forward night is spent on it.
