# ELITE-ELITE PREREG — H4 PLAYOFF ANNEX (partial execution)

**Prereg:** 2026-08-15_elite_elite_PREREG.md (6ef8bd1). **This doc executes H4 ONLY** — H1/H2 (the 2026 price-joined market tests, the actual go/no-go) and H3 (episode geometry) remain unexecuted.
**Instrument:** fine arena, `fixtures_fine_states_matched.json.gz` (576 games, 30s grain, 750–2250s window). Descriptive surface per prereg — no promotion authority, ordering only regardless of n.
**Population:** both teams win% ≥ .550 as-of (strict-<), each ≥ 12 GP, trailer deficit 1–9.
**Stage proxy (disclosed):** playoff = date ≥ 2024-09-22 (2024) / ≥ 2025-09-14 (2025). Boundary-gap integrity check: 0 states in the dead days between season end and playoff start.

## Result (trailer-WIN rates; state-level primary, game-level alongside)

| Cut | states | conv | games | conv |
|---|---|---|---|---|
| Elite-elite pooled | 344 | 34.9% | 63 | 38.1% |
| — regular season | 248 | 33.9% | 45 | 33.3% |
| — playoffs | 96 | 37.5% | 18 | 50.0% |
| gap>0 lane pooled | 147 | 43.5% | 41 | 48.8% |
| — regular season | 113 | 41.6% | 32 | 46.9% |
| — playoffs | 34 | 50.0% | 9 | 55.6% |
| gap≥.10 (H1 pop) pooled | 62 | 45.2% | 17 | 52.9% |
| — playoffs | 7 | 57.1% | 3 | 66.7% |

Season legs: 2024 reg 28.1% (114) → 2024 playoff 34.9% (83, 15 games); 2025 reg 38.8% (134) → 2025 playoff 53.8% (13 states, 3 games — nothing).

## Ordering read (the only claim H4 permits)

**Playoff ≥ regular in every cut** — pooled, both season legs independently, the positive-gap lane, and the H1-population preview. Elite-elite comebacks do NOT die in the postseason; the direction is mildly the opposite. LOW power throughout on the playoff side (18 games pooled, 15 of them 2024 — the 2025 playoff field carried few both-≥.550 in-band states).

## Caveats

1. **No prices on this instrument.** Playoff elite-elite games are structurally tighter; the market knows. Conversion without a de-vig comparison is half a finding — H1/H2 on the 2026 price-joined archive remain the decision tests.
2. Playoff-lane annual composition differs sharply (2024-heavy). Any structural claim would need the both-seasons rule, which the 2025 leg (3 games) cannot support.
3. Nothing ships. Per prereg, the best outcome downstream is a separately-preregged WATCHLIST-class log-only stream proposal, gated on H1/H2.

## Regeneration

Population + stage-proxy + cuts as coded in this doc's tables; single-file read of the committed arena, zero API calls.
