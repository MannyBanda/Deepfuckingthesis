# FINDINGS — MC-favored trailer × paint control → TOUCH the lead (NBA), fresh instrument

**Prereg:** `research/2026-10-31_paint_touch_PREREG.md` (`48318f2`) · **Phase 0:** `c89e085` · **Instrument A (verdict):** FINE NBA ARENA 2024-25, `research/2026-11-13_fine_nba_states_2024.json.gz` (`a3a8a0b`; 1,234 walk-ok games, BDL vintage 2026-11-13, never cut before this run) · **Rows:** `research/2026-11-13_mc_trailer_buy_fires_2024.json.gz` · **Reader:** `research/2026-10-31_paint_touch_phases.py --phase 1` · every number regenerates.

---

## VERDICT: H1 NOT PROMOTED

**On a season nobody had looked at, the paint-control trailer touches the lead +4.9pp more often than the cell base (n=260, HIGH, 95% ±5.5) — inside its own interval of zero and below the +8pp bar in both halves (+2.7 / +7.3).** The +9.1pp that motivated the prereg was measured on the season it was found in; on fresh data the same cell is half the size and not distinguishable from noise.

**The avoid cell did not transfer either.** "Leader owns the paint by 6+ → trailer loses −8.2pp, both halves" (2025-26, HIGH) is **+1.0pp (±5.4)** on 2024-25. Both-halves agreement inside one season was not enough; the split was season-specific.

**What changes: nothing.** Per the ladder (§6), paint control joins the do-not-revisit list for trailer selection — as a selector *and* as an avoid filter. The NBA Sweet Spot port ships with no A-tier, as the spec already allows.

---

## Definitions
TOUCH = the trailer leads at any later regulation state. Cell base = TOUCH rate over all Q3+ trailer states in the same period × 2-min clock bucket × deficit bucket, built on the same instrument (min cell n 307). Edge = rate − cell base. WIN uses the leader-holds table the same way. Power: HIGH ≥ 200 · MED 80–200 · LOW < 80.

## H1 — primary stratum: windowed MC ≥ .55 at first perception · Q3+ · deficit 1–6 · paint gap ≥ +2

| | 2024-25 (verdict) | 2025-26 (transfer — the cell's origin) |
|---|---|---|
| TOUCH, all | **+4.9pp** (±5.5) n=260 HIGH · 71.9% vs 67.1% | +9.1 (±5.3) n=233 · 77.7% vs 68.6% |
| TOUCH, half 1 / half 2 | +2.7 (±7.6) / +7.3 (±7.8) | +10.4 / +8.0 |
| TOUCH, deficit 1–3 / 4–6 | +4.0 / +6.1 | +6.0 / +14.5 |
| WIN, all | +3.0 (±6.0) · 40.8% vs 37.8% | +4.8 (±6.4) |
| clauses | edge ≥ 8 all **FAIL** · H1 **FAIL** · H2 **FAIL** · n ≥ 40/half PASS | (passes its own bars — as a cell selected from 204 would) |

The transfer row is reported because the prereg said it would be; it is not evidence. A cell chosen after looking at a season will pass that season's bars; the fresh season is the test, and it fails.

## H2 — mirror avoid cell: paint ≤ −6 (deficit 1–9) → WIN

| | 2024-25 | 2025-26 |
|---|---|---|
| WIN edge, all | **+1.0** (±5.4) n=298 HIGH | −8.2 (±4.9) n=309 |
| halves | −0.6 / +2.6 | −8.4 / −7.9 |
| TOUCH on the cell | +0.6 | −5.6 |

Retracted: the Oct 31 exploratory claim that a leader owning the paint is a structural avoid. One season said yes in both halves; the next season says nothing. Season-specific.

## Report-only descriptives (2024-25 unless noted)

- **Is the MC doing anything?** Paint ≥ +2 × deficit 1–6 *without* the MC condition, first perception per game: TOUCH **+2.9 (±3.4), n=723 HIGH**; WIN +0.4 (±3.5). On 2025-26 the same cut is TOUCH +7.1 (±3.4), WIN +5.6 (±3.7), n=678. The MC condition adds ~2pp at a third of the n — it is not the carrier. **Paint control alone is a small, same-sign TOUCH tilt in both seasons (+2.9 / +7.1), below bar, and only one of the two seasons clears zero.**
- MC fires by paint band, deficit 1–6: ≤ −6 → +3.3 · −5…+1 → −0.4 · ≥ +2 → +4.9. No monotone shape on the fresh season (2025-26 had −2.1 / −1.8 / +9.1).
- Time to first lead (H1 touchers): median 3.5 game-min (p25 1.5, p75 7.0); **touched-then-lost 83/187 (44%)** — same as every trailer cell measured so far; the cash-out moment is the whole trade.
- **Cash-out EV** (buy at fire, cash at first lead at the cell-base price, else hold; 5% vig haircut; the cell base is a generous price proxy, so these are upper bounds): H1 stratum **+6.9%/unit** (n=260) vs all MC fires −3.5% (2025-26: +13.3% vs −5.1%). A positive upper bound on a cell that does not clear its bar is not a trade.

## Instrument notes carried forward
- 2024-25 arena: 1,237 games walked, 1,234 ok (vs 1,221/1,235 for 2025-26) — today's BDL plays are cleaner than the Oct 23 vintage (walked FGM |err| vs box 2 vs 33 on 58 shared games; see `a3a8a0b`). The two arenas are on different data vintages. **Open decision for the PM:** rebuild 2025-26 on today's vintage (~2 min of export) so both seasons share one substrate before any both-seasons claim is made on them.
- Halves split 2024-25 = 2025-01-19 by the equal-halves rule (617/617).
- Replay: `--states`, `--split`, `paint_gap` additive; default run byte-identical to the Oct 31 instrument.

## Mechanism (why it is fair-ish)
Paint points are a cumulative structural stat — a trailer that has out-scored the leader in the paint has been generating rim pressure all game, and the market has watched the same game. Touching the lead from 1–6 down in the second half happens two-thirds of the time for *any* trailer; a 3–5pp tilt on top of that is real-looking in sign across two seasons but is the size of a vig, not an edge. The 2025-26 avoid cell was the kind of both-halves coincidence that a 204-cell scan produces about once.

## Retractions carried by this doc
- "paint gap ≥ +2 × deficit 1–6 → TOUCH +9.1pp" — not replicated (+4.9 ±5.5). **RETRACTED as a selector.**
- "leader owns the paint ≤ −6 → trailer WIN −8.2pp, both halves" — not replicated (+1.0 ±5.4). **RETRACTED as an avoid filter.**

## Do-not-revisit (per ladder §6)
Paint control (cumulative paint-points gap, any threshold) as a trailer selector or avoid filter, with or without the windowed-MC condition, for WIN or TOUCH. The only thing that reopens it is a genuinely new hypothesis on a new instrument.
