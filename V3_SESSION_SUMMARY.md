# V3 Session Summary — Apr 23-24, 2026

## Dashboard (v3.html → 3,543 lines)
- **I5 runs6 fix**: live pbpSave now includes runs6/scoringEvents/_bdl; client computes from scoreLog fallback
- **I4 subA fix**: client now uses biggest_lead (75% threshold) matching server; was using scoreDiff>8 proxy
- **I4 evidence**: subA/subB verdict rows + line_score reconstructed from quarter boundaries for FINAL games
- **Analysis race fix**: shared parseRawTextV2 parser; syncAnalysesFromDB merges narrative/risk/closing into prediction; auto analysis v2 fields always merge even when client analysis has newer timestamp
- **FWP winner highlight**: fallback parses FWP percentages when fwpLabeled/edgeNum missing
- **Demo mode SHIPPED**: 3 preset games (POR@DEN +750 OT, GSW@SAC +700 comeback, MIA@CHA OT play-in), util menu dropdown, preset strip, auto score fill from DB
- **TREND row**: cumulative numbers with +/- coloring + latest-quarter direction arrow (replaces bare arrows)
- **Snapshot history defaults**: hide Peak/Eros/TP/LS/Sust by default; Show All/Hide All toggle
- **Floor team column**: shows control team alias in team color in FLOOR column
- **Live partial paint**: inject from PBP shot zones (rim+paint)*2 when player rollup has no paint
- **Edge cell overflow fix**: extract final % from calculation string instead of dumping raw text

## Infrastructure
- **Basic Auth**: _headers file with Manny + Cell, replaced JWT password protection (no 1hr timeout)
- Claude sandbox still can't reach netlify.app (domain allowlist)

## Server (poll-live-bdl.mjs)
- **V2 transition pending fix**: `_v2_transition_pending` flag holds `_prev_bwc_state` when transition gated by cooldown. Only advances when transition actually fires. Prevents silent consumption of recovery AND degrading alerts.
- **Cooldown reduced**: 3 min → 1 min (60000ms)
- **Validated by two games**:
  - CLE@TOR: 3 recovery alerts (POSITION_RECOVERING x2, POSITION_SAFE x1) silently consumed. TOR won by 25.
  - NYK@ATL: EXIT silently consumed when floor flipped to NYK. Manny manually spotted the flip and cashed NYK at +money.

## On Deck (Next Session)
- **Kill cooldown entirely?** Agent + material change gate may be sufficient. Cooldown is redundant and harmful.
- **Peak erosion → MF trend**: VALUE/BWC_EDGE transitions may benefit from MF trend instead of peak-to-current erosion. Peak erosion punishes teams for early dominance (TOR peaked 1.00 → any floor <.50 = COLLAPSE).
- **Save grad rank to snapshots**: GRAD column only shows at alert timestamps, not every snapshot
- **WNBA Phase 1**: Server LEAGUES config, DRY_RUN for preseason (tips Apr 25)
