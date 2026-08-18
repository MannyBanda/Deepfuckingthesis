# ELITE-ELITE — H1 / H2 / H3 FINDINGS

**Prereg:** `2026-08-15_elite_elite_PREREG.md` (6ef8bd1) + **Amendment 1** (cc1fce6, sha256 42180ee4…, committed pre-data).
**Script:** `2026-08-17_elite_elite_h1h2.mjs`. **States:** `fixtures_ee26_states.json.gz` (182 states, all raw fields per A1.3).
**Surface:** 2026 live archive, 232 finished games through Aug 17, joined to `odds_history` ML. Zero external API calls.

## ERRATUM (Aug 18 — same-session audit, Fable)

The original WHAT CHANGES section stated *"earned leads hold, hot leads hold."* **The earned half is wrong by this document's own H2 table:** earned elite leads hold **35.3%** — they fall 64.7% of the time, which is the inversion H2 exists to test. Hot leads holding (84.6%) stands. The sentence "every surviving signal says back the elite LEADER" also overreached: the EARNED cell is the single surviving trailer-side signal and the only positive-edge cell in the study (+11.8pp vs market, n=17, LOW, EXPLORATORY). The corrected mirror is stated in WHAT CHANGES below. No numbers, verdicts, or bar decisions change; the error was synthesis-layer only. Full independent recompute of all cells from the committed states file: PASS (audit in session, Aug 18).
**Population:** both teams win% ≥ .550 as-of (strict <), each ≥ 12 GP, trailer deficit 1–9, period 2–4, both sides ≥12 FGA, first-perception dedup per game × leader × bucket (selection machinery byte-faithful to `2026-08-13_fine26_extraction.mjs`).

**Yield: 182 states across 32 games.** Join rate **99.5%** (181/182), median join latency **0s** — snapshots and odds are written in the same poll cycle ~30ms apart, so this is a same-cycle join, far tighter than the ≤4-min convention the prereg allowed.

---

## INSTRUMENT VALIDATION (run before any edge was reported)

56.8% of raw ML rows have implied probabilities summing **below 1.00** — impossible for one book's two-sided market. Diagnosis: the tape stores **best price per side across 6 books** (line shopping), which produces sub-100% sums by construction. Normalization removes the sum bias; the question is whether the result is a calibrated probability.

Calibration on all-gap trailers, band 1–9, 2026 tape, 8 buckets, **n=1,410**:

| bucket | n | predicted | actual | diff |
|---|---|---|---|---|
| 1 | 177 | 6.5% | 6.2% | −0.3 |
| 2 | 177 | 13.5% | 18.1% | +4.5 |
| 3 | 177 | 21.1% | 17.5% | −3.6 |
| 4 | 177 | 28.6% | 27.7% | −0.9 |
| 5 | 177 | 37.0% | 35.0% | −2.0 |
| 6 | 177 | 46.6% | 45.2% | −1.5 |
| 7 | 177 | 56.5% | 46.9% | −9.6 |
| 8 | 171 | 71.5% | 66.7% | −4.9 |

**Mean absolute error 3.40pp, monotone throughout, pooled bias −2.3pp.** The composite is a usable probability estimate and slightly **overstates** trailer chances. **Correction to carry: every edge below is ~2.3pp pessimistic toward the trailer.** Applied where it matters; never applied to rescue a verdict.

---

## H1 — GAP ORDERING vs THE MARKET: **UNDERPOWERED, and directionally FAILED**

Bar (prereg): gap ≥ .10 beats gap < 0 by ≥10pp **AND** shows positive edge vs de-vig market. Both required. Under 40 joined states → UNDERPOWERED, not passed.

| cell | states | conv | games | joined | mkt | **edge** | power |
|---|---|---|---|---|---|---|---|
| **gap ≥ .10 [BAR CELL]** | 18 | 27.8% | 7 | 17 | 45.7% | **−16.3pp** | LOW |
| gap 0 to .10 | 47 | 46.8% | 16 | 47 | 41.3% | +5.5pp | LOW |
| gap > 0 [A1.1] | 65 | 41.5% | 23 | 64 | 42.5% | −0.3pp | LOW |
| gap < 0 | 97 | 17.5% | 24 | 97 | 31.7% | −14.2pp | MED |

**Verdict: UNDERPOWERED (n=17 joined vs the 40 bar) — H1 is NOT passed.** For the record, the two conditions split: the conversion condition is met (29.4% vs 17.5% = +11.9pp), the **edge condition fails outright** (−16.3pp, and −14pp after the instrument correction). Ordering is also **non-monotone**: the middle cell (gap 0–.10, 46.8%) outperforms the top cell (gap ≥ .10, 27.8%).

**Structural reason the cell can't be powered — this is the real finding.** Requiring both teams ≥ .550 mathematically compresses the gap: the trailer must be ≥.550 and the leader can't be below it, so large gaps are near-impossible by construction. The A1.2 staircase makes this concrete:

| tier | states | games |
|---|---|---|
| gap ≥ .05 | 46 | 18 |
| gap ≥ .10 | 18 | 7 |
| gap ≥ .15 | 4 | 2 |
| gap ≥ .20 | 3 | 1 |
| gap ≥ .25 | **0** | — |
| gap ≥ .30 | **0** | — |

**The staircase Manny asked for cannot be built in this population — it terminates at .20.** This is not a sample-size accident that a longer season fixes; it is a property of the population definition. Ordering-only per A1.2; no bars attached, and the bar stayed on the pre-registered cell.

## H2 — FUEL INVERSION: **ordering holds on a clean surface, UNDERPOWERED, stays EXPLORATORY**

Bar: within gap > 0, EARNED leads convert-against at a higher rate than TRANSIENT **AND** the earned cell beats market by ≥5pp, n ≥ 25 per cell.

| cell | states | conv | games | joined | mkt | edge | power |
|---|---|---|---|---|---|---|---|
| **EARNED lead** | 17 | 64.7% | 10 | 17 | 52.9% | **+11.8pp** | LOW |
| TRANSIENT lead | 48 | 33.3% | 20 | 47 | 38.7% | −4.7pp | LOW |

**Verdict: EARNED cell n=17 < the 25 bar → below bar, ordering only, stays EXPLORATORY regardless of direction (prereg terms).**

What it does earn: the Aug 15 exploratory inversion (EARNED 70.0% / TRANSIENT 36.8%) was generated **on the fine arena**, which the prereg therefore declared contaminated for H2. This test ran on the **2026 price-joined surface, never previously cut for elite-elite** — and the ordering reproduced (64.7 / 33.3), with the earned cell clearing the ≥5pp market condition (+11.8pp, +14pp corrected). A clean surface failing to contradict a contaminated-surface hypothesis is genuine evidence, and it is **not** promotion.

Secondary proxy, reported separately, never pooled: red-band leader eFG 15.4% (n=13, edge −17.1pp) vs non-red 49.0% (n=51, +4.0pp) — same direction (hot leaders hold in elite-elite), consistent with the eFG inversion already on the books for leaders ≥.400.

**Mechanism candidate:** in fade country a hot leader is a bad team shooting above itself → variance → fade. Between two good teams, a hot leader is a good team playing well → real → the "unsustainable heat" read inverts. The earned/transient inversion is the same mechanism read from the fuel side.

## H3 — EPISODE GEOMETRY: **executed on a SUBSTITUTED instrument (disclosed)**

**The prereg-named instrument could not deliver this.** The committed arena (`fixtures_fine_states.json.gz`) is deduped to one state per game × leader × time-bucket (verified: 12 states = 12 distinct pairs in the richest game, mean 6.5 states/game), so contiguous 30s runs are structurally absent and every "episode" measures 30s by construction. Rather than improvise a convention, H3 was re-run on the **un-deduped 2026 production snapshot tape (~26s grain)** — arguably more transfer-correct for a fire-latency question, but **not the instrument the prereg named.** Descriptive, no bar, no promotion authority.

| | elite-elite | fade country |
|---|---|---|
| episodes | 278 | 356 |
| median duration | 59s | 58s |
| p75 | 172s | 183s |
| ≤60s | 50.4% | 50.3% |
| ≤120s | 65.8% | 63.8% |
| single-snapshot | 27.0% | 30.3% |
| median max depth | 5 | 4 |
| episode trailer win | 33.8% | 59.3% |

**Read: geometry is NOT the differentiator.** Elite-elite trailing windows are essentially the same shape as fade-country windows the alert path already fires on — median ~59s, half under a minute, roughly a quarter visible in only one snapshot. The MIN@LV motivating observation (~90s windows, depth 3) is representative. **A stream here would not need a new fire-latency design; it would inherit the existing one.** The difference between the lanes is entirely in conversion (33.8% vs 59.3%), not in observability.

---

## WHAT CHANGES

**Nothing ships.** No code, no copy, no sizing, no dashboard surface — as the prereg required regardless of outcome.

**The elite-elite trailer-buy stream is NOT recommended for a proposal.** The lane fails on its own primary metric: elite-elite trailers are **overpriced by the market in nearly every cut** — pre-Q4 −7.9pp, Q4 −8.2pp, deficit 1–3 −6.1pp, 4–6 −12.2pp, 7–9 −7.0pp, and the headline bar cell −16.3pp. The instrument correction (+2.3pp) does not rescue any of them. The market reads this population at least as well as the engine does, which is the same verdict the spread lane earned in August, arrived at independently.

**The one live thread is the inversion, stated correctly (see ERRATUM).** Elite-elite trailers are overpriced in every **pooled** cut, and TRANSIENT/hot elite leads hold (66.7% / 84.6%). The single exception — the only positive-edge cell in the study — is **EARNED elite leads, which FALL 64.7% of the time and beat the market by +11.8pp** (n=17, LOW, EXPLORATORY, below its pre-registered bar). The mirror observation is therefore two-sided and conditional, not a blanket leader-buy: *back the elite leader when the lead is variance-built or hot; the earned-lead cell is the trailer's one candidate lane.* This is the H2 inversion restated from the leader's side — the same object, not a second finding. It is **POST-HOC as a betting direction** — the compression study's leader-spread mirror is the precedent, and it earned a forward-tape prereg, not a promotion. Named here and deferred; it does **not** get retro-fitted onto this prereg's bars.

**Playoff context (H4, `efcb6b3`):** playoff elite-elite conversion ran at or above regular season in every cut. That annex is price-free and does not survive contact with this one — conversion without price was half a finding, and the priced half just came back negative. The postseason question is now: is the *pricing* different in playoffs, not the conversion. Untestable until there is a priced playoff sample.

**Manny's NBA read is not contradicted.** The +750/+1000 Knicks-shape comebacks were NBA playoffs, deep deficits, long prices — a different league, a different stage, and mostly outside the 1–9 band this study covers. Nothing here speaks to it. That question is preserved under A1.3 (the states file carries every raw field needed) and remains deferred behind its own prereg.

## POWER SUMMARY

Every prereg cell landed LOW except gap<0 (MED). The population yielded 32 games in a full season. **This lane is structurally sample-starved** — not from a short tape, but because "both teams ≥.550 and one trails by 1–9" is a rare state, and the gap-compression property caps the top cells at zero. A second season would roughly double n and still leave the bar cell short of 40.

## REGENERATION

`node research/2026-08-17_elite_elite_h1h2.mjs --pull` then without flags. States committed with gap, both win%, both GP, margin, gameSec/period/bucket, leader eFG/band/3P%/POT, fuel flag + source, joined trailer ML, join latency, raw and de-vig implieds, outcome.
