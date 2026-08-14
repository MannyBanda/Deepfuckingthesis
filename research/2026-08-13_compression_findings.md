# FINDINGS — COMPRESSION STUDY (tightening after peak deficit)

**Date:** 2026-08-13 · **Prereg:** research/2026-08-13_compression_PREREG.md (committed 0274a57, sha256 9f4ba7d5…ad31, BEFORE data cut)
**Instruments:** historical fine walk (export_checkpoints grain=30, 576 games 2024+2025, marks Q2→end — gameSec 630+, so historical peaks are Q2-onward by instrument); 2026 production archive (253 finished games May 8–Aug 13, snapshot timelines ~26s + odds_history live-spread tape; 252/253 games carry spread rows — coverage essentially complete).
**States committed:** compression_hist_marks.json.gz (full timelines), compression_hist_rows.json (439 game-sides), compression_trig_rows_2026.json. Scripts alongside.

## VERDICTS

1. **H2 — the money question — FAILED, decisively. The thesis inverts at the tradeable moment.** Trailer + live spread at first deficit crossing: **T15 44.6% [Wilson95 36.8–52.6] n=148 (MED) · T20 39.2% [28.9–50.6] n=74 (LOW) · T25 35.7% [23.0–50.8] n=42 (LOW)** vs 52.38% breakeven (−110 assumed; tape carries points only). Zero pushes. Monotonically WORSE with depth. The T15 upper CI barely grazes breakeven; nothing is close.

2. **H0 — compression from the PEAK is real and large — which is exactly why the trade feels catchable.** Pooled hist, D_peak≥15: ~60% of sides tighten 5+ from their worst moment (2024 62.0%, 2025 58.9% — the PM's "straight blowouts are rare" is TRUE both seasons). Time-of-peak dominates everything: median C by peak bucket = Q2 9.0 / Q3e 11.0 / Q3l 10.0 / Q4e 7.0 / **Q4l 2.0 (dead)**. Depth table (pooled): P(C≥8) = 52.6 / 41.3 / 47.0 / 34.4 across 12-15 / 16-19 / 20-24 / 25+ (n=154/109/83/93). Trailer-WINS collapses with depth: 25.3 / 10.1 / 2.4 / 0.0% — wins-from-deep confirmed dead a third way (Q4_COLLAPSE 0/24 and the closing-capacity ceiling now have a base-rate map under them).

3. **The mechanism, in one line: the trigger is not the peak.** After first crossing 20, the deficit EXPANDS on average (mean post-trigger compression −2.4, i.e. finals run ~2.4 worse than the trigger margin) while the live spread at entry (avg +17.6 when down ~20) already grants ~2.7 points of expected tightening. Market expectation ~+2.7 of tightening vs reality ~−2.4 of expansion = a ~5-point miss AGAINST the trailer. The market doesn't just price the comeback — at first-crossing it OVER-prices it. The peak is only visible in the rear-view mirror; H0's big claw-backs are measured from a point you cannot identify live.

4. **2026 [this season] rider — deep blowouts are STICKIER than history, not softer.** Q2+-matched comparison: P(C≥8) at 20-24 = 25.0% (hist 47.0), at 25+ = 26.2% (hist 34.4). The PM's three exhibits (WSH from 22, POR from ~30, LA from ~20) are real events on a tape whose base rates run the other way at depth. What makes the season FEEL comeback-y is the shallow band: D_peak 12-15 converts to trailer-WINS 30.5% [this season] — the locked ML signal's home turf, not the deep-spread world.

5. **H1 — gap staircase on compression — CLEARS ITS PRE-REGISTERED BAR, hold loosely.** P(C≥10), pooled: gap≥+.15 56.0% / middle 34.7% / gap≤−.15 24.1% (n=75/150/203). Two most-populated depth buckets: 12-15 outer separation 24.8pp, 16-19 42.9pp, monotone in both seasons in both buckets → bar met as written. **Caveat from the confound audit:** gap≥.15 peaks arrive earlier (44% by Q3-early vs 21% for weak trailers) and shallower (mean D_peak 19.4 vs 23.1), and a time-controlled residual cut (peaks ≤Q3-late) keeps 2024 monotone (75.0/41.4/27.3) but flips the 2025 tail (66.7/52.0/56.7, middle<weak at n=25/30). Under the strict both-seasons standard applied to the time-controlled cut, the residual would NOT promote. Status: ordering-only, no directive use, and practically moot given verdict 1.
   - Secondary (no bars): leader wp orders compression — <.400 = 47.5% / .400-.550 = 35.9% / ≥.550 = 23.2% P(C≥10) (beatable-leader thesis extends to claw-backs). Fuel classifier SATURATES at big leads (TRANSIENT 314/332; EARNED n=18 LOW) — no read, and a note that computeFuelTemp was not designed for D_peak≥15 states.

6. **H3 — the backdoor-cover folklore does not appear as a base-rate free lunch.** Post-T20 compression decomposes live −0.9 / after-ML-pulled −1.5 (both EXPANSION on average); among covers the split is roughly even (+2.8 live / +2.6 dead). Garbage time on this tape is not reliably compressive.

7. **POST-HOC OBSERVATION — flagged as forking-paths, NOT a finding.** The mirror trade (LEADER −spread at first crossing) runs 55.4 / 60.8 / 64.3% by depth (n=148/74/42), monotone; T20/T25 point-clear the 56% bar but Wilson lower bounds do not clear breakeven, and the sign was chosen AFTER seeing the data — the prereg'd hypothesis was the trailer side. Candidate hypothesis for a future OWN prereg on FORWARD tape only: "the live market shades fresh-blowout spreads toward the comeback." Practical frictions all cut against it (laying −18/−22 live, limits, fast lines). Nothing moves without that prereg.

## WHAT CHANGES

Nothing ships. Market-edge backlog #3 gets its first empirical answer: compression is real, weakly predictable from the peak, and over-priced at the only ex-ante entry tested. Q4_COLLAPSE stays log-only, now triply confirmed. Any successor spread idea needs a genuinely new ex-ante entry hypothesis (peak-confirmation / stabilization reads) plus its own prereg — first-crossing entries are RULED OUT and join the do-not-revisit list.

## INSTRUMENT NOTES

Historical marks begin at gameSec 630 (Q2+): Q1 peaks invisible historically; the 2026 H0 comparison was restricted to Q2+ marks for like-for-like. D_peak is mark-sampled (30s hist / ~26s prod) — true inter-mark peaks slightly understate. Odds join: first spread row ts ≥ trigger, dt ≤ 240s (T15: 1/149 unjoined; T20/T25: 0). Bets-vocabulary and dedupe conventions per prereg: one row per game-side.
