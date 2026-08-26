# PREREG: Killer-Trailer Closing Threat
**Date:** 2026-08-22 (pre-registered before any data contact)
**Status:** LOCKED on commit. Amendments must be disclosed, dated, and committed before execution.
**Executor:** Opus runs the locked prereg; findings delivered per the standing research-presentation contract.
**Motivating exhibit (resulting-guarded):** GS@CHI 2026-08-21 — killer-flagged CHI (4 scalps), trailing, outscored GS 8-2 in the final 61s to win by 3. This exhibit motivates the question and upgrades NOTHING.

## Question
The killer flag (team win% <.450 with >=2 scalps vs elite, eval-date semantics, computeKillerFields) marks teams whose LEADS are combustible — validated leader-side (2026-07-16 addendum). That addendum explicitly left open: "the late-game channel (closing execution vs shooting) is NOT identified." This prereg asks the trailer-side version: does two-sided variance make killer teams dangerous CHASERS in short windows?

## Framing — defensive read only
Pre-declared ship target if promoted: a display-only caution kernel candidate for ssCautionLines / JUICE ("CLOSING THREAT: opponent is killer-flagged") plus exit-decision context at the window.
**OUT OF SCOPE, pre-declared:** any killer-trailer BUY stream. Buying bad-team trailers is the killed #10 shape; this prereg does not reopen it. No gate authority under any outcome. Availability-style rule applies: facts, never a percentage as authority.

## Instrument
Fine arena extended into the closing window: fresh export at 30s grain covering all of Q4 via `backtest-wnba?phase=export_checkpoints&grain=30&from=1800&to=2400`. Same 576 historical games (2024+2025), zero SR API cost. The committed matched states file stops at 2250s; the closing window is exactly what is missing, hence the fresh export. Killer flags computed AS-OF game date via fixture-pinned computeKillerFields (51/51 incl. as-of replay). Exported states file commits alongside findings so every number is regenerable.

## Population (primary cell — declared before data contact)
- Games passing through a state of: **Q4, clock <=5:00, margin 1-6** (one-to-two possessions), trailer season win% **<.450** (as-of).
- **Unit = one row per game**, first perception into the cell (fine-arena convention; no autocorrelated state-stacking).
- Split: **killer trailers** (>=2 scalps as-of) vs **no-scalp controls** (<2 scalps, same win% band). The control cell does the price-controlling the missing 2024-25 odds tape cannot.

## Hypotheses & bars
- **H1 (primary):** killer trailers WIN these games at a higher rate than no-scalp controls. STRUCTURAL bar: **>=8pp separation, n>=25 per cell, sign agreement in 2024 AND 2025 independently.** Below bar: ordering only, no directive verb, nothing ships.
- **H2 (mechanism, no promotion authority):** killer trailers' closing points skew toward variance channels (3PT share + points-off-turnovers share) vs controls. Mechanism leg only — informs copy if H1 promotes, ships nothing alone.
- **H3 (transfer, exploratory):** same cell on the 2026 live archive with ML tape joined (odds_history <=3-4min), edge vs de-vig market. No bar — n will be tiny; descriptive tag only, never pooled with H1.
- **Leader-side readout (same data, not a hypothesis):** hold rate of late small leads AGAINST killer trailers vs the 75.1% (n=338) quality-leader hold baseline. Reported as context in findings.

## Sensitivity cuts (labeled now — no best-window shopping later)
Margin 1-3 · clock <=2:00 · margin 1-9. Reported as sensitivity regardless of direction; none can substitute for the primary cell.

## Guards
- **Resulting guard:** the GS@CHI exhibit motivates and proves nothing.
- **Power honesty (pre-declared expectation):** estimated ~25-40 killer-cell games; likely LOW-to-MED. A plausible verdict is "ordering only, revisit at season close" — an underpowered null will not be dressed as a kill, and an underpowered positive will not be dressed as a finding.
- **Both-seasons rule** applies to any structural claim.
- **Retraction-grade prominence** if any promoted claim later fails.
- Power tags mandatory: HIGH 200+ / MED 80-200 / LOW <80.

## Promotion rule
H1 meets bar in full -> caution-kernel candidate spec proposed to PM (display-only), with H2 mechanism informing copy. Anything less -> findings committed, backlog item closed or re-dated, no surface changes.

---

## AMENDMENT 1 (2026-08-22, committed before execution)
**Change:** Add a pre-declared exploratory stratum: **margin 7-15**, same window (Q4 <=5:00), same trailer band (<.450), same killer vs no-scalp split, same one-row-per-game unit.
**Rules:** Reported SEPARATELY from the primary cell in every findings table. Ordering only — no promotion authority, no directive language at any n, never pooled with the 1-6 primary. If the stratum shows a surprising pattern, that is a genuinely NEW hypothesis requiring its own prereg with its own bar; it cannot be promoted from this study.
**Rationale (PM):** do not discard the high-margin games unseen. Stratification over pooling: pooling 10-15 near-dead games into the primary cell would mechanically compress killer-vs-control separation with shared zeros (closing-capacity ceiling: late runs erase single digits, not 15-25) and could fail a true H1 by dilution. Primary cell and its bar are UNCHANGED.

---

## AMENDMENT 2 (2026-08-25, committed before execution)
**Change 1 — Executor:** Fable 5 executes this prereg (PM decision, this session). The Opus-executes line in the header is superseded.

**Change 2 — Instrument recipe correction (mechanical error, no analytical change):** The Instrument section's fresh-export recipe (`export_checkpoints&grain=30&from=1800&to=2400`) is wrong as written — `from`/`to` on that phase are DATE filters (defaults `0000-01-01`/`9999-12-31`), not game-second bounds. Corrected primary surface: the committed full fine export `research/fixtures_fine_states.json.gz` (3,224 states, grain-30 walk of the same 576 games, marks emitted to 2400s, per-episode dedup — band re-entries produce new rows). Coverage verified pre-execution: 480 states at gameSec >=2100 across 405 distinct games; closing-window re-perception of previously visited bands is captured (332 instances). No fresh export is required for H1.

**Pre-declared verification gates (run and disclosed before any H1 number is cut):**
- **V1 terminal-mark check:** observed max gameSec in the committed file is 2340; the mark generator emits 2370/2400. Zero episode entries at the final two marks across 576 games must be explained (walker terminal handling vs genuine absence). If final-minute entries are censored, the censoring and its direction are disclosed in findings; the primary cell (<=5:00) is dominated by 2100-2340 either way.
- **V2 H2 instrument:** H2 (closing channel composition) needs window DELTAS — entry-state cumulative fields diffed against game finals. The reconciliation source (final snapshots / team_game_stats) is named and validated before H2 is cut; if fields do not reconcile, H2 runs on a fresh targeted walk and that walk's states file commits with findings.

**Disclosure — instrument-verification data contact (2026-08-25, this session):** verifying the surface involved loading the committed states file and counting coverage only: state counts by gameSec window, margin distribution, distinct-game counts, dedup structure. No outcome rates, no killer/control splits, no win% cuts were computed. Hypothesis surfaces remain untouched.

**Unchanged:** primary cell, unit, split, H1/H2/H3 bars, sensitivity cuts, guards, promotion rule, Amendment 1 stratum.
